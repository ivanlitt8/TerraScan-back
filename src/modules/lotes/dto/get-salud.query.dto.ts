import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Query string del endpoint `GET /lotes/:id/salud`.
 *
 * Si `from`/`to` no vienen, el service calcula un default razonable
 * (últimos 30 días). Aceptamos `YYYY-MM-DD` o ISO 8601 completo: ambos
 * los normaliza el `SentinelService` antes de mandar a la Process API.
 */
export class GetSaludQueryDto {
  @IsOptional()
  @IsISO8601({ strict: false })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: false })
  to?: string;
}
