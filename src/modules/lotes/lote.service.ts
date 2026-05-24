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
import { AnalyzeLoteDto } from './dto/analyze-lote.dto';

const SQUARE_METERS_PER_HECTARE = 10_000;

@Injectable()
export class LoteService {
  private readonly logger = new Logger(LoteService.name);

  constructor(private readonly prisma: PrismaService) {}

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

  private calcularAreaHectareas(poligono: unknown): number {
    const feature = poligono as Feature<Polygon>;
    const metrosCuadrados = turf.area(feature);
    return Number((metrosCuadrados / SQUARE_METERS_PER_HECTARE).toFixed(4));
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
