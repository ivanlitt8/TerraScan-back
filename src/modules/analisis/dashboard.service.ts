import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { toPostgisGeometryGeoJSON } from '../../common/geojson';
import { PrismaService } from '../prisma/prisma.service';
import type {
  DashboardResponse,
  MatrizRiesgoHidricoItem,
  MonitorIncendioItem,
} from './types/dashboard.response';

/** Mínimo de eventos de inundación para considerar un lote en riesgo hídrico. */
const RIESGO_HIDRICO_MIN_EVENTOS = 1;

/** Ventana del monitor de incendios y del KPI "incendios recientes" (días). */
const INCENDIOS_RECIENTES_DIAS = 30;

/** Tope de focos por lote al consultar PostGIS (defensivo en zonas activas). */
const MAX_INCENDIOS_POR_LOTE = 50;

/** Tope de focos que el monitor expone al front (ya mergeados y ordenados). */
const MONITOR_INCENDIOS_LIMIT = 25;

/**
 * Lote con su caché GEE para el cálculo del dashboard. `analisis` es la
 * relación 1-1 opcional (`AnalisisLote`): puede no existir si el lote nunca
 * se analizó contra GEE.
 */
type LoteConAnalisis = {
  id: string;
  nombre: string;
  areaHectareas: number;
  poligonoGeoJSON: Prisma.JsonValue;
  analisis: { elevacion: number | null; eventosInundacion: number } | null;
};

/** Fila cruda de la query espacial de incendios (snake_case de Postgres). */
interface IncendioRow {
  acq_date: Date;
  acq_time: string | null;
  confidence: string | null;
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Construye el payload del dashboard del usuario usando **solo** datos
   * locales:
   *  - `Lote` + `AnalisisLote` (caché GEE) en una única query con `include`.
   *  - `incendios` (PostGIS) con `ST_Intersects` por lote, en paralelo.
   *
   * Si el usuario no tiene lotes, devuelve una estructura vacía y limpia
   * (KPIs en cero, listas vacías) — nunca 404/500.
   */
  async getDashboard(userId: string): Promise<DashboardResponse> {
    const lotes = (await this.prisma.lote.findMany({
      where: { userId },
      select: {
        id: true,
        nombre: true,
        areaHectareas: true,
        poligonoGeoJSON: true,
        analisis: { select: { elevacion: true, eventosInundacion: true } },
      },
      orderBy: { createdAt: 'desc' },
    })) as LoteConAnalisis[];

    if (lotes.length === 0) {
      return this.emptyResponse();
    }

    // ── Matriz de riesgo hídrico + KPIs derivables de la caché GEE ──────────
    const matrizRiesgoHidrico: MatrizRiesgoHidricoItem[] = lotes.map((lote) => ({
      id: lote.id,
      nombre: lote.nombre,
      areaHectareas: lote.areaHectareas,
      elevacionMedia: lote.analisis?.elevacion ?? null,
      totalEventosInundacion: lote.analisis?.eventosInundacion ?? 0,
    }));

    const totalHectareas = Number(
      lotes.reduce((sum, lote) => sum + lote.areaHectareas, 0).toFixed(2),
    );

    const lotesConRiesgoHidrico = matrizRiesgoHidrico.filter(
      (item) => item.totalEventosInundacion >= RIESGO_HIDRICO_MIN_EVENTOS,
    ).length;

    // ── Incendios recientes (PostGIS) — una query por lote, en paralelo ─────
    const cutoff = this.recentCutoff();

    const incendiosPorLote = await Promise.all(
      lotes.map((lote) => this.recentIncendiosForLote(lote, cutoff)),
    );

    const lotesConIncendiosRecientes = incendiosPorLote.filter(
      (focos) => focos.length > 0,
    ).length;

    const monitorIncendios = this.buildMonitor(incendiosPorLote);

    return {
      kpis: {
        totalLotes: lotes.length,
        totalHectareas,
        lotesConRiesgoHidrico,
        lotesConIncendiosRecientes,
      },
      matrizRiesgoHidrico,
      monitorIncendios,
    };
  }

  /**
   * Focos FIRMS de los últimos `INCENDIOS_RECIENTES_DIAS` que intersectan la
   * geometría del lote. Reusa el patrón probado de `IncendiosService`
   * (`ST_Intersects` sobre `geom` con índice GIST + `ST_GeomFromGeoJSON`).
   *
   * Resiliencia: si la geometría del lote es inválida (o la query falla por
   * cualquier motivo), se loguea y se devuelve `[]` para que **un** lote con
   * datos corruptos no tire abajo todo el dashboard.
   */
  private async recentIncendiosForLote(
    lote: LoteConAnalisis,
    cutoff: Date,
  ): Promise<MonitorIncendioItem[]> {
    let geomText: string;
    try {
      geomText = toPostgisGeometryGeoJSON(lote.poligonoGeoJSON);
    } catch (error) {
      this.logger.warn(
        `Lote ${lote.id} con geometría inválida, se omite del monitor: ${(error as Error).message}`,
      );
      return [];
    }

    try {
      const rows = await this.prisma.$queryRaw<IncendioRow[]>(
        Prisma.sql`
          SELECT acq_date, acq_time, confidence
          FROM incendios
          WHERE acq_date >= ${cutoff}
            AND ST_Intersects(
              geom,
              ST_SetSRID(ST_GeomFromGeoJSON(${geomText}), 4326)
            )
          ORDER BY acq_date DESC, id DESC
          LIMIT ${MAX_INCENDIOS_POR_LOTE}
        `,
      );

      return rows.map((row) => ({
        loteId: lote.id,
        nombreLote: lote.nombre,
        fecha: row.acq_date.toISOString().slice(0, 10),
        hora: row.acq_time,
        confianza: row.confidence,
      }));
    } catch (error) {
      this.logger.error(
        `Falló la query de incendios del lote ${lote.id}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Mergea los focos de todos los lotes, los ordena del más reciente al más
   * antiguo y recorta al tope del monitor. La fecha es `YYYY-MM-DD`, así que
   * un `localeCompare` descendente alcanza para ordenar por día.
   */
  private buildMonitor(
    incendiosPorLote: MonitorIncendioItem[][],
  ): MonitorIncendioItem[] {
    return incendiosPorLote
      .flat()
      .sort((a, b) => b.fecha.localeCompare(a.fecha))
      .slice(0, MONITOR_INCENDIOS_LIMIT);
  }

  /** Inicio (00:00:00 UTC) del día de corte: hoy menos la ventana reciente. */
  private recentCutoff(): Date {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - INCENDIOS_RECIENTES_DIAS);
    cutoff.setUTCHours(0, 0, 0, 0);
    return cutoff;
  }

  private emptyResponse(): DashboardResponse {
    return {
      kpis: {
        totalLotes: 0,
        totalHectareas: 0,
        lotesConRiesgoHidrico: 0,
        lotesConIncendiosRecientes: 0,
      },
      matrizRiesgoHidrico: [],
      monitorIncendios: [],
    };
  }
}
