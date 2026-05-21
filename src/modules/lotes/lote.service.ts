import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyzeLoteDto } from './dto/analyze-lote.dto';

const DEMO_USER_EMAIL = 'demo@terrascan.local';

@Injectable()
export class LoteService {
  private readonly logger = new Logger(LoteService.name);

  constructor(private readonly prisma: PrismaService) {}

  async analyze(dto: AnalyzeLoteDto) {
    const user = await this.ensureDemoUser();

    const lote = await this.prisma.lote.create({
      data: {
        nombre: dto.nombre,
        areaHectareas: 0,
        poligonoGeoJSON:
          dto.poligonoGeoJSON as unknown as Prisma.InputJsonValue,
        dataProcesada: {},
        user: { connect: { id: user.id } },
      },
    });

    this.logger.log(
      `Lote "${lote.nombre}" (${lote.id}) creado para usuario demo ${user.id}`,
    );

    return lote;
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
