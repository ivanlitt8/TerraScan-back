import { createHash } from 'node:crypto';

import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { MultiPolygon, Polygon } from 'geojson';
import { normalizePolygonGeometry } from '../../common/geojson';
import {
  FUENTES_ANALIZADAS,
  GeeService,
  GeeTimeoutError,
  type FloodEvent,
} from '../gee/gee.service';
import { LoteService } from '../lotes/lote.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AnalisisLoteResponse } from './types/analisis.response';

/**
 * TTL de la caché de análisis, en días. Alto por default: los datasets que
 * consultamos (SRTM 2000, GFD 2000–2018) son estáticos, así que el verdadero
 * disparador de recálculo es el cambio de geometría (`geomHash`), no el
 * tiempo. El TTL queda como red de seguridad (e.g. si en el futuro
 * cambiamos el algoritmo o sumamos una fuente).
 */
const ANALISIS_TTL_DAYS = Number(process.env.ANALISIS_TTL_DAYS ?? 365);
const MS_PER_DAY = 86_400_000;

@Injectable()
export class AnalisisService {
  private readonly logger = new Logger(AnalisisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly loteService: LoteService,
    private readonly gee: GeeService,
  ) {}

  /**
   * Devuelve el análisis espacial del lote aplicando **cache-aside**:
   *
   *  1. Valida ownership (`LoteService.findOneForUser` → 404/403) y obtiene
   *     la geometría persistida.
   *  2. Normaliza la geometría (`Feature` → `Polygon`/`MultiPolygon`) y
   *     calcula su `geomHash`.
   *  3. Busca en DB. Si hay registro con el mismo `geomHash` y no venció el
   *     TTL → lo devuelve (sin tocar GEE). El chequeo de caché va ANTES del
   *     gate de `isReady`, así un outage de GEE no rompe lotes ya cacheados.
   *  4. Si no hay caché válida → consulta GEE (con timeout) y hace `upsert`.
   *
   * @throws {NotFoundException}        lote inexistente (404, vía LoteService).
   * @throws {ForbiddenException}       lote de otro usuario (403, vía LoteService).
   * @throws {BadRequestException}      geometría inválida (400, vía normalize).
   * @throws {ServiceUnavailableException} GEE no inicializado (503).
   * @throws {GatewayTimeoutException}  el evaluate de GEE excedió el timeout (504).
   * @throws {BadGatewayException}      GEE falló el cómputo (502).
   */
  async getAnalisisEspacial(
    loteId: string,
    userId: string,
  ): Promise<AnalisisLoteResponse> {
    const lote = await this.loteService.findOneForUser(loteId, userId);

    const geometry = normalizePolygonGeometry(lote.poligonoGeoJSON);
    const geomHash = this.hashGeometry(geometry);

    const cached = await this.prisma.analisisLote.findUnique({
      where: { loteId },
    });

    if (cached && cached.geomHash === geomHash && this.isFresh(cached.updatedAt)) {
      this.logger.log(`Cache HIT análisis lote ${loteId}`);
      return this.toResponse(cached, true);
    }

    this.logger.log(
      `Cache MISS análisis lote ${loteId} ` +
        `(${!cached ? 'sin registro' : cached.geomHash !== geomHash ? 'geometría cambió' : 'TTL vencido'}) ` +
        `→ consultando GEE`,
    );

    await this.ensureGeeReady();

    const analisis = await this.runGeeAnalisis(geometry);

    const fuentesMap = {
      srtm: FUENTES_ANALIZADAS.find((f) => f.variable === 'elevacion')?.dataset,
      gfd: FUENTES_ANALIZADAS.find((f) => f.variable === 'inundaciones')
        ?.dataset,
    };

    const inundacionesJson =
      analisis.inundaciones as unknown as Prisma.InputJsonValue;

    const saved = await this.prisma.analisisLote.upsert({
      where: { loteId },
      create: {
        loteId,
        elevacion: analisis.elevacionMedia,
        eventosInundacion: analisis.eventosInundacion,
        inundaciones: inundacionesJson,
        geomHash,
        fuentes: fuentesMap as unknown as Prisma.InputJsonValue,
      },
      update: {
        elevacion: analisis.elevacionMedia,
        eventosInundacion: analisis.eventosInundacion,
        inundaciones: inundacionesJson,
        geomHash,
        fuentes: fuentesMap as unknown as Prisma.InputJsonValue,
      },
    });

    return this.toResponse(saved, false);
  }

  /**
   * Garantiza que GEE esté listo. Si el init de boot falló, intenta una
   * reinicialización lazy (idempotente) antes de rendirse con 503 — así un
   * fallo transitorio al arranque no deja el endpoint muerto para siempre.
   */
  private async ensureGeeReady(): Promise<void> {
    if (this.gee.isReady()) return;

    try {
      await this.gee.initialize();
    } catch {
      // El error real ya se logueó en GeeService; acá sólo decidimos el 503.
    }

    if (!this.gee.isReady()) {
      throw new ServiceUnavailableException(
        'El servicio de análisis satelital (Google Earth Engine) no está disponible en este momento. Intentá de nuevo en unos minutos.',
      );
    }
  }

  /**
   * Ejecuta el análisis en GEE y traduce los errores de dominio del
   * `GeeService` a excepciones HTTP. GEE es un upstream: timeout → 504,
   * cualquier otro fallo de cómputo → 502.
   */
  private async runGeeAnalisis(geometry: Polygon | MultiPolygon) {
    try {
      return await this.gee.getAnalisisEspacial(geometry);
    } catch (error) {
      if (error instanceof GeeTimeoutError) {
        throw new GatewayTimeoutException(
          'La consulta a Google Earth Engine excedió el tiempo límite.',
        );
      }
      throw new BadGatewayException(
        `Falló la consulta a Google Earth Engine: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Hash estable de la geometría para detectar cambios. `JSON.stringify` es
   * determinístico para un mismo objeto (mismas claves, mismo orden de
   * coordenadas), así que sirve como huella: si el polígono del lote cambia,
   * cambia el hash y forzamos recálculo.
   */
  private hashGeometry(geometry: Polygon | MultiPolygon): string {
    return createHash('sha256')
      .update(JSON.stringify(geometry))
      .digest('hex');
  }

  private isFresh(updatedAt: Date): boolean {
    const ageMs = Date.now() - updatedAt.getTime();
    return ageMs < ANALISIS_TTL_DAYS * MS_PER_DAY;
  }

  private toResponse(
    row: {
      loteId: string;
      elevacion: number | null;
      eventosInundacion: number;
      inundaciones: Prisma.JsonValue | null;
      updatedAt: Date;
    },
    cacheado: boolean,
  ): AnalisisLoteResponse {
    return {
      loteId: row.loteId,
      elevacion: row.elevacion,
      eventosInundacion: row.eventosInundacion,
      inundaciones: (row.inundaciones as unknown as FloodEvent[]) ?? [],
      fuentes_analizadas: FUENTES_ANALIZADAS,
      cacheado,
      actualizadoEn: row.updatedAt.toISOString(),
    };
  }
}
