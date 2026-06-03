import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { GetIncendiosQueryDto } from './dto/get-incendios.query.dto';
import { IncendiosService } from './incendios.service';
import type { IncendioResponse } from './types/incendio.response';

/**
 * Endpoints de incendios FIRMS sobre un lote.
 *
 * Prefijo `lotes/:id/incendios`: el listado se obtiene **siempre** en el
 * contexto de un lote del usuario. Eso permite que el `SupabaseAuthGuard`
 * resuelva el JWT y el service valide ownership antes de tocar la tabla
 * `incendios` (que es enorme y pública en términos de aislamiento — no
 * tiene `userId`).
 *
 * Si en el futuro hace falta consultar incendios sin lote (e.g. un
 * heatmap nacional, o un polígono ad-hoc dibujado pero no persistido),
 * convendría exponer un segundo endpoint `POST /incendios/query`
 * separado, no abrir este a polígonos arbitrarios.
 */
@Controller('lotes/:id/incendios')
@UseGuards(SupabaseAuthGuard)
export class IncendiosController {
  constructor(private readonly incendiosService: IncendiosService) {}

  /**
   * `GET /api/lotes/:id/incendios?from=YYYY-MM-DD&to=YYYY-MM-DD`
   *
   * Devuelve la lista de detecciones FIRMS que intersectan el polígono
   * del lote en el rango temporal indicado (default: últimos 5 años).
   *
   * Headers:
   *  - `Cache-Control: private, max-age=300` — la tabla `incendios` se
   *    actualiza poco (carga manual de archivos NASA), 5 min de cache
   *    cliente son seguros y reducen tráfico al rebotar entre tabs.
   */
  @Get()
  @Header('Cache-Control', 'private, max-age=300')
  async list(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: GetIncendiosQueryDto,
    @CurrentUser('id') userId: string,
  ): Promise<IncendioResponse[]> {
    return this.incendiosService.getIncendiosByLoteId(id, userId, query);
  }
}
