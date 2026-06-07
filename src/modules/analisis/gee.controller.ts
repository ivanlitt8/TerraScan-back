import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { AnalisisService } from './analisis.service';
import type { AnalisisLoteResponse } from './types/analisis.response';

/**
 * Endpoint de análisis espacial del lote (orquestado sobre Google Earth
 * Engine). Vive bajo `gee/analisis` por claridad de dominio en la URL, pero
 * toda la lógica (caché, persistencia, llamadas a GEE) está en
 * `AnalisisService`: este controller es un orquestador delgado.
 *
 * El archivo se ubica en `AnalisisModule` (Opción A): controller y service
 * juntos, sin dependencias circulares. `GeeService` llega vía el `GeeModule`
 * global; `LoteService`, vía `LoteModule` importado por `AnalisisModule`.
 */
@Controller('gee/analisis')
@UseGuards(SupabaseAuthGuard)
export class GeeController {
  constructor(private readonly analisisService: AnalisisService) {}

  /**
   * `GET /api/gee/analisis/:loteId`
   *
   * Devuelve el análisis espacial consolidado (elevación + inundaciones)
   * del lote, sirviéndolo de caché cuando la geometría no cambió.
   *
   * `Cache-Control: private, max-age=300` — coherente con el resto de
   * endpoints de lote; el dato cambia poquísimo (caché de servidor +
   * datasets estáticos), 5 min de cache cliente son seguros.
   */
  @Get(':loteId')
  @Header('Cache-Control', 'private, max-age=300')
  async getAnalisis(
    @Param('loteId', new ParseUUIDPipe({ version: '4' })) loteId: string,
    @CurrentUser('id') userId: string,
  ): Promise<AnalisisLoteResponse> {
    return this.analisisService.getAnalisisEspacial(loteId, userId);
  }
}
