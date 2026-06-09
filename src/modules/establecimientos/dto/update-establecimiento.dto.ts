import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body de `PATCH /api/establecimientos/:id`. Hoy sólo permite renombrar el
 * establecimiento; el campo es opcional para dejar margen a futuros campos
 * editables sin romper el contrato.
 */
export class UpdateEstablecimientoDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombre?: string;
}
