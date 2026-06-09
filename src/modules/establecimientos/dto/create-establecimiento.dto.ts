import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body de `POST /api/establecimientos`. Sólo requiere el nombre del campo;
 * el `userId` lo aporta el JWT (no se acepta desde el cliente para evitar
 * que un usuario cree establecimientos a nombre de otro).
 */
export class CreateEstablecimientoDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombre!: string;
}
