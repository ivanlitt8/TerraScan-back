import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as turf from '@turf/turf';
import type { Feature, Polygon } from 'geojson';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyzeLoteDto } from './dto/analyze-lote.dto';

const DEMO_USER_EMAIL = 'demo@terrascan.local';
const SQUARE_METERS_PER_HECTARE = 10_000;

@Injectable()
export class LoteService {
  private readonly logger = new Logger(LoteService.name);

  constructor(private readonly prisma: PrismaService) {}

  async analyze(dto: AnalyzeLoteDto) {
    const user = await this.ensureDemoUser();
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
      `Lote "${lote.nombre}" (${lote.id}, ${areaHectareas} ha) creado para usuario demo ${user.id}`,
    );

    return lote;
  }

  async findAllForDemoUser() {
    return this.prisma.lote.findMany({
      where: { user: { email: DEMO_USER_EMAIL } },
      select: {
        id: true,
        nombre: true,
        areaHectareas: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const lote = await this.prisma.lote.findUnique({ where: { id } });

    if (!lote) {
      throw new NotFoundException(`Lote ${id} no encontrado`);
    }

    return lote;
  }

  private calcularAreaHectareas(poligono: unknown): number {
    const feature = poligono as Feature<Polygon>;
    const metrosCuadrados = turf.area(feature);
    return Number((metrosCuadrados / SQUARE_METERS_PER_HECTARE).toFixed(4));
  }

  private ensureDemoUser() {
    return this.prisma.user.upsert({
      where: { email: DEMO_USER_EMAIL },
      update: {},
      create: {
        email: DEMO_USER_EMAIL,
        password: 'placeholder-no-usar-en-produccion',
      },
    });
  }
}
