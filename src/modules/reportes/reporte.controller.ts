import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user';
import { CreateReporteDto } from './dto/create-reporte.dto';
import { ReporteService } from './reporte.service';

/**
 * Centro de Descargas: historial de reportes PDF del usuario autenticado.
 * Todas las rutas exigen un JWT válido de Supabase (`SupabaseAuthGuard`).
 */
@Controller('reportes')
@UseGuards(SupabaseAuthGuard)
export class ReporteController {
  constructor(private readonly service: ReporteService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body() dto: CreateReporteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.create(dto, user);
  }

  @Get()
  findAll(@CurrentUser('id') userId: string) {
    return this.service.findAllForUser(userId);
  }

  /**
   * `GET /api/reportes/:id/download` — devuelve una URL firmada de vida corta
   * para descargar el PDF desde el bucket privado de Supabase Storage. No se
   * cachea: cada descarga pide una firma fresca.
   */
  @Get(':id/download')
  @Header('Cache-Control', 'no-store')
  getDownloadUrl(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.getSignedUrl(id, userId);
  }

  /**
   * `DELETE /api/reportes/:id` — soft delete: oculta el reporte del Centro de
   * Descargas (marca `isDeleted: true`) sin borrar la fila ni el PDF. Responde
   * `204 No Content` ante éxito.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.service.removeLogico(id, userId);
  }
}
