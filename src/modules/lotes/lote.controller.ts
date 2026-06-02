import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user';
import { AnalyzeLoteDto } from './dto/analyze-lote.dto';
import { GetSaludQueryDto } from './dto/get-salud.query.dto';
import { LoteService } from './lote.service';

/**
 * Nombre del header HTTP que viaja el bbox usado para enmarcar el PNG NDVI.
 *
 * Valor: `"minLng,minLat,maxLng,maxLat"` en EPSG:4326 (orden GeoJSON),
 * en notación decimal con punto. Ej.: `"-58.42,-34.60,-58.41,-34.59"`.
 *
 * El frontend lo lee con `response.headers.get('X-NDVI-Bbox')` y lo usa
 * para posicionar el `image` source de MapLibre con las mismas coordenadas
 * que vio Sentinel — garantía de alineamiento píxel a píxel.
 */
const NDVI_BBOX_HEADER = 'X-NDVI-Bbox';

@Controller('lotes')
@UseGuards(SupabaseAuthGuard)
export class LoteController {
  constructor(private readonly loteService: LoteService) {}

  @Post('analyze')
  @HttpCode(HttpStatus.CREATED)
  analyze(@Body() dto: AnalyzeLoteDto, @CurrentUser() user: AuthenticatedUser) {
    return this.loteService.analyze(dto, user);
  }

  @Get()
  findAll(@CurrentUser('id') userId: string) {
    return this.loteService.findAllForUser(userId);
  }

  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.loteService.findOneForUser(id, userId);
  }

  /**
   * Devuelve el PNG NDVI del lote (Sentinel-2 L2A) para el rango temporal
   * indicado en query (`?from=YYYY-MM-DD&to=YYYY-MM-DD`).
   *
   * `StreamableFile` es la forma idiomática en Nest de servir binarios:
   * setea `Content-Type` desde el constructor, evita que el interceptor
   * default serialice el `Buffer` como JSON, y permite a Express manejar
   * el `Content-Length` automáticamente.
   *
   * Headers extra:
   *  - `X-NDVI-Bbox`: bbox exacto usado para enmarcar el PNG, en formato
   *    `"minLng,minLat,maxLng,maxLat"`. El frontend lo necesita para
   *    posicionar la capa MapLibre con las mismas coordenadas que vio
   *    Sentinel (evita recalcular y diverger).
   *
   * Usamos `@Res({ passthrough: true })` para acceder al `Response` de
   * Express y setear el header dinámico, pero seguimos devolviendo
   * `StreamableFile` para que Nest gestione el stream y el `Content-Length`.
   * `@Header('Cache-Control', ...)` se mantiene como header estático.
   */
  @Get(':id/salud')
  @Header('Cache-Control', 'private, max-age=300')
  async getSalud(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: GetSaludQueryDto,
    @CurrentUser('id') userId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, bbox } = await this.loteService.getSaludNDVI(
      id,
      userId,
      query,
    );

    // El bbox viaja serializado como CSV (`minLng,minLat,maxLng,maxLat`):
    // formato chico, parseable con un `split` trivial en cliente, sin
    // ambigüedad de orden (los 4 números van siempre en orden GeoJSON).
    res.setHeader(NDVI_BBOX_HEADER, bbox.join(','));

    return new StreamableFile(buffer, {
      type: 'image/png',
      disposition: `inline; filename="lote-${id}-ndvi.png"`,
    });
  }

  /**
   * Endpoint compuesto: ejecuta `getNDVI` (PNG visual) y `getNDVIStatistics`
   * (serie temporal por intervalo) en paralelo y devuelve **un único JSON**
   * para que el frontend pueda dibujar el overlay, el gráfico de evolución
   * NDVI y el score de salud en una sola roundtrip.
   *
   * Forma del payload:
   * ```ts
   * {
   *   imageBase64: string;   // PNG en base64 (sin prefijo `data:`)
   *   imageMime:   "image/png";
   *   bbox:        [minLng, minLat, maxLng, maxLat];
   *   stats:       Array<{ fecha, ndvi, healthScore, validPixels }>;
   *   healthScore: {
   *     score:            number;   // 0–100, último intervalo válido
   *     categoria:        "Alta" | "Moderada" | "Baja" | "Sin datos";
   *     totalHectareas:   number;   // área geométrica del lote
   *     ndviPromedio:     number | null;
   *     validPixels:      number;
   *     fechaReferencia:  string | null;
   *   };
   * }
   * ```
   *
   * Por qué base64 y no `StreamableFile`:
   *  - Un solo body permite atomicidad (o llega todo o nada) y deja un
   *    contrato JSON serializable para mocks/tests.
   *  - El overhead de base64 (~33%) es despreciable para PNGs de 512×512
   *    que pesan ~30–80 KB.
   *  - El frontend convierte el base64 a `Blob` y crea su `ObjectURL`
   *    igual que cuando consume `getSalud` directo — la API de MapLibre no
   *    cambia, solo cambia la fuente del Blob.
   */
  @Get(':id/salud-analisis')
  @Header('Cache-Control', 'private, max-age=300')
  async getSaludAnalisis(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: GetSaludQueryDto,
    @CurrentUser('id') userId: string,
  ) {
    const { buffer, bbox, stats, healthScore } =
      await this.loteService.getSaludAnalisis(id, userId, query);

    return {
      imageBase64: buffer.toString('base64'),
      imageMime: 'image/png',
      bbox,
      stats,
      healthScore,
    };
  }
}
