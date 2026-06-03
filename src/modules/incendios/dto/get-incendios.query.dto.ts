import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Query string del endpoint `GET /lotes/:id/incendios`.
 *
 * Convención de fechas:
 *  - Si `from`/`to` no vienen, el service usa un default razonable
 *    (últimos 5 años — la serie histórica de FIRMS arranca en 2012 con
 *    SNPP y 2018 con NOAA-20, así que un default amplio es útil para
 *    el caso de uso "alertas históricas del lote" sin perder data).
 *  - Aceptamos `YYYY-MM-DD` o ISO 8601 completo: el service los
 *    normaliza a inicio/fin de día UTC antes de filtrar.
 *  - Mismas reglas que `GetSaludQueryDto` (NDVI) para mantener una
 *    convención uniforme de filtros temporales en la API.
 */
export class GetIncendiosQueryDto {
  @IsOptional()
  @IsISO8601({ strict: false })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: false })
  to?: string;
}
