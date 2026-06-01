import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as turf from '@turf/turf';
import type { Feature, Polygon } from 'geojson';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user';
import { PrismaService } from '../prisma/prisma.service';
import {
  SentinelService,
  type Bbox,
  type TimeRange,
} from '../sentinel/sentinel.service';
import { AnalyzeLoteDto } from './dto/analyze-lote.dto';
import { GetSaludQueryDto } from './dto/get-salud.query.dto';

const SQUARE_METERS_PER_HECTARE = 10_000;
const DEFAULT_SALUD_WINDOW_DAYS = 30;

/**
 * Forma del payload binario que devuelve `getSaludNDVI`: el PNG ya
 * descargado de Sentinel + el bbox exacto que se usó para enmarcarlo.
 *
 * El controller necesita ambos valores en la misma llamada (no podemos
 * hacer dos requests separadas porque el bbox se calcula a partir del
 * polígono del lote, igual que el PNG, y queremos garantizar consistencia
 * píxel a píxel entre lo que ve el cliente y lo que Sentinel renderizó).
 */
export interface SaludNDVIResult {
  buffer: Buffer;
  bbox: Bbox;
}

@Injectable()
export class LoteService {
  private readonly logger = new Logger(LoteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sentinel: SentinelService,
  ) {}

  async analyze(dto: AnalyzeLoteDto, user: AuthenticatedUser) {
    await this.ensureUserRow(user);
    const areaHectareas = this.calcularAreaHectareas(dto.poligonoGeoJSON);

    const lote = await this.prisma.lote.create({
      data: {
        nombre: dto.nombre,
        areaHectareas,
        poligonoGeoJSON:
          dto.poligonoGeoJSON as unknown as Prisma.InputJsonValue,
        dataProcesada: {},
        user: { connect: { id: user.id } },
      },
    });

    this.logger.log(
      `Lote "${lote.nombre}" (${lote.id}, ${areaHectareas} ha) creado para usuario ${user.id}`,
    );

    return lote;
  }

  async findAllForUser(userId: string) {
    return this.prisma.lote.findMany({
      where: { userId },
      select: {
        id: true,
        nombre: true,
        areaHectareas: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOneForUser(id: string, userId: string) {
    const lote = await this.prisma.lote.findUnique({ where: { id } });

    if (!lote) {
      throw new NotFoundException(`Lote ${id} no encontrado`);
    }

    if (lote.userId !== userId) {
      // Devolvemos 403 (no 404) sólo después de confirmar que el recurso existe;
      // así no se filtra información de IDs ajenos por timing. Para responder
      // un 404 indistinguible se podría tirar `NotFoundException` también acá —
      // hoy preferimos el log explícito porque es más útil en debug.
      this.logger.warn(
        `Usuario ${userId} intentó acceder al lote ${id} de ${lote.userId}`,
      );
      throw new ForbiddenException('No tenés acceso a este lote.');
    }

    return lote;
  }

  /**
   * Devuelve un PNG NDVI del lote pedido para el rango temporal indicado
   * (defaults: últimos 30 días).
   *
   * Flujo:
   *  1. `findOneForUser` valida ownership y carga el polígono persistido.
   *  2. `turf.bbox` calcula la envolvente en EPSG:4326 a partir del GeoJSON
   *     guardado — Sentinel necesita `bbox` para definir el frame del PNG.
   *  3. `SentinelService.getNDVI` arma el payload Process API pasando además
   *     la geometría del polígono → Sentinel aplica **clipping server-side**:
   *     los píxeles fuera del polígono salen con `dataMask = 0` y el
   *     evalscript los devuelve como alpha = 0. Resultado: el PNG cubre el
   *     bbox pero solo está pintado adentro del lote — desaparece el "ruido"
   *     de calles/casas/vecinos en lotes rotados respecto al norte.
   *  4. Devolvemos tanto el `buffer` como el `bbox` que se usó. El controller
   *     reenvía el bbox al frontend (header `X-NDVI-Bbox`) para que MapLibre
   *     posicione el `image` source con **exactamente** las mismas
   *     coordenadas que enmarcan el PNG — cero desfase por divergencia de
   *     algoritmos de cálculo entre `turf.bbox` (server) y el cálculo manual
   *     del cliente.
   */
  async getSaludNDVI(
    id: string,
    userId: string,
    query: GetSaludQueryDto,
  ): Promise<SaludNDVIResult> {
    const lote = await this.findOneForUser(id, userId);

    const feature = lote.poligonoGeoJSON as unknown as Feature<Polygon>;
    const bbox = this.calcularBbox(feature);
    const timeRange = this.resolveTimeRange(query);

    this.logger.log(
      `Solicitando NDVI para lote ${lote.id} (usuario ${userId}) ` +
        `bbox=${bbox.join(',')} range=${timeRange.from}..${timeRange.to} ` +
        `(clipping geometry: ${feature.geometry.coordinates[0]?.length ?? 0} vértices)`,
    );

    const buffer = await this.sentinel.getNDVI(
      bbox,
      timeRange,
      {},
      feature.geometry,
    );

    return { buffer, bbox };
  }

  private calcularAreaHectareas(poligono: unknown): number {
    const feature = poligono as Feature<Polygon>;
    const metrosCuadrados = turf.area(feature);
    return Number((metrosCuadrados / SQUARE_METERS_PER_HECTARE).toFixed(4));
  }

  /**
   * `turf.bbox` devuelve `[minX, minY, maxX, maxY]` con `Z` opcional cuando
   * el polígono es 3D. Sentinel sólo acepta 4 valores planos en EPSG:4326,
   * así que truncamos a los primeros cuatro y los castamos a la tupla
   * tipada del `SentinelService`.
   */
  private calcularBbox(feature: Feature<Polygon>): Bbox {
    const raw = turf.bbox(feature);
    return [raw[0], raw[1], raw[2], raw[3]];
  }

  private resolveTimeRange(query: GetSaludQueryDto): TimeRange {
    const today = new Date();
    const defaultFrom = new Date(today);
    defaultFrom.setUTCDate(today.getUTCDate() - DEFAULT_SALUD_WINDOW_DAYS);

    return {
      from: query.from ?? defaultFrom.toISOString().slice(0, 10),
      to: query.to ?? today.toISOString().slice(0, 10),
    };
  }

  /**
   * Garantiza que exista una fila en `User` con el id (UUID de `auth.users` de
   * Supabase) que vino en el JWT. Es necesario porque el modelo `Lote` exige
   * la FK `userId` y nuestro `User` espejea perezosamente al de Supabase.
   *
   * El `upsert` por id es idempotente y barato: en cada request solo dispara
   * un INSERT … ON CONFLICT DO NOTHING (vía Prisma) y devuelve la fila.
   */
  private ensureUserRow(user: AuthenticatedUser) {
    return this.prisma.user.upsert({
      where: { id: user.id },
      update: {},
      create: {
        id: user.id,
        email: user.email ?? `${user.id}@supabase.local`,
      },
    });
  }
}
