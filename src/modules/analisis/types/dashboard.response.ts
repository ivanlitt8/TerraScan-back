/**
 * Contrato de respuesta del endpoint agregador `GET /api/analisis/dashboard`.
 *
 * Todo se calcula **exclusivamente** con datos locales: tablas `Lote`,
 * `AnalisisLote` (caché persistida de GEE) e `incendios` (PostGIS). No se
 * dispara ninguna llamada en vivo a Google Earth Engine ni a Sentinel Hub,
 * para garantizar una respuesta en milisegundos al abrir el dashboard.
 */

/** Métricas de cabecera (tarjetas KPI) del dashboard. */
export interface DashboardKpis {
  /** Cantidad total de lotes creados por el usuario. */
  totalLotes: number;
  /** Sumatoria de `areaHectareas` de todos los lotes del usuario. */
  totalHectareas: number;
  /**
   * Lotes con al menos 1 evento de inundación registrado en su caché
   * `AnalisisLote` (`eventosInundacion >= 1`).
   */
  lotesConRiesgoHidrico: number;
  /**
   * Lotes que registran focos de calor (`incendios`) en los últimos 30 días
   * intersectando su geometría (PostGIS `ST_Intersects`).
   */
  lotesConIncendiosRecientes: number;
}

/**
 * Fila de la matriz de riesgo hídrico. Espeja la caché GEE local
 * (`AnalisisLote`). Si el lote aún no tiene análisis cacheado, `elevacionMedia`
 * llega `null` y `totalEventosInundacion` llega `0` (nunca rompe la consulta).
 */
export interface MatrizRiesgoHidricoItem {
  id: string;
  nombre: string;
  areaHectareas: number;
  /** Elevación media (m s.n.m.) desde `AnalisisLote.elevacion`, o `null`. */
  elevacionMedia: number | null;
  /** Eventos de inundación desde `AnalisisLote.eventosInundacion`, o `0`. */
  totalEventosInundacion: number;
}

/**
 * Foco de incendio simplificado para el monitor del dashboard. Omite datos
 * ultra técnicos (brillo, satélite, FRP) para no sobrecargar el front.
 */
export interface MonitorIncendioItem {
  /** Lote afectado (para deep-link al detalle). */
  loteId: string;
  /** Nombre del lote afectado. */
  nombreLote: string;
  /** Fecha de detección `YYYY-MM-DD`. */
  fecha: string;
  /** Hora de adquisición (`HHMM` de FIRMS) o `null`. */
  hora: string | null;
  /** Nivel/porcentaje de confianza (`"l"|"n"|"h"` o numérico), o `null`. */
  confianza: string | null;
}

/** Respuesta completa del dashboard agregado por usuario. */
export interface DashboardResponse {
  kpis: DashboardKpis;
  matrizRiesgoHidrico: MatrizRiesgoHidricoItem[];
  monitorIncendios: MonitorIncendioItem[];
}
