import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Body de `POST /api/reportes`. El `userId` NO se acepta del cliente: lo aporta
 * el JWT de Supabase (igual que en el resto de módulos) para que un usuario no
 * pueda crear reportes a nombre de otro.
 */
export class CreateReporteDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nombre!: string;

  /**
   * Snapshot del nombre del establecimiento al momento de generar el reporte.
   * Se persiste como string plano para no perder el contexto si luego el lote
   * se desasigna o el establecimiento se borra.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200)
  establecimiento?: string;

  /** Path relativo del PDF dentro del bucket privado de Supabase Storage. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  urlStorage!: string;

  /** Lote al que pertenece el reporte (opcional). */
  @IsOptional()
  @IsUUID('4')
  loteId?: string;
}
