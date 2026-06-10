import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { AnalisisModule } from './modules/analisis/analisis.module';
import { EstablecimientoModule } from './modules/establecimientos/establecimiento.module';
import { GeeModule } from './modules/gee/gee.module';
import { IncendiosModule } from './modules/incendios/incendios.module';
import { LoteModule } from './modules/lotes/lote.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { ReporteModule } from './modules/reportes/reporte.module';
import { StorageModule } from './modules/storage/storage.module';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    AuthModule,
    GeeModule,
    LoteModule,
    EstablecimientoModule,
    IncendiosModule,
    AnalisisModule,
    ReporteModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
