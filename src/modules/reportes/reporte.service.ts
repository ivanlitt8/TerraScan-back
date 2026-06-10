import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseStorageService } from '../storage/storage.service';
import { CreateReporteDto } from './dto/create-reporte.dto';

/**
 * Vida (segundos) de las URLs firmadas que entrega el Centro de Descargas.
 * Corta a propósito: alcanza para que el browser dispare la descarga y no deja
 * un enlace público reutilizable circulando.
 */
const SIGNED_URL_TTL_SECONDS = 60;

@Injectable()
export class ReporteService {
  private readonly logger = new Logger(ReporteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
  ) {}

  /**
   * Persiste la metadata de un reporte para el usuario autenticado. Si viene
   * `loteId`, valida que el lote pertenezca al mismo usuario antes de asociar
   * (evita que un reporte nazca colgado de un lote ajeno).
   */
  async create(dto: CreateReporteDto, user: AuthenticatedUser) {
    await this.ensureUserRow(user);

    if (dto.loteId) {
      await this.assertLoteOwnership(dto.loteId, user.id);
    }

    const reporte = await this.prisma.reporte.create({
      data: {
        nombre: dto.nombre,
        establecimiento: dto.establecimiento ?? null,
        urlStorage: dto.urlStorage,
        userId: user.id,
        ...(dto.loteId ? { lote: { connect: { id: dto.loteId } } } : {}),
      },
    });

    this.logger.log(
      `Reporte "${reporte.nombre}" (${reporte.id}) creado para usuario ${user.id}`,
    );

    return reporte;
  }

  /**
   * Lista los reportes **activos** del usuario, del más reciente al más
   * antiguo. Es el feed del Centro de Descargas: los soft-deleted
   * (`isDeleted: true`) quedan fuera, aunque su fila y su PDF sigan vivos.
   */
  findAllForUser(userId: string) {
    return this.prisma.reporte.findMany({
      where: { userId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Genera una URL firmada de descarga para el reporte indicado, validando
   * ownership antes (404 si no existe, 403 si es de otro usuario). La firma la
   * hace Supabase Storage con el service role key del servidor.
   */
  async getSignedUrl(id: string, userId: string) {
    const reporte = await this.prisma.reporte.findUnique({ where: { id } });

    if (!reporte) {
      throw new NotFoundException(`Reporte ${id} no encontrado`);
    }
    if (reporte.userId !== userId) {
      this.logger.warn(
        `Usuario ${userId} intentó descargar el reporte ${id} de ${reporte.userId}`,
      );
      throw new ForbiddenException('No tenés acceso a este reporte.');
    }
    // Un reporte dado de baja (soft delete) no debe ser descargable aunque el
    // cliente conozca el id: lo tratamos como inexistente (404).
    if (reporte.isDeleted) {
      this.logger.warn(
        `Usuario ${userId} intentó descargar el reporte ${id} dado de baja`,
      );
      throw new NotFoundException(`Reporte ${id} no encontrado`);
    }

    const { url, expiresIn } = await this.storage.createSignedUrl(
      reporte.urlStorage,
      SIGNED_URL_TTL_SECONDS,
    );

    return {
      url,
      expiresIn,
      nombre: reporte.nombre,
    };
  }

  /**
   * Soft delete: oculta el reporte del Centro de Descargas marcándolo
   * `isDeleted: true`, sin borrar la fila ni el PDF en Storage (historial y
   * trazabilidad intactos). Valida ownership (404 si no existe, 403 si es de
   * otro usuario). Idempotente: re-eliminar un reporte ya dado de baja no
   * rompe nada.
   */
  async removeLogico(id: string, userId: string): Promise<void> {
    const reporte = await this.prisma.reporte.findUnique({
      where: { id },
      select: { userId: true, isDeleted: true },
    });

    if (!reporte) {
      throw new NotFoundException(`Reporte ${id} no encontrado`);
    }
    if (reporte.userId !== userId) {
      this.logger.warn(
        `Usuario ${userId} intentó eliminar el reporte ${id} de ${reporte.userId}`,
      );
      throw new ForbiddenException('No tenés acceso a este reporte.');
    }

    if (reporte.isDeleted) {
      return;
    }

    await this.prisma.reporte.update({
      where: { id },
      data: { isDeleted: true },
    });

    this.logger.log(`Reporte ${id} dado de baja (soft delete) por ${userId}`);
  }

  /** Valida que el lote exista y pertenezca al usuario. */
  private async assertLoteOwnership(
    loteId: string,
    userId: string,
  ): Promise<void> {
    const lote = await this.prisma.lote.findUnique({
      where: { id: loteId },
      select: { userId: true },
    });

    if (!lote) {
      throw new NotFoundException(`Lote ${loteId} no encontrado`);
    }
    if (lote.userId !== userId) {
      throw new ForbiddenException('No tenés acceso a este lote.');
    }
  }

  /**
   * Espeja perezosamente al usuario de Supabase en la tabla `User` (idéntico a
   * `LoteService.ensureUserRow`): la FK `userId` lo exige.
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
