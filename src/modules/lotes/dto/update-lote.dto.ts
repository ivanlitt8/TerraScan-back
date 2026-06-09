import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Body de `PATCH /api/lotes/:id`. Permite:
 *  - renombrar el lote (`nombre`), y
 *  - (re)asignarlo a un establecimiento (`establecimientoId`) o desagruparlo
 *    enviando `establecimientoId: null`.
 *
 * Ambos campos son opcionales; se actualiza sólo lo que venga en el body.
 * La geometría no se edita desde acá (cambiarla implicaría reanalizar).
 */
export class UpdateLoteDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombre?: string;

  /** UUID del establecimiento destino, o `null` para desagrupar el lote. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID('4')
  establecimientoId?: string | null;
}
