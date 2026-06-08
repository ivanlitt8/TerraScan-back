import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body de `PATCH /api/lotes/:id`. Por ahora sólo permite renombrar el lote;
 * la geometría no se edita desde acá (cambiarla implicaría reanalizar y se
 * resuelve redibujando). Mismas reglas de `nombre` que `AnalyzeLoteDto`.
 */
export class UpdateLoteDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombre!: string;
}
