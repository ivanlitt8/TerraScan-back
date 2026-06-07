import type { FloodEvent, FuenteAnalizada } from '../../gee/gee.service';

/**
 * Respuesta del endpoint `GET /api/gee/analisis/:loteId`.
 *
 * `fuentes_analizadas` (snake_case a propósito, es contrato público) detalla
 * qué datasets se usaron y su cobertura. Es el punto de extensión: sumar una
 * fuente nueva (e.g. JRC Global Surface Water) agrega un item al array sin
 * romper el resto del shape.
 */
export interface AnalisisLoteResponse {
  loteId: string;
  /** Elevación media del lote en m s.n.m., o `null` si no hubo cobertura. */
  elevacion: number | null;
  /** Cantidad de eventos de inundación (GFD) que afectaron el lote. */
  eventosInundacion: number;
  /** Detalle de los eventos de inundación. */
  inundaciones: FloodEvent[];
  /** Datasets consultados + cobertura temporal/espacial. */
  fuentes_analizadas: FuenteAnalizada[];
  /** `true` si la respuesta salió de la caché (no se consultó GEE). */
  cacheado: boolean;
  /** ISO timestamp del último cálculo persistido. */
  actualizadoEn: string;
}
