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
 * semáforo. Se devuelve en RGB ya pintado para que el frontend pueda
 * overlayearlo directo sobre el mapa sin recolorear.
 *
 * Para una versión cruda (NDVI float por píxel, sin paleta) habría que
 * cambiar `output.bands` a 1 y emitir `[ndvi]`; útil si en el futuro se
 * quiere clasificar en cliente. Hoy preferimos pintar en server.
 */
const NDVI_EVALSCRIPT = `//VERSION=3
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

const DEFAULT_PROCESS_URL = 'https://services.sentinel-hub.com/api/v1/process';
const DEFAULT_WIDTH = 512;
const DEFAULT_HEIGHT = 512;
const DEFAULT_MAX_CLOUD_COVERAGE = 30;

@Injectable()
export class SentinelService {
  private readonly logger = new Logger(SentinelService.name);

  constructor(private readonly httpService: HttpService) {}

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
   * @throws `InternalServerErrorException` si falta `BEARER_KEY`.
   * @throws `BadGatewayException` si Sentinel responde 4xx/5xx.
   * @throws `ServiceUnavailableException` si la red falla (timeout, DNS, etc.).
   */
  async getNDVI(
    bbox: Bbox,
    timeRange: TimeRange,
    options: GetNdviOptions = {},
    geometry?: Polygon,
  ): Promise<Buffer> {
    const bearerToken = this.getBearerTokenOrThrow();
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
      evalscript: NDVI_EVALSCRIPT,
    };
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

  private getBearerTokenOrThrow(): string {
    const bearerToken = process.env.BEARER_KEY;
    if (!bearerToken) {
      this.logger.error(
        'BEARER_KEY no está definido — no se puede llamar a Sentinel Hub.',
      );
      throw new InternalServerErrorException(
        'Servidor mal configurado: falta credencial Sentinel.',
      );
    }
    return bearerToken;
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
