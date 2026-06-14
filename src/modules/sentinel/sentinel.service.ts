import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AxiosError } from 'axios';
import type { Polygon } from 'geojson';
import { firstValueFrom } from 'rxjs';

/**
 * Bounding box en EPSG:4326 (lng/lat): `[minLng, minLat, maxLng, maxLat]`.
 *
 * Es el orden estándar de GeoJSON / Sentinel Hub Process API. Coincide con el
 * resultado de `turf.bbox(feature)`.
 */
export type Bbox = [number, number, number, number];

/**
 * Rango temporal a consultar contra Sentinel-2 L2A.
 *
 * Acepta tanto `YYYY-MM-DD` como ISO 8601 con timezone. Sentinel Hub
 * normaliza ambos a UTC.
 */
export interface TimeRange {
  from: string;
  to: string;
}

export interface GetNdviOptions {
  /**
   * Tamaño de la imagen devuelta por Sentinel. Default 512×512 — ratio
   * 1:1 que rinde bien como overlay sobre el mapa sin saturar el ancho de banda.
   * Sentinel acepta hasta 2500×2500 en planes pagos.
   */
  width?: number;
  height?: number;
  /**
   * % máximo de cobertura nubosa aceptable en la mosaicación (0–100).
   * Default 30. Bajar si querés solo escenas claras (a costa de menos hits).
   */
  maxCloudCoverage?: number;
}

/**
 * Evalscript NDVI sobre Sentinel-2 (B04 = Rojo, B08 = NIR) con paleta
 * semáforo. Se devuelve en RGBA ya pintado para que el frontend pueda
 * overlayearlo directo sobre el mapa sin recolorear.
 *
 * Para una versión cruda (NDVI float por píxel, sin paleta) ver
 * `NDVI_STATISTICS_EVALSCRIPT` — ese es el que usa `/statistics` para
 * calcular medias.
 *
 * Importante: la fórmula NDVI (`(B08 - B04) / (B08 + B04)`) es **idéntica**
 * en process y statistics. La única diferencia es el output: process pinta
 * con paleta para visualizar; statistics emite el float crudo para que
 * Sentinel agregue estadísticas (mean, stDev, etc.).
 */
const NDVI_PROCESS_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: ["B04", "B08", "dataMask"],
    output: { bands: 4 }
  };
}

function evaluatePixel(sample) {
  if (sample.dataMask === 0) {
    return [0, 0, 0, 0];
  }

  const denom = sample.B08 + sample.B04;
  const ndvi = denom === 0 ? 0 : (sample.B08 - sample.B04) / denom;

  // Paleta semáforo agronómica (rojo → amarillo → verde claro → verde oscuro)
  if (ndvi < 0.0)  return [0.65, 0.65, 0.65, 1]; // gris (agua / nieve)
  if (ndvi < 0.2)  return [0.85, 0.20, 0.20, 1]; // suelo desnudo / estrés alto
  if (ndvi < 0.35) return [0.95, 0.55, 0.10, 1];
  if (ndvi < 0.5)  return [0.95, 0.85, 0.20, 1]; // vegetación moderada
  if (ndvi < 0.65) return [0.55, 0.85, 0.30, 1];
  return                [0.10, 0.55, 0.10, 1];  // vegetación vigorosa
}`;

/**
 * Umbral NDVI por debajo del cual se considera que el píxel está en
 * "estrés" (suelo desnudo, cultivo seco, agua, sombras, etc.). Cualquier
 * píxel con `NDVI > HEALTH_SCORE_NDVI_THRESHOLD` cuenta como "saludable"
 * para el cálculo del `healthScore` del lote.
 *
 * 0.3 es el corte agronómico convencional entre "suelo descubierto/estrés"
 * y "cobertura vegetal incipiente". Cambios en este valor recalibran todo
 * el score: subirlo lo hace más exigente, bajarlo más permisivo. Se
 * expone como `export const` para que tests y consumidores conozcan el
 * mismo número sin tener que parsear el evalscript.
 */
export const HEALTH_SCORE_NDVI_THRESHOLD = 0.5;

/**
 * Evalscript para `/api/v1/statistics`.
 *
 * Sentinel agrega estadísticas (`min`, `max`, `mean`, `stDev`, `sampleCount`,
 * `noDataCount`) por banda y por intervalo de agregación. Para que la API
 * sepa qué pixels excluir, el script DEBE emitir un output `dataMask` —
 * Sentinel suma sus 1s y resta los 0s del `sampleCount` antes de calcular
 * la media.
 *
 * Output `data`:
 *  - `B0` = NDVI (float crudo en [-1, 1]).
 *  - `B1` = `isHealthy` (0 o 1): vale 1 si el píxel tiene NDVI por encima
 *    de `HEALTH_SCORE_NDVI_THRESHOLD`, 0 si no. Truco clave: Sentinel
 *    calcula `mean(B1)` sobre los píxeles válidos (dataMask = 1), y eso
 *    **es directamente la fracción de área saludable** del lote en ese
 *    intervalo. `healthScore = mean(B1) * 100`. Evita pedir histogramas
 *    y mantiene la respuesta compacta.
 *  - `B2` = B08 (reflectancia NIR — útil para análisis futuros).
 *  - `B3` = B04 (reflectancia Roja — útil para análisis futuros).
 *
 * Nota: el threshold del evalscript es un literal porque Sentinel ejecuta
 * el script con `eval` y no podemos inyectar variables JS desde Node. Si
 * algún día se hace dinámico habría que generar el script con template
 * string sustituyendo el número exacto (manteniéndolo siempre en sync
 * con `HEALTH_SCORE_NDVI_THRESHOLD`).
 */
const NDVI_STATISTICS_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{
      bands: ["B04", "B08", "SCL", "dataMask"]
    }],
    output: [
      { id: "data", bands: 4, sampleType: "FLOAT32" },
      { id: "scl", sampleType: "INT8", bands: 1 },
      { id: "dataMask", bands: 1 }
    ]
  };
}

function evaluatePixel(samples) {
  const denom = samples.B08 + samples.B04;
  const ndvi = denom === 0 ? 0 : (samples.B08 - samples.B04) / denom;
  const isHealthy = ndvi > 0.3 ? 1 : 0;
  return {
    data: [ndvi, isHealthy, samples.B08, samples.B04],
    dataMask: [samples.dataMask],
    scl: [samples.SCL]
  };
}`;

const DEFAULT_PROCESS_URL = 'https://services.sentinel-hub.com/api/v1/process';
const DEFAULT_STATISTICS_URL =
  'https://services.sentinel-hub.com/api/v1/statistics';
const DEFAULT_TOKEN_URL =
  'https://services.sentinel-hub.com/auth/realms/main/protocol/openid-connect/token';

/**
 * Margen de seguridad (ms) para renovar el token antes de su expiración real.
 * Evita usar un token que vence "en vuelo" entre que lo leemos de cache y
 * Sentinel lo recibe.
 */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Vida por defecto del token (s) si Sentinel no devuelve `expires_in`. */
const DEFAULT_TOKEN_TTL_SECONDS = 3600;
const DEFAULT_WIDTH = 512;
const DEFAULT_HEIGHT = 512;
const DEFAULT_MAX_CLOUD_COVERAGE = 30;

/** ISO 8601 duration por defecto para `aggregationInterval`. */
const DEFAULT_AGGREGATION_INTERVAL = 'P10D';

/**
 * Punto de la serie temporal NDVI que sale del mapper.
 *
 *  - `fecha`: inicio del intervalo de agregación (truncado a `YYYY-MM-DD`).
 *  - `ndvi`: media del NDVI sobre los píxeles válidos del polígono.
 *  - `healthScore`: 0–100. Porcentaje del área medible del lote con NDVI
 *     por encima de `HEALTH_SCORE_NDVI_THRESHOLD`. **Sale directamente de la
 *     media de la banda `isHealthy` del evalscript** (no del `mean` NDVI),
 *     así que penaliza correctamente lotes mosaicados (mitad sano, mitad
 *     suelo desnudo) que un promedio NDVI maquillaría como "moderado".
 *  - `validPixels`: `sampleCount - noDataCount`, útil para descartar puntos
 *     donde la cobertura nubosa o el clipping dejaron muy pocas muestras
 *     y mostrar nivel de confianza en el frontend.
 */
export interface NDVIStatisticsPoint {
  fecha: string;
  ndvi: number;
  healthScore: number;
  validPixels: number;
}

export interface GetNdviStatisticsOptions {
  /**
   * Duración ISO 8601 del intervalo de agregación (`P10D`, `P1M`, etc.).
   * Default `P10D`. Más corto = más puntos pero más sensible a nubes.
   */
  aggregationInterval?: string;
  /** % máximo de cobertura nubosa por escena. Default 30. */
  maxCloudCoverage?: number;
}

/**
 * Forma cruda (parcial) de la respuesta del Statistics API. Sólo
 * declaramos lo que consumimos en `mapStatisticsResponse`; el resto
 * existe en runtime pero lo ignoramos para no acoplarnos a campos que
 * Sentinel podría ampliar.
 */
interface SentinelStatisticsBandStats {
  min?: number;
  max?: number;
  mean?: number;
  stDev?: number;
  sampleCount?: number;
  noDataCount?: number;
}

interface SentinelStatisticsBand {
  stats?: SentinelStatisticsBandStats;
}

interface SentinelStatisticsOutput {
  bands?: Record<string, SentinelStatisticsBand>;
}

interface SentinelStatisticsInterval {
  interval?: { from?: string; to?: string };
  outputs?: Record<string, SentinelStatisticsOutput>;
  error?: { type?: string; message?: string };
}

interface SentinelStatisticsResponse {
  data?: SentinelStatisticsInterval[];
  status?: string;
}

/** Respuesta del endpoint OAuth2 `client_credentials` de Sentinel Hub. */
interface SentinelTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

@Injectable()
export class SentinelService {
  private readonly logger = new Logger(SentinelService.name);

  /**
   * Token OAuth cacheado en memoria. Se reutiliza mientras siga vigente (con
   * el margen `TOKEN_REFRESH_MARGIN_MS`) para no pedir uno nuevo en cada
   * llamada a Sentinel; cuando expira, `obtenerTokenSentinel()` lo renueva
   * automáticamente.
   */
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly httpService: HttpService) {}

  /**
   * Obtiene un access token de Sentinel Hub vía OAuth2 (`client_credentials`).
   *
   * Implementa el flujo "Just-In-Time": cada llamada a Sentinel arranca
   * pidiendo (o reutilizando de cache) un token fresco, eliminando la
   * dependencia del viejo `BEARER_KEY` hardcodeado que expiraba cada 15 min.
   *
   * El body se envía `application/x-www-form-urlencoded` (`URLSearchParams`)
   * con `grant_type`, `client_id` y `client_secret` leídos del entorno.
   *
   * @returns El `access_token` vigente (de cache si no expiró, o uno nuevo).
   * @throws `InternalServerErrorException` si faltan las credenciales OAuth.
   * @throws `BadGatewayException` / `ServiceUnavailableException` si el
   *   endpoint OAuth falla (4xx/5xx o red).
   */
  async obtenerTokenSentinel(): Promise<string> {
    // Reutilizamos el token cacheado mientras siga vigente.
    if (
      this.cachedToken &&
      this.cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()
    ) {
      return this.cachedToken.value;
    }

    const clientId = process.env.SENTINEL_CLIENT_ID;
    const clientSecret = process.env.SENTINEL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      this.logger.error(
        'Faltan SENTINEL_CLIENT_ID / SENTINEL_CLIENT_SECRET — no se puede ' +
          'autenticar contra Sentinel Hub.',
      );
      throw new InternalServerErrorException(
        'Servidor mal configurado: faltan credenciales OAuth de Sentinel.',
      );
    }

    const url = process.env.SENTINEL_TOKEN_URL ?? DEFAULT_TOKEN_URL;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });

    try {
      const response = await firstValueFrom(
        this.httpService.post<SentinelTokenResponse>(url, body, {
          headers: {
            Accept: 'application/json',
          },
        }),
      );

      const token = response.data?.access_token;
      if (!token) {
        throw new Error('La respuesta OAuth no incluyó access_token.');
      }

      const ttlSeconds =
        response.data.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS;
      this.cachedToken = {
        value: token,
        expiresAt: Date.now() + ttlSeconds * 1000,
      };

      this.logger.log(
        `Token Sentinel OAuth renovado (válido ~${ttlSeconds}s).`,
      );
      return token;
    } catch (cause) {
      // Invalidamos cache: el próximo intento forzará una renovación limpia.
      this.cachedToken = null;
      throw this.translateAxiosError(cause);
    }
  }

  /**
   * Pide a Sentinel Hub Process API una imagen NDVI (PNG, RGBA) del bbox y
   * rango temporal indicados.
   *
   * Si se provee `geometry` (Polygon EPSG:4326), Sentinel aplica **clipping
   * server-side**: los píxeles fuera del polígono llegan con `dataMask === 0`
   * y el evalscript actual los devuelve como `[0,0,0,0]` (alpha = 0). El PNG
   * resultante sigue cubriendo el `bbox` (axis-aligned) — los píxeles del
   * envelope que están fuera del polígono salen transparentes en lugar de
   * pintados, eliminando el ruido visual de calles/casas/lotes vecinos cuando
   * el polígono está rotado respecto al norte.
   *
   * `bbox` siempre es requerido porque define el frame rectangular del PNG
   * (Sentinel necesita saber qué porción del CRS renderizar y a qué `width`/
   * `height` discretizarla). `geometry` solo añade la máscara opcional.
   *
   * @returns `Buffer` con el PNG ya decodificado (listo para servirlo desde
   *   un endpoint con `Content-Type: image/png`).
   *
   * @throws `InternalServerErrorException` si faltan las credenciales OAuth
   *   (`SENTINEL_CLIENT_ID` / `SENTINEL_CLIENT_SECRET`).
   * @throws `BadGatewayException` si Sentinel responde 4xx/5xx.
   * @throws `ServiceUnavailableException` si la red falla (timeout, DNS, etc.).
   */
  async getNDVI(
    bbox: Bbox,
    timeRange: TimeRange,
    options: GetNdviOptions = {},
    geometry?: Polygon,
  ): Promise<Buffer> {
    const bearerToken = await this.obtenerTokenSentinel();
    const url = process.env.SENTINEL_PROCESS_URL ?? DEFAULT_PROCESS_URL;

    const width = options.width ?? DEFAULT_WIDTH;
    const height = options.height ?? DEFAULT_HEIGHT;
    const maxCloudCoverage =
      options.maxCloudCoverage ?? DEFAULT_MAX_CLOUD_COVERAGE;

    const payload = this.buildProcessPayload({
      bbox,
      geometry,
      timeRange,
      width,
      height,
      maxCloudCoverage,
    });

    this.logger.log(
      `→ Sentinel /process bbox=${bbox.join(',')} ` +
        `${geometry ? `geometry=${geometry.coordinates[0]?.length ?? 0}v ` : ''}` +
        `range=${timeRange.from}..${timeRange.to} size=${width}x${height}`,
    );

    try {
      const response = await firstValueFrom(
        this.httpService.post<ArrayBuffer>(url, payload, {
          responseType: 'arraybuffer',
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
            Accept: 'image/png',
          },
        }),
      );

      const buffer = Buffer.from(response.data);
      this.logger.log(
        `← Sentinel /process ${response.status} ${buffer.byteLength} bytes`,
      );
      return buffer;
    } catch (cause) {
      throw this.translateAxiosError(cause);
    }
  }

  /**
   * Arma el body para `POST /api/v1/process` de Sentinel Hub.
   *
   * Combinación `bbox` + `geometry`:
   *  - `bbox` (requerido): define el envelope rectangular del PNG generado. Es
   *    lo que Sentinel discretiza en `width × height` píxeles. Sin él no
   *    sabría qué resolución espacial usar.
   *  - `geometry` (opcional): activa el clipping. Sentinel marca los píxeles
   *    fuera del polígono con `dataMask = 0`, que el evalscript usa para
   *    devolver `[0,0,0,0]` (alpha = 0). El PNG sale "recortado" al polígono.
   *
   * El CRS es el mismo para ambos (OGC:CRS84 = EPSG:4326 con orden lng/lat),
   * que es lo que devuelve `turf.bbox` y el formato canónico de GeoJSON.
   *
   * Referencia: [Sentinel Hub Process API – bounds](https://docs.sentinel-hub.com/api/latest/reference/#tag/process/operation/process).
   */
  private buildProcessPayload(input: {
    bbox: Bbox;
    geometry?: Polygon;
    timeRange: TimeRange;
    width: number;
    height: number;
    maxCloudCoverage: number;
  }) {
    const bounds: Record<string, unknown> = {
      bbox: input.bbox,
      properties: {
        crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
      },
    };

    if (input.geometry) {
      // `bounds.geometry` debe ser un objeto GeoJSON Geometry (no Feature).
      // Sentinel sólo lee `type` y `coordinates`; cualquier `properties` /
      // `bbox` extra se ignora, pero los enviamos lo más limpios posible
      // para minimizar el tamaño del payload.
      bounds.geometry = {
        type: input.geometry.type,
        coordinates: input.geometry.coordinates,
      };
    }

    return {
      input: {
        bounds,
        data: [
          {
            type: 'sentinel-2-l2a',
            dataFilter: {
              timeRange: {
                from: this.toIsoStart(input.timeRange.from),
                to: this.toIsoEnd(input.timeRange.to),
              },
              maxCloudCoverage: input.maxCloudCoverage,
              mosaickingOrder: 'leastCC',
            },
          },
        ],
      },
      output: {
        width: input.width,
        height: input.height,
        responses: [
          {
            identifier: 'default',
            format: { type: 'image/png' },
          },
        ],
      },
      evalscript: NDVI_PROCESS_EVALSCRIPT,
    };
  }

  /**
   * Pide a Sentinel Hub Statistical API una serie temporal de NDVI sobre el
   * polígono indicado, agrupada por intervalo (`P10D` por default).
   *
   * Por qué `/statistics` y no agregamos en cliente:
   *  - Statistical API resamplea, aplica `dataMask` y compone múltiples
   *    escenas Sentinel-2 dentro del intervalo en el server. Hacer eso en
   *    cliente requeriría descargar todas las escenas y reproyectarlas —
   *    típicamente cientos de MB por mes para un lote chico.
   *  - El precio en `processing units` es bajísimo comparado con `/process`
   *    porque no se devuelve imagen, solo agregados numéricos.
   *
   * Diseño deliberadamente sin `bbox` en la firma: para estadísticas usamos
   * **solo** `bounds.geometry`. El sampleCount queda restringido a los píxeles
   * dentro del polígono real del lote (no del envelope axis-aligned), así la
   * media NDVI refleja el lote, no las casas/calles vecinas.
   *
   * @returns Array ya transformado: `[{ fecha, ndvi, validPixels }]`.
   *   Vacío si Sentinel no encontró escenas en el rango (cobertura nubosa
   *   total, fechas muy recientes sin tile disponible, etc.). El caller debe
   *   tratar el vacío como "sin datos en el período", no como error.
   *
   * @throws `InternalServerErrorException` si faltan las credenciales OAuth
   *   (`SENTINEL_CLIENT_ID` / `SENTINEL_CLIENT_SECRET`).
   * @throws `BadGatewayException` si Sentinel responde 4xx/5xx.
   * @throws `ServiceUnavailableException` si la red falla.
   */
  async getNDVIStatistics(
    geometry: Polygon,
    timeRange: TimeRange,
    options: GetNdviStatisticsOptions = {},
  ): Promise<NDVIStatisticsPoint[]> {
    const bearerToken = await this.obtenerTokenSentinel();
    const url = process.env.SENTINEL_STATISTICS_URL ?? DEFAULT_STATISTICS_URL;

    const aggregationInterval =
      options.aggregationInterval ?? DEFAULT_AGGREGATION_INTERVAL;
    const maxCloudCoverage =
      options.maxCloudCoverage ?? DEFAULT_MAX_CLOUD_COVERAGE;

    const payload = this.buildStatisticsPayload({
      geometry,
      timeRange,
      aggregationInterval,
      maxCloudCoverage,
    });

    this.logger.log(
      `→ Sentinel /statistics geometry=${geometry.coordinates[0]?.length ?? 0}v ` +
        `range=${timeRange.from}..${timeRange.to} ` +
        `aggregation=${aggregationInterval}`,
    );

    try {
      const response = await firstValueFrom(
        this.httpService.post<SentinelStatisticsResponse>(url, payload, {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        }),
      );

      const stats = this.mapStatisticsResponse(response.data);
      this.logger.log(
        `← Sentinel /statistics ${response.status} ${stats.length} intervalos`,
      );
      return stats;
    } catch (cause) {
      throw this.translateAxiosError(cause);
    }
  }

  /**
   * Arma el body para `POST /api/v1/statistics`.
   *
   * Diferencias clave vs. `/process`:
   *  - `bounds` lleva **solo** `geometry` (no bbox). La grid de muestreo de
   *    Statistical API se calcula desde la geometría; pasarle el envelope
   *    sumaría píxeles fuera del lote al sampleCount.
   *  - `dataFilter.timeRange` vive **dentro de `aggregation`**, no de `data`.
   *    Es una particularidad de Statistical API distinta a Process API.
   *  - `aggregationInterval.of: "P10D"` define la duración del bucket
   *    temporal. El response trae un `interval` por cada cubo no vacío.
   *  - `width`/`height` definen la grilla de muestreo del statistics; los
   *    fijamos en 512×512 igual que `/process` para que la media se calcule
   *    sobre la misma cantidad de samples nominales.
   */
  private buildStatisticsPayload(input: {
    geometry: Polygon;
    timeRange: TimeRange;
    aggregationInterval: string;
    maxCloudCoverage: number;
  }) {
    return {
      input: {
        bounds: {
          geometry: {
            type: input.geometry.type,
            coordinates: input.geometry.coordinates,
          },
          properties: {
            crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
          },
        },
        data: [
          {
            type: 'sentinel-2-l2a',
            dataFilter: {
              maxCloudCoverage: input.maxCloudCoverage,
              mosaickingOrder: 'leastCC',
            },
          },
        ],
      },
      aggregation: {
        timeRange: {
          from: this.toIsoStart(input.timeRange.from),
          to: this.toIsoEnd(input.timeRange.to),
        },
        aggregationInterval: {
          of: input.aggregationInterval,
        },
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        evalscript: NDVI_STATISTICS_EVALSCRIPT,
      },
      calculations: {
        default: {},
      },
    };
  }

  /**
   * Transforma la respuesta cruda de `/statistics` en una serie limpia y
   * tipada que consume el frontend.
   *
   * Por cada intervalo del array `data`:
   *  - Si el intervalo tiene `error` (Sentinel marca buckets sin escenas
   *    disponibles), lo descartamos del output. Mejor un "hueco" que un
   *    punto con NDVI inventado.
   *  - Si `outputs.data.bands.B0.stats.mean` (NDVI) no es un número finito,
   *    también se descarta (puede pasar con datasets totalmente enmascarados).
   *  - `healthScore` sale de `outputs.data.bands.B1.stats.mean` (la banda
   *    `isHealthy` del evalscript), redondeado a entero 0–100. Si no
   *    estuviera disponible (evalscript viejo, respuesta degradada),
   *    caemos a un fallback heurístico basado en el NDVI medio para no
   *    romper el endpoint — pero loguemos warning porque debería estar.
   *  - La fecha se toma de `interval.from` y se trunca a `YYYY-MM-DD`. El
   *    frontend la usa como dataKey del eje X.
   */
  private mapStatisticsResponse(
    raw: SentinelStatisticsResponse | undefined,
  ): NDVIStatisticsPoint[] {
    const intervals = raw?.data ?? [];

    return intervals
      .map((bucket): NDVIStatisticsPoint | null => {
        if (bucket.error) {
          this.logger.debug(
            `Intervalo ${bucket.interval?.from ?? '?'} sin datos: ${bucket.error.type ?? 'unknown'}`,
          );
          return null;
        }

        const ndviStats = bucket.outputs?.data?.bands?.B0?.stats;
        const ndviMean = ndviStats?.mean;
        if (typeof ndviMean !== 'number' || !Number.isFinite(ndviMean)) {
          return null;
        }

        const from = bucket.interval?.from;
        if (!from) return null;

        const sampleCount = ndviStats?.sampleCount ?? 0;
        const noDataCount = ndviStats?.noDataCount ?? 0;
        const validPixels = Math.max(0, sampleCount - noDataCount);

        const healthyMean = bucket.outputs?.data?.bands?.B1?.stats?.mean;
        const healthScore =
          typeof healthyMean === 'number' && Number.isFinite(healthyMean)
            ? Math.round(this.clamp01(healthyMean) * 100)
            : this.heuristicHealthScoreFromNdvi(ndviMean);

        return {
          fecha: from.slice(0, 10),
          ndvi: Number(ndviMean.toFixed(4)),
          healthScore,
          validPixels,
        };
      })
      .filter((point): point is NDVIStatisticsPoint => point !== null);
  }

  /** Saneo defensivo: la `mean` de una banda binaria siempre cae en [0,1]. */
  private clamp01(n: number): number {
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  /**
   * Fallback heurístico cuando el evalscript no devolvió la banda
   * `isHealthy` (despliegues viejos, scripts custom, etc.). Mapea el NDVI
   * medio del intervalo a un score lineal usando el threshold de salud:
   *
   *  - NDVI ≤ threshold → 0 (todo en estrés).
   *  - NDVI ≥ 0.8 (vegetación vigorosa) → 100.
   *  - Entre medio, interpolación lineal.
   *
   * Es claramente menos preciso que `mean(isHealthy)` (penaliza menos los
   * lotes mosaicados), pero garantiza que el endpoint siga devolviendo un
   * score numérico aunque alguien rompa el script.
   */
  private heuristicHealthScoreFromNdvi(ndviMean: number): number {
    this.logger.warn(
      'Statistics sin banda isHealthy — usando fallback heurístico NDVI→score',
    );
    if (ndviMean <= HEALTH_SCORE_NDVI_THRESHOLD) return 0;
    if (ndviMean >= 0.8) return 100;
    const span = 0.8 - HEALTH_SCORE_NDVI_THRESHOLD;
    const ratio = (ndviMean - HEALTH_SCORE_NDVI_THRESHOLD) / span;
    return Math.round(ratio * 100);
  }

  /**
   * Sentinel Hub espera ISO 8601 con timezone. Si nos pasaron `YYYY-MM-DD`
   * lo expandimos al inicio del día UTC; si ya es ISO completo lo dejamos.
   */
  private toIsoStart(input: string): string {
    return /^\d{4}-\d{2}-\d{2}$/.test(input)
      ? `${input}T00:00:00Z`
      : new Date(input).toISOString();
  }

  private toIsoEnd(input: string): string {
    return /^\d{4}-\d{2}-\d{2}$/.test(input)
      ? `${input}T23:59:59Z`
      : new Date(input).toISOString();
  }

  /**
   * Traduce errores de axios a excepciones HTTP de Nest.
   *
   * Cuando `responseType: 'arraybuffer'`, el body de error de Sentinel viene
   * como buffer ilegible; lo decodificamos a UTF-8 y:
   *  1. Lo logueamos a stderr con el `Logger` de Nest (visible en la consola
   *     del backend y capturable por agregadores tipo Datadog/Pino).
   *  2. Lo adjuntamos como `Error.cause` al `BadGatewayException` para que
   *     callers internos (scripts de verificación, tests, exception filters
   *     futuros) puedan introspeccionarlo sin re-parsear logs.
   *
   * El mensaje público del exception NO incluye el body — Nest serializa el
   * `message` directo en la respuesta HTTP y queremos evitar filtrar detalles
   * de la cuenta Planet/Sentinel a clientes externos.
   */
  private translateAxiosError(cause: unknown): Error {
    if (cause instanceof AxiosError && cause.response) {
      const response = cause.response as {
        status: number;
        data: unknown;
      };
      const body = this.safeBufferToString(response.data);
      const status = response.status;
      this.logger.error(`Sentinel respondió ${status}: ${body}`);
      return new BadGatewayException(
        `Sentinel Hub respondió ${status}. Revisar credencial y/o cuota.`,
        { cause: { sentinelStatus: status, sentinelBody: body } },
      );
    }

    const message = cause instanceof Error ? cause.message : String(cause);
    this.logger.error(`Falla de red contra Sentinel: ${message}`);
    return new ServiceUnavailableException(
      'No se pudo contactar a Sentinel Hub.',
      { cause },
    );
  }

  private safeBufferToString(data: unknown): string {
    if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
      return Buffer.from(data as ArrayBuffer).toString('utf-8');
    }
    return typeof data === 'string' ? data : JSON.stringify(data);
  }
}
