import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import type { MultiPolygon, Polygon } from 'geojson';
// `import ee = require(...)` (no `import * as ee`) es deliberado: enlaza
// directo al `module.exports` vivo de la librería. EE adjunta sus
// "generated classes" (`ee.Reducer`, etc.) a ese objeto DURANTE
// `ee.initialize()`. El helper `__importStar` que genera `import * as ee`
// copia las props al momento del import, así que esas clases añadidas
// después quedarían invisibles (`ee.Reducer` → undefined).
import ee = require('@google/earthengine');

/**
 * Coordenadas de referencia para la smoke test: Plaza Moreno, La Plata
 * (Buenos Aires, Argentina). `[lng, lat]` — orden GeoJSON, que es el que
 * espera `ee.Geometry.Point`.
 *
 * La elevación real de La Plata ronda los 10–25 m s.n.m. (ciudad de
 * llanura pampeana), así que un resultado en ese orden confirma que la
 * consulta trajo datos reales del DEM y no un valor espurio.
 */
const LA_PLATA_LNG_LAT: [number, number] = [-57.9545, -34.9215];

/**
 * Asset del DEM global SRTM (resolución ~30 m). Es un `ee.Image`, no una
 * `ImageCollection`: SRTM es un mosaico único de 2000, no una serie
 * temporal. La banda de altura se llama `elevation`.
 */
const SRTM_ASSET_ID = 'USGS/SRTMGL1_003';
const SRTM_SCALE_METERS = 30;

/**
 * Global Flood Database (Tellman et al., 2021): 913 eventos de inundación
 * mapeados con MODIS entre 2000 y 2018. `ImageCollection` donde cada imagen
 * es un evento; banda `flooded` (0/1 = extensión máxima del agua).
 *
 * Limitaciones que importan para el producto:
 *  - Cobertura 2000–2018 (no hay eventos recientes).
 *  - Resolución nativa ~250 m (un lote chico cae en pocos píxeles).
 * Escalar a datos recientes implicaría sumar JRC/GSW o Sentinel-1 SAR como
 * fuentes adicionales (ver `FUENTES_ANALIZADAS`).
 */
const GFD_ASSET_ID = 'GLOBAL_FLOOD_DB/MODIS_EVENTS/V1';
const GFD_SCALE_METERS = 250;

/**
 * Timeout para el `evaluate` del análisis espacial. GEE puede colgarse
 * (cómputo server-side pesado, rate limits); sin un tope, una request del
 * cliente quedaría esperando indefinidamente. Configurable por entorno.
 */
const GEE_EVALUATE_TIMEOUT_MS = Number(
  process.env.GEE_EVALUATE_TIMEOUT_MS ?? 30_000,
);

/**
 * Descriptor de las fuentes de datos que consume `getAnalisisEspacial`.
 *
 * Es el contrato extensible que viaja al frontend como `fuentes_analizadas`:
 * agregar una fuente nueva (e.g. `JRC/GSW1_4/MONTHLY_RECURRENCE`) es sumar
 * un objeto a este array, sin romper el shape de la respuesta.
 */
export interface FuenteAnalizada {
  dataset: string;
  variable: 'elevacion' | 'inundaciones';
  periodoCobertura: string;
  resolucionMetros: number;
}

export const FUENTES_ANALIZADAS: FuenteAnalizada[] = [
  {
    dataset: SRTM_ASSET_ID,
    variable: 'elevacion',
    periodoCobertura: '2000',
    resolucionMetros: SRTM_SCALE_METERS,
  },
  {
    dataset: GFD_ASSET_ID,
    variable: 'inundaciones',
    periodoCobertura: '2000-2018',
    resolucionMetros: GFD_SCALE_METERS,
  },
];

/**
 * Un evento de inundación que afectó al lote (derivado del GFD).
 */
export interface FloodEvent {
  /** Fecha de inicio `YYYY-MM-DD` (UTC) o `null` si el asset no la trae. */
  began: string | null;
  /** Fecha de fin `YYYY-MM-DD` (UTC) o `null`. */
  ended: string | null;
  /** Días entre inicio y fin, o `null` si falta alguna fecha. */
  duracionDias: number | null;
  /** ID original del Dartmouth Flood Observatory, o `null`. */
  dfoId: number | null;
}

/**
 * Resultado del análisis espacial consolidado (un solo `evaluate`).
 */
export interface GeeAnalisisEspacial {
  /** Elevación media del lote en m s.n.m., o `null` si no hubo cobertura. */
  elevacionMedia: number | null;
  /** Cantidad de eventos GFD que tocaron el lote. */
  eventosInundacion: number;
  /** Detalle de esos eventos (ordenado como los devuelve GEE). */
  inundaciones: FloodEvent[];
  /** Fuentes usadas (para `fuentes_analizadas`). */
  fuentes: FuenteAnalizada[];
}

/**
 * Resultado de la prueba de humo contra GEE.
 */
export interface GeeSmokeTestResult {
  /** Elevación en metros s.n.m. del punto consultado. */
  elevacion: number;
  /** Punto consultado (`[lng, lat]`). */
  punto: [number, number];
  /** Asset DEM usado. */
  asset: string;
}

/**
 * GEE devolvió un error de cómputo (asset inválido, geometría rota,
 * permiso denegado, etc.). El borde HTTP lo mapea a 502 Bad Gateway.
 */
export class GeeQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeeQueryError';
  }
}

/**
 * El `evaluate` excedió el timeout configurado. El borde HTTP lo mapea a
 * 504 Gateway Timeout.
 */
export class GeeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeeTimeoutError';
  }
}

/**
 * Wrapper sobre el cliente JS de Google Earth Engine.
 *
 * Responsabilidades:
 *  1. Autenticar el backend contra GEE con la private key del Service
 *     Account (flujo no interactivo, apto para server).
 *  2. Exponer un flag de "listo" para que los consumidores (controllers,
 *     otros services) sepan si el túnel está abierto antes de operar.
 *  3. Ofrecer una smoke test (`probarConexion`) que valida end-to-end que
 *     podemos resolver un valor computado server-side.
 *
 * Por qué un singleton con estado `ready`: `ee` es un módulo global con
 * estado interno (el token y la config viven en el módulo, no en una
 * instancia). Inicializarlo una sola vez al boot y compartirlo es el
 * patrón correcto — múltiples `authenticateViaPrivateKey` concurrentes
 * pisarían el mismo estado global.
 */
@Injectable()
export class GeeService {
  private readonly logger = new Logger(GeeService.name);
  private ready = false;
  private initPromise: Promise<void> | null = null;

  /** `true` si la autenticación + `ee.initialize` terminaron OK. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Autentica e inicializa el cliente GEE. Idempotente y seguro ante
   * llamadas concurrentes: si ya hay una init en curso, devuelve la misma
   * promesa en vez de disparar una segunda autenticación (que pisaría el
   * estado global de `ee`).
   *
   * Lee la private key desde el archivo apuntado por
   * `GEE_SERVICE_ACCOUNT_PATH` (default `secrets/google-key.json`). Se lee
   * en runtime con `fs` (en vez de `import`) para: a) no bundlear el
   * secreto en `dist/`, b) permitir rotarlo sin recompilar, c) mantener la
   * ruta configurable por entorno.
   */
  async initialize(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize();
    try {
      await this.initPromise;
    } finally {
      // Si falló, limpiamos la promesa para permitir un reintento futuro.
      if (!this.ready) this.initPromise = null;
    }
  }

  private async doInitialize(): Promise<void> {
    const privateKey = await this.loadPrivateKey();

    this.logger.log(
      `Autenticando contra Google Earth Engine como ${privateKey.client_email}`,
    );

    await new Promise<void>((resolvePromise, rejectPromise) => {
      ee.data.authenticateViaPrivateKey(
        privateKey,
        () => resolvePromise(),
        (message) =>
          rejectPromise(
            new Error(`Fallo de autenticación con la private key: ${message}`),
          ),
      );
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      ee.initialize(
        null,
        null,
        () => resolvePromise(),
        (message) =>
          rejectPromise(new Error(`Fallo en ee.initialize: ${message}`)),
      );
    });

    this.ready = true;
    this.logger.log('Conexión con Google Earth Engine inicializada');
  }

  /**
   * Prueba de humo: consulta la elevación SRTM en un punto cercano a
   * La Plata. Si devuelve un número, el túnel backend ↔ GEE está abierto
   * (auth válida, proyecto habilitado, cómputo server-side resoluble).
   *
   * Lanza si el cliente no está inicializado o si GEE devuelve error /
   * un valor no numérico.
   */
  async probarConexion(): Promise<GeeSmokeTestResult> {
    if (!this.ready) {
      throw new Error(
        'GEE no está inicializado. Llamá a initialize() antes de probarConexion().',
      );
    }

    const punto = ee.Geometry.Point(LA_PLATA_LNG_LAT);
    const dem = ee.Image(SRTM_ASSET_ID);

    // `reduceRegion` + `Reducer.first()` toma el valor del píxel del DEM
    // que contiene el punto. Sobre una geometría puntual devuelve un dict
    // `{ elevation: <metros> }`. Es más robusto que `sample().first()`
    // porque no depende de que haya features muestreables.
    const elevationObj = dem
      .reduceRegion({
        reducer: ee.Reducer.first(),
        geometry: punto,
        scale: SRTM_SCALE_METERS,
      })
      .get('elevation');

    const raw = await this.evaluate(elevationObj);

    const elevacion = Number(raw);
    if (!Number.isFinite(elevacion)) {
      throw new Error(
        `GEE devolvió una elevación no numérica para ${JSON.stringify(
          LA_PLATA_LNG_LAT,
        )}: ${JSON.stringify(raw)}`,
      );
    }

    this.logger.log(
      `Smoke test OK · elevación en La Plata ${LA_PLATA_LNG_LAT.join(', ')} = ${elevacion} m s.n.m.`,
    );

    return { elevacion, punto: LA_PLATA_LNG_LAT, asset: SRTM_ASSET_ID };
  }

  /**
   * Análisis espacial consolidado del lote: elevación media (SRTM) +
   * historial de inundaciones (GFD), resueltos en **un solo `evaluate()`**.
   *
   * Por qué un solo `evaluate`: cada `evaluate` es un roundtrip HTTP a los
   * servidores de Google. Componer todo en un `ee.Dictionary` y traerlo de
   * una reduce latencia y consumo de cuota. Toda la composición `ee.*` vive
   * acá (no en `AnalisisService`) para mantener el SDK encapsulado.
   *
   * @param geometry Geometría **plana** del lote (`Polygon`/`MultiPolygon`),
   *   ya normalizada por el caller (`normalizePolygonGeometry`). NO un
   *   `Feature` envolvente — `ee.Geometry` lo rechazaría.
   *
   * @throws {GeeQueryError}   si GEE devuelve un error de cómputo.
   * @throws {GeeTimeoutError} si el `evaluate` excede el timeout.
   */
  async getAnalisisEspacial(
    geometry: Polygon | MultiPolygon,
  ): Promise<GeeAnalisisEspacial> {
    if (!this.ready) {
      throw new GeeQueryError(
        'GEE no está inicializado. Llamá a initialize() antes de operar.',
      );
    }

    const region = ee.Geometry(geometry);

    // Elevación media del lote (no de un punto): reducer mean sobre SRTM.
    const elevacionObj = ee
      .Image(SRTM_ASSET_ID)
      .reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: region,
        scale: SRTM_SCALE_METERS,
        maxPixels: 1e9,
        bestEffort: true,
      })
      .get('elevation');

    // Eventos GFD que tocaron el lote. `filterBounds` corta por footprint
    // (barato), y luego por cada evento candidato `reduceRegion(max)` sobre
    // la banda `flooded` confirma si hubo agua DENTRO del polígono (no sólo
    // en el tile). Nos quedamos con los que dieron 1.
    const eventos = ee
      .ImageCollection(GFD_ASSET_ID)
      .filterBounds(region)
      .map((img) => {
        const tocado = img
          .select('flooded')
          .reduceRegion({
            reducer: ee.Reducer.max(),
            geometry: region,
            scale: GFD_SCALE_METERS,
            maxPixels: 1e9,
            bestEffort: true,
          })
          .get('flooded');
        return img.set('lote_flooded', tocado);
      })
      .filter(ee.Filter.eq('lote_flooded', 1));

    // Un único dict con todo. Las fechas vienen como epoch ms (propiedades
    // estándar `system:time_*`); las zipeamos en JS para no inflar la query.
    const payload = ee.Dictionary({
      elevacionMedia: elevacionObj,
      eventosInundacion: eventos.size(),
      fechasInicio: eventos.aggregate_array('system:time_start'),
      fechasFin: eventos.aggregate_array('system:time_end'),
      dfoIds: eventos.aggregate_array('id'),
    });

    const raw = (await this.evaluateWithTimeout(
      payload,
      GEE_EVALUATE_TIMEOUT_MS,
    )) as {
      elevacionMedia: number | null;
      eventosInundacion: number;
      fechasInicio: Array<number | null>;
      fechasFin: Array<number | null>;
      dfoIds: Array<number | string | null>;
    };

    const elevacionNum = Number(raw.elevacionMedia);
    const elevacionMedia = Number.isFinite(elevacionNum)
      ? Math.round(elevacionNum * 100) / 100
      : null;

    const inicio = raw.fechasInicio ?? [];
    const fin = raw.fechasFin ?? [];
    const ids = raw.dfoIds ?? [];

    const inundaciones: FloodEvent[] = inicio.map((startMs, i) => {
      const endMs = fin[i] ?? null;
      const dfoRaw = ids[i] ?? null;
      const dfoNum = dfoRaw != null ? Number(dfoRaw) : NaN;
      return {
        began: this.epochToDay(startMs),
        ended: this.epochToDay(endMs),
        duracionDias:
          startMs != null && endMs != null
            ? Math.max(0, Math.round((endMs - startMs) / 86_400_000))
            : null,
        dfoId: Number.isFinite(dfoNum) ? dfoNum : null,
      };
    });

    this.logger.log(
      `Análisis espacial OK · elevación media ${elevacionMedia ?? 'N/D'} m, ` +
        `${raw.eventosInundacion} eventos de inundación (GFD)`,
    );

    return {
      elevacionMedia,
      eventosInundacion: Number(raw.eventosInundacion) || 0,
      inundaciones,
      fuentes: FUENTES_ANALIZADAS,
    };
  }

  /** Epoch ms → `YYYY-MM-DD` (UTC), o `null` si el input es nulo. */
  private epochToDay(ms: number | null): string | null {
    if (ms == null || !Number.isFinite(ms)) return null;
    return new Date(ms).toISOString().slice(0, 10);
  }

  /**
   * Adapta el `evaluate` basado en callbacks de GEE a una promesa.
   * `evaluate` resuelve el cómputo server-side de forma asíncrona sin
   * bloquear el event loop (a diferencia de `getInfo`, que es sincrónico
   * y nunca debe usarse en un server).
   */
  private evaluate(obj: ee.ComputedObject): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      obj.evaluate((result, error) => {
        if (error) {
          rejectPromise(new GeeQueryError(`ee.evaluate falló: ${error}`));
          return;
        }
        resolvePromise(result);
      });
    });
  }

  /**
   * `evaluate` con timeout. GEE no expone cancelación del request subyacente,
   * así que el timer sólo deja de esperar la respuesta (la conexión queda a
   * cargo del runtime), pero evita que un cómputo colgado bloquee al cliente
   * indefinidamente. Resuelve la primera entre respuesta y timeout.
   */
  private evaluateWithTimeout(
    obj: ee.ComputedObject,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectPromise(
          new GeeTimeoutError(
            `ee.evaluate excedió el timeout de ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);

      obj.evaluate((result, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          rejectPromise(new GeeQueryError(`ee.evaluate falló: ${error}`));
          return;
        }
        resolvePromise(result);
      });
    });
  }

  private async loadPrivateKey(): Promise<ee.EEPrivateKey> {
    const configured =
      process.env.GEE_SERVICE_ACCOUNT_PATH ?? 'secrets/google-key.json';
    const keyPath = isAbsolute(configured)
      ? configured
      : resolve(process.cwd(), configured);

    let raw: string;
    try {
      raw = await readFile(keyPath, 'utf8');
    } catch (cause) {
      throw new Error(
        `No se pudo leer la private key de GEE en "${keyPath}". ` +
          `Configurá GEE_SERVICE_ACCOUNT_PATH o colocá el archivo en secrets/google-key.json. ` +
          `Causa: ${(cause as Error).message}`,
      );
    }

    let parsed: ee.EEPrivateKey;
    try {
      parsed = JSON.parse(raw) as ee.EEPrivateKey;
    } catch (cause) {
      throw new Error(
        `La private key de GEE en "${keyPath}" no es un JSON válido: ${(cause as Error).message}`,
      );
    }

    if (!parsed.private_key || !parsed.client_email) {
      throw new Error(
        `La private key de GEE en "${keyPath}" no tiene "private_key" y/o "client_email".`,
      );
    }

    return parsed;
  }
}
