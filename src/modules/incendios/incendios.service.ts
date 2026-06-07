import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { toPostgisGeometryGeoJSON } from '../../common/geojson';
import { PrismaService } from '../prisma/prisma.service';
import { GetIncendiosQueryDto } from './dto/get-incendios.query.dto';
import type { IncendioResponse } from './types/incendio.response';

/**
 * Default temporal cuando no llegan `from`/`to`: últimos 5 años.
 *
 * Por qué 5 años: el caso de uso del front es "alertas históricas en
 * el lote" — un horizonte más corto pierde eventos relevantes (e.g.
 * incendios pampeanos de 2020-2022 fueron extremos); uno más largo
 * empieza a devolver miles de detecciones por lote que la UI no puede
 * mostrar útilmente. 5 años es un punto sano.
 */
const DEFAULT_WINDOW_YEARS = 5;

/**
 * Tope de filas que el endpoint devuelve por request. Defensivo: un lote
 * grande en una zona muy activa (e.g. norte argentino en seca) puede
 * generar miles de detecciones. Si el cliente necesita más, debe acotar
 * el rango temporal o el endpoint debe paginar (futuro).
 */
const MAX_RESULTS = 1000;

/**
 * Forma cruda de cada fila que devuelve la query SQL. Las columnas vienen
 * con `snake_case` porque `$queryRaw` respeta los nombres de PostgreSQL.
 * El service la mapea a `IncendioResponse` (camelCase / español) antes
 * de devolverla al controller.
 */
interface IncendioRow {
  id: number;
  latitude: number;
  longitude: number;
  acq_date: Date;
  acq_time: string | null;
  confidence: string | null;
  frp: number | null;
  brightness: number | null;
  bright_t31: number | null;
  daynight: string | null;
  satellite: string;
  type: number | null;
}

@Injectable()
export class IncendiosService {
  private readonly logger = new Logger(IncendiosService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Devuelve las detecciones FIRMS (NOAA-20 + SNPP) que **intersectan**
   * el polígono dado en el rango temporal indicado.
   *
   * Uso directo: cuando ya tenés el polígono GeoJSON serializado
   * (e.g. lo cargás de Prisma como `Json`). Para el flujo HTTP estándar
   * (autenticado por loteId) usar `getIncendiosByLoteId`.
   *
   * @param poligonoGeoJSON GeoJSON serializado de la geometría del
   *   polígono (`Polygon` o `MultiPolygon`). Importante: PostGIS
   *   `ST_GeomFromGeoJSON` espera una geometría, no un `Feature`
   *   envolvente; por eso `getIncendiosByLoteId` normaliza antes de
   *   llamar a este método.
   * @param fechaInicio Inclusivo, se normaliza a 00:00:00 UTC del día.
   * @param fechaFin    Inclusivo, se normaliza a 23:59:59 UTC del día.
   *
   * Nota sobre performance: usamos `ST_Intersects(geom, ...)` sobre la
   * columna `geometry` con índice GIST. Eso aprovecha el index
   * **directamente** — `ST_Intersects` aplica un bbox prefilter
   * automático (operador `&&`) antes de la verificación geométrica
   * exacta, así que NO necesitamos el patrón doble-filtro que sí
   * aplica al caso `ST_DWithin(geom::geography, ..., metros)`
   * documentado en `back/HISTORIAL.md`.
   *
   * Validamos el SRID a 4326 con `ST_SetSRID` por si el GeoJSON entrante
   * no trae un `crs` interno (Features típicos de Mapbox/Turf no lo
   * incluyen): sin SRID, PostGIS rechaza el `ST_Intersects` contra una
   * columna que sí lo tiene.
   */
  async getIncendiosByLote(
    poligonoGeoJSON: string,
    fechaInicio: Date,
    fechaFin: Date,
  ): Promise<IncendioResponse[]> {
    const fromIso = this.toUtcDayStart(fechaInicio);
    const toIso = this.toUtcDayEnd(fechaFin);

    this.logger.log(
      `→ ST_Intersects polígono(${poligonoGeoJSON.length} chars) ` +
        `acq_date ∈ [${fromIso.toISOString()} .. ${toIso.toISOString()}]`,
    );

    // `$queryRaw` con `Prisma.sql` parametriza los inputs (anti SQL
    // injection) y deja a Prisma manejar el casting de tipos. El cast
    // explícito `::jsonb` no es necesario porque pasamos un string y
    // `ST_GeomFromGeoJSON` lo acepta como `text`.
    const rows = await this.prisma.$queryRaw<IncendioRow[]>(
      Prisma.sql`
        SELECT
          id,
          latitude,
          longitude,
          acq_date,
          acq_time,
          confidence,
          frp,
          brightness,
          bright_t31,
          daynight,
          satellite,
          type
        FROM incendios
        WHERE acq_date BETWEEN ${fromIso} AND ${toIso}
          AND ST_Intersects(
            geom,
            ST_SetSRID(ST_GeomFromGeoJSON(${poligonoGeoJSON}), 4326)
          )
        ORDER BY acq_date DESC, id DESC
        LIMIT ${MAX_RESULTS}
      `,
    );

    this.logger.log(`← ${rows.length} detecciones encontradas`);

    return rows.map((row) => this.toResponse(row));
  }

  /**
   * Variante "HTTP-ready" que valida ownership del lote y delega a
   * `getIncendiosByLote`. Es la que usa el controller.
   *
   * Hacemos el lookup directo a `prisma.lote` (sin pasar por
   * `LoteService`) para no acoplar `IncendiosModule` con `LoteModule`:
   * sólo necesitamos el polígono persistido y el `userId` para la
   * verificación de ownership, no la lógica completa de análisis.
   *
   * Errores que tira:
   *  - `NotFoundException`: el lote no existe.
   *  - `ForbiddenException`: el lote existe pero pertenece a otro usuario.
   */
  async getIncendiosByLoteId(
    loteId: string,
    userId: string,
    query: GetIncendiosQueryDto,
  ): Promise<IncendioResponse[]> {
    const lote = await this.prisma.lote.findUnique({
      where: { id: loteId },
      select: { id: true, userId: true, poligonoGeoJSON: true },
    });

    if (!lote) {
      throw new NotFoundException(`Lote ${loteId} no encontrado`);
    }

    if (lote.userId !== userId) {
      this.logger.warn(
        `Usuario ${userId} intentó listar incendios del lote ${loteId} de ${lote.userId}`,
      );
      throw new ForbiddenException('No tenés acceso a este lote.');
    }

    const { fechaInicio, fechaFin } = this.resolveTimeRange(query);

    // Prisma almacena el polígono como `Json`. Los lotes creados desde
    // el front llegan como `Feature`, pero PostGIS `ST_GeomFromGeoJSON`
    // sólo acepta la geometría (`Polygon`/`MultiPolygon`), no el wrapper.
    // `toPostgisGeometryGeoJSON` (en `common/geojson`) normaliza y serializa.
    const poligonoGeoJSON = toPostgisGeometryGeoJSON(lote.poligonoGeoJSON);

    this.logger.log(
      `Listando incendios para lote ${loteId} (usuario ${userId})`,
    );

    return this.getIncendiosByLote(poligonoGeoJSON, fechaInicio, fechaFin);
  }

  /**
   * Mapeo crudo Postgres → DTO público. Es una transformación trivial,
   * pero mantenerla en un método aislado:
   *  1. Documenta el contrato externo de cara al frontend (camelCase).
   *  2. Centraliza renombres futuros (e.g. si decidimos renombrar `frp`
   *     a `intensidadMW` no hay que cambiarlo en cada `SELECT`).
   *  3. Hace explícita la conversión de `Date` → `string` ISO, que es
   *     lo que NestJS serializaría por default pero queremos garantizar
   *     el formato `YYYY-MM-DD` (sin hora) porque FIRMS no la trae.
   */
  private toResponse(row: IncendioRow): IncendioResponse {
    return {
      id: row.id,
      latitude: row.latitude,
      longitude: row.longitude,
      fecha: row.acq_date.toISOString().slice(0, 10),
      hora: row.acq_time,
      confianza: row.confidence,
      frp: row.frp,
      brillo: row.brightness,
      brightT31: row.bright_t31,
      daynight: row.daynight,
      satelite: row.satellite,
      tipo: row.type,
    };
  }

  private resolveTimeRange(query: GetIncendiosQueryDto): {
    fechaInicio: Date;
    fechaFin: Date;
  } {
    const today = new Date();
    const defaultFrom = new Date(today);
    defaultFrom.setUTCFullYear(today.getUTCFullYear() - DEFAULT_WINDOW_YEARS);

    return {
      fechaInicio: query.from ? new Date(query.from) : defaultFrom,
      fechaFin: query.to ? new Date(query.to) : today,
    };
  }

  /** Inicio de día UTC: `2026-01-15T00:00:00.000Z`. */
  private toUtcDayStart(d: Date): Date {
    const x = new Date(d);
    x.setUTCHours(0, 0, 0, 0);
    return x;
  }

  /** Fin de día UTC: `2026-01-15T23:59:59.999Z`. */
  private toUtcDayEnd(d: Date): Date {
    const x = new Date(d);
    x.setUTCHours(23, 59, 59, 999);
    return x;
  }
}
