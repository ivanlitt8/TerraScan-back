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
  type NDVIStatisticsPoint,
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

/**
 * Categoría textual del `healthScore` para mostrar como label en el panel.
 * Los cortes coinciden con los que el frontend ya usa para el color
 * (`getScoreTheme` en `DashboardLote`), así backend y UI hablan el mismo
 * idioma sin tener que sincronizar números mágicos.
 */
export type HealthScoreCategoria = 'Alta' | 'Moderada' | 'Baja' | 'Sin datos';

/**
 * Resumen del estado de salud del lote para el momento más reciente con
 * datos disponibles. Se calcula a partir de la serie estadística completa
 * (`stats`) pero expone sólo las métricas que la UI necesita para pintar
 * el bloque "Score de salud histórica" sin tener que recorrer el array.
 */
export interface HealthScoreSummary {
  /**
   * 0–100. Porcentaje del área medible del lote con NDVI por encima del
   * umbral de salud. Tomado del último intervalo válido de la serie
   * (el "ahora" del lote según Sentinel).
   */
  score: number;
  /** Etiqueta agronómica derivada de `score`. */
  categoria: HealthScoreCategoria;
  /** Hectáreas calculadas con Turf sobre el polígono del lote. */
  totalHectareas: number;
  /**
   * NDVI medio del lote en el intervalo de referencia. Contexto numérico
   * que complementa al score (el score es "qué porción está sana", el
   * NDVI medio es "qué tan sana en promedio").
   */
  ndviPromedio: number | null;
  /**
   * Píxeles válidos del último intervalo (`sampleCount - noDataCount`).
   * Si es muy bajo respecto al `sampleCount` total, hay mucha nube/sombra
   * y el score debe interpretarse con cautela; el frontend lo puede usar
   * para mostrar un disclaimer.
   */
  validPixels: number;
  /**
   * Fecha del intervalo de referencia (`YYYY-MM-DD`). `null` si no hubo
   * ningún intervalo válido (cobertura total de nubes, fechas sin tile, etc.).
   */
  fechaReferencia: string | null;
}

/**
 * Resultado del endpoint compuesto `GET /api/lotes/:id/salud-analisis`:
 * agrupa el PNG NDVI (visual), la serie temporal estadística (numérica)
 * y el resumen de score (agronómico) de Sentinel Hub para que el dashboard
 * pueda pintarse en una sola request.
 */
export interface SaludAnalisisResult {
  buffer: Buffer;
  bbox: Bbox;
  stats: NDVIStatisticsPoint[];
  healthScore: HealthScoreSummary;
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

    // Si se pide asignar a un establecimiento, validamos que sea del usuario
    // antes de crear (evita que el lote nazca asociado a un campo ajeno).
    if (dto.establecimientoId) {
      await this.assertEstablecimientoOwnership(dto.establecimientoId, user.id);
    }

    const lote = await this.prisma.lote.create({
      data: {
        nombre: dto.nombre,
        areaHectareas,
        poligonoGeoJSON:
          dto.poligonoGeoJSON as unknown as Prisma.InputJsonValue,
        dataProcesada: {},
        user: { connect: { id: user.id } },
        ...(dto.establecimientoId
          ? { establecimiento: { connect: { id: dto.establecimientoId } } }
          : {}),
      },
    });

    this.logger.log(
      `Lote "${lote.nombre}" (${lote.id}, ${areaHectareas} ha) creado para usuario ${user.id}`,
    );

    return lote;
  }

  /**
   * Lista los lotes del usuario. Si se pasa `establecimientoId`, filtra sólo
   * los lotes de ese establecimiento (las tarjetas de la subruta de campo).
   */
  async findAllForUser(userId: string, establecimientoId?: string) {
    return this.prisma.lote.findMany({
      where: {
        userId,
        ...(establecimientoId ? { establecimientoId } : {}),
      },
      select: {
        id: true,
        nombre: true,
        areaHectareas: true,
        createdAt: true,
        establecimientoId: true,
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
   * Actualiza un lote validando ownership: renombre y/o (re)asignación a un
   * establecimiento. Devuelve el registro actualizado para que el frontend
   * refresque su estado sin volver a pedir el detalle.
   *
   * Reglas:
   *  - Sólo se modifican los campos presentes en `data` (patch parcial).
   *  - `establecimientoId` con UUID → valida que ese establecimiento exista
   *    y pertenezca al mismo usuario (no se puede asignar a campos ajenos).
   *  - `establecimientoId: null` → desagrupa el lote.
   */
  async update(
    id: string,
    userId: string,
    data: { nombre?: string; establecimientoId?: string | null },
  ) {
    await this.findOneForUser(id, userId);

    if (typeof data.establecimientoId === 'string') {
      await this.assertEstablecimientoOwnership(data.establecimientoId, userId);
    }

    const lote = await this.prisma.lote.update({
      where: { id },
      data: {
        ...(data.nombre !== undefined ? { nombre: data.nombre } : {}),
        ...(data.establecimientoId !== undefined
          ? { establecimientoId: data.establecimientoId }
          : {}),
      },
    });

    this.logger.log(`Lote ${id} actualizado por usuario ${userId}`);

    return lote;
  }

  /** Valida que un establecimiento exista y sea del usuario antes de asignarlo. */
  private async assertEstablecimientoOwnership(
    establecimientoId: string,
    userId: string,
  ): Promise<void> {
    const establecimiento = await this.prisma.establecimiento.findUnique({
      where: { id: establecimientoId },
      select: { userId: true },
    });

    if (!establecimiento) {
      throw new NotFoundException(
        `Establecimiento ${establecimientoId} no encontrado`,
      );
    }
    if (establecimiento.userId !== userId) {
      throw new ForbiddenException('No tenés acceso a ese establecimiento.');
    }
  }

  /**
   * Elimina un lote validando ownership. El análisis GEE asociado
   * (`AnalisisLote`) se borra en cascada por la FK `onDelete: Cascade`, así
   * que no quedan registros huérfanos.
   */
  async remove(id: string, userId: string) {
    await this.findOneForUser(id, userId);

    await this.prisma.lote.delete({ where: { id } });

    this.logger.log(`Lote ${id} eliminado por usuario ${userId}`);
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

  /**
   * Versión "compuesta" que devuelve PNG **y** serie estadística en una
   * sola operación. Pensado para el endpoint `GET /:id/salud-analisis`
   * que el frontend usa al abrir el dashboard del lote: con una sola
   * roundtrip al backend (y dos en paralelo a Sentinel) ya tenemos todo
   * lo necesario para el overlay y el gráfico de evolución NDVI.
   *
   * Decisiones:
   *  - `Promise.all` (no `allSettled`): si una de las dos falla preferimos
   *    devolver error al cliente y que reintente, antes que mostrar un
   *    dashboard parcial donde el usuario no sabe si lo que ve es real o
   *    es una respuesta degradada. Sentinel Hub es estable; las fallas
   *    suelen ser transitorias (rate limits, escenas con 100% nubes) y un
   *    reintento manual resuelve el caso.
   *  - Misma `geometry` para ambas llamadas (clipping y stats sobre el
   *    polígono real del lote, no sobre el envelope). Eso es lo que pide
   *    explícitamente el caller: "que las estadísticas correspondan
   *    exactamente a mi lote".
   *  - Mismo `timeRange` para ambas: la imagen muestra la última escena
   *    válida del período y las stats lo agrupan por intervalos de `P10D`,
   *    así el usuario ve la foto y debajo el contexto temporal.
   */
  async getSaludAnalisis(
    id: string,
    userId: string,
    query: GetSaludQueryDto,
  ): Promise<SaludAnalisisResult> {
    const lote = await this.findOneForUser(id, userId);

    const feature = lote.poligonoGeoJSON as unknown as Feature<Polygon>;
    const bbox = this.calcularBbox(feature);
    const timeRange = this.resolveTimeRange(query);
    const totalHectareas = this.calcularAreaHectareas(feature);

    this.logger.log(
      `Solicitando análisis NDVI completo para lote ${lote.id} (usuario ${userId}) ` +
        `bbox=${bbox.join(',')} range=${timeRange.from}..${timeRange.to} ` +
        `area=${totalHectareas}ha`,
    );

    const [buffer, stats] = await Promise.all([
      this.sentinel.getNDVI(bbox, timeRange, {}, feature.geometry),
      this.sentinel.getNDVIStatistics(feature.geometry, timeRange),
    ]);

    const healthScore = this.summarizeHealthScore(stats, totalHectareas);

    this.logger.log(
      `Análisis NDVI lote ${lote.id} OK: PNG ${buffer.byteLength} bytes, ` +
        `${stats.length} puntos, score=${healthScore.score} (${healthScore.categoria})`,
    );

    // Persistimos el score "actual" en la entidad para que el dashboard pueda
    // promediarlo por establecimiento sin recalcular contra Sentinel. Patrón
    // cache-aside (igual que la caché GEE): el dato se refresca en cada análisis
    // que dispara el usuario, sin necesidad de un job.
    await this.persistScoreHistorico(lote.id, healthScore);

    return { buffer, bbox, stats, healthScore };
  }

  /**
   * Guarda el score de salud "actual" en `Lote.scoreHistorico` (best-effort).
   *
   * Decisiones:
   *  - Cuando no hay datos (`categoria === 'Sin datos'`) persistimos `null`, no
   *    `0`: un `0` literal arrastraría hacia abajo el promedio del dashboard.
   *    `null` se interpreta como "sin score" y queda fuera del cálculo.
   *  - `scoreHistorico` es `Int?`, así que redondeamos el score (0–100).
   *  - Es best-effort: un fallo al persistir NO debe tirar abajo el análisis
   *    (el usuario igual recibe su overlay + score en la respuesta). Se loguea
   *    como `warn` y se sigue.
   */
  private async persistScoreHistorico(
    loteId: string,
    healthScore: HealthScoreSummary,
  ): Promise<void> {
    const scoreHistorico =
      healthScore.categoria === 'Sin datos'
        ? null
        : Math.round(healthScore.score);

    try {
      await this.prisma.lote.update({
        where: { id: loteId },
        data: { scoreHistorico },
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo persistir scoreHistorico del lote ${loteId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Solo la serie temporal NDVI para un rango arbitrario, **sin** generar el
   * PNG ni recalcular el score de salud.
   *
   * Pensado para el selector de período del gráfico del dashboard: el score
   * y la capa de mapa siguen anclados a la ventana "actual" (30 días) vía
   * `getSaludAnalisis`, mientras el gráfico puede pedir 3/6/12 meses sin
   * pagar el costo de re-renderizar el raster (que es lo caro/lento) ni
   * mover el número que el productor interpreta como "estado de hoy".
   */
  async getNDVIStats(
    id: string,
    userId: string,
    query: GetSaludQueryDto,
  ): Promise<NDVIStatisticsPoint[]> {
    const lote = await this.findOneForUser(id, userId);

    const feature = lote.poligonoGeoJSON as unknown as Feature<Polygon>;
    const timeRange = this.resolveTimeRange(query);

    this.logger.log(
      `Solicitando serie NDVI para lote ${lote.id} (usuario ${userId}) ` +
        `range=${timeRange.from}..${timeRange.to}`,
    );

    const stats = await this.sentinel.getNDVIStatistics(
      feature.geometry,
      timeRange,
    );

    this.logger.log(
      `Serie NDVI lote ${lote.id} OK: ${stats.length} puntos`,
    );

    return stats;
  }

  /**
   * Calcula el resumen de salud del lote a partir de la serie temporal.
   *
   * Regla de "score actual":
   *  - Tomamos el **último intervalo válido** de la serie como referencia
   *    del estado actual. Es lo más útil agronómicamente: representa lo
   *    que el productor ve hoy en el campo, no un promedio que diluye
   *    eventos recientes (caída por sequía, recuperación post-lluvia, etc.).
   *  - Si la serie está vacía (Sentinel no encontró escenas válidas en
   *    el rango temporal) devolvemos `score: 0`, `categoria: "Sin datos"`
   *    y `fechaReferencia: null` para que el frontend pueda mostrar un
   *    placeholder honesto en vez de un número inventado.
   *
   * Por qué no `Math.max(stats.map(s => s.healthScore))` o el promedio
   * de la serie: ambos enmascararían deterioros recientes con valores
   * históricos altos. La opción "último intervalo" es la única que
   * refleja el estado "ahora" del lote.
   *
   * Las `totalHectareas` vienen del cálculo geométrico con Turf
   * (`calcularAreaHectareas`); independientes de Sentinel, así que valen
   * incluso cuando la serie está vacía.
   */
  private summarizeHealthScore(
    stats: NDVIStatisticsPoint[],
    totalHectareas: number,
  ): HealthScoreSummary {
    if (stats.length === 0) {
      return {
        score: 0,
        categoria: 'Sin datos',
        totalHectareas,
        ndviPromedio: null,
        validPixels: 0,
        fechaReferencia: null,
      };
    }

    // `stats` viene de `mapStatisticsResponse` que preserva el orden de
    // Sentinel (cronológico ascendente). Tomamos el último como "ahora".
    // Defensivamente ordenamos por fecha antes de elegir el último, así
    // somos robustos si algún día Sentinel cambia el orden de salida.
    const ordered = [...stats].sort((a, b) => a.fecha.localeCompare(b.fecha));
    const latest = ordered[ordered.length - 1];

    return {
      score: latest.healthScore,
      categoria: this.healthCategoria(latest.healthScore),
      totalHectareas,
      ndviPromedio: latest.ndvi,
      validPixels: latest.validPixels,
      fechaReferencia: latest.fecha,
    };
  }

  /**
   * Mapeo de score numérico a etiqueta agronómica.
   *
   * Cortes:
   *  - `>= 70` → "Alta" (lote sano, sin acciones urgentes).
   *  - `>= 40` → "Moderada" (zonas en estrés, conviene inspección).
   *  - `<  40` → "Baja" (mayor parte del lote en estrés, acción inmediata).
   *
   * Coinciden con los thresholds visuales del frontend (`getScoreTheme`
   * en `DashboardLote`). Si se cambian acá, sincronizar allá.
   */
  private healthCategoria(score: number): HealthScoreCategoria {
    if (score >= 70) return 'Alta';
    if (score >= 40) return 'Moderada';
    return 'Baja';
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
