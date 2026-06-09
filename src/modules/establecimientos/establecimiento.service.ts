import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEstablecimientoDto } from './dto/create-establecimiento.dto';
import { UpdateEstablecimientoDto } from './dto/update-establecimiento.dto';

@Injectable()
export class EstablecimientoService {
  private readonly logger = new Logger(EstablecimientoService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crea un establecimiento para el usuario autenticado. Garantiza la fila
   * `User` (igual que `LoteService.analyze`) porque la FK `userId` la exige.
   */
  async create(dto: CreateEstablecimientoDto, user: AuthenticatedUser) {
    await this.ensureUserRow(user);

    const establecimiento = await this.prisma.establecimiento.create({
      data: { nombre: dto.nombre, userId: user.id },
    });

    this.logger.log(
      `Establecimiento "${establecimiento.nombre}" (${establecimiento.id}) creado para usuario ${user.id}`,
    );

    return establecimiento;
  }

  /**
   * Lista los establecimientos del usuario con el conteo de lotes y la suma
   * de hectáreas (para las tarjetas compactas del front). Una sola query con
   * `_count` + agregación en memoria sobre los lotes seleccionados.
   */
  async findAllForUser(userId: string) {
    const establecimientos = await this.prisma.establecimiento.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { lotes: true } },
        lotes: { select: { areaHectareas: true } },
      },
    });

    return establecimientos.map((est) => ({
      id: est.id,
      nombre: est.nombre,
      createdAt: est.createdAt,
      totalLotes: est._count.lotes,
      totalHectareas: Number(
        est.lotes.reduce((sum, l) => sum + l.areaHectareas, 0).toFixed(2),
      ),
    }));
  }

  /**
   * Detalle de un establecimiento + sus lotes. Valida ownership con la misma
   * política que `LoteService.findOneForUser` (404 si no existe, 403 si es de
   * otro usuario).
   */
  async findOneForUser(id: string, userId: string) {
    const establecimiento = await this.prisma.establecimiento.findUnique({
      where: { id },
      include: {
        lotes: {
          select: {
            id: true,
            nombre: true,
            areaHectareas: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!establecimiento) {
      throw new NotFoundException(`Establecimiento ${id} no encontrado`);
    }

    if (establecimiento.userId !== userId) {
      this.logger.warn(
        `Usuario ${userId} intentó acceder al establecimiento ${id} de ${establecimiento.userId}`,
      );
      throw new ForbiddenException('No tenés acceso a este establecimiento.');
    }

    return establecimiento;
  }

  async update(id: string, userId: string, dto: UpdateEstablecimientoDto) {
    await this.assertOwnership(id, userId);

    const establecimiento = await this.prisma.establecimiento.update({
      where: { id },
      data: { nombre: dto.nombre },
    });

    this.logger.log(`Establecimiento ${id} actualizado por usuario ${userId}`);

    return establecimiento;
  }

  /**
   * Elimina un establecimiento. Los lotes asociados NO se borran: la FK usa
   * `onDelete: SetNull`, así que quedan desagrupados (`establecimientoId`
   * pasa a `null`) y siguen siendo del usuario.
   */
  async remove(id: string, userId: string) {
    await this.assertOwnership(id, userId);

    await this.prisma.establecimiento.delete({ where: { id } });

    this.logger.log(`Establecimiento ${id} eliminado por usuario ${userId}`);
  }

  /** Valida que el establecimiento exista y pertenezca al usuario. */
  private async assertOwnership(id: string, userId: string): Promise<void> {
    const establecimiento = await this.prisma.establecimiento.findUnique({
      where: { id },
      select: { userId: true },
    });

    if (!establecimiento) {
      throw new NotFoundException(`Establecimiento ${id} no encontrado`);
    }
    if (establecimiento.userId !== userId) {
      throw new ForbiddenException('No tenés acceso a este establecimiento.');
    }
  }

  /**
   * Espeja perezosamente al usuario de Supabase en la tabla `User` (idéntico
   * a `LoteService.ensureUserRow`): necesario porque la FK `userId` lo exige.
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
