import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ReporteController } from './reporte.controller';
import { ReporteService } from './reporte.service';

/**
 * Módulo del Centro de Descargas de reportes. Importa `AuthModule` (para el
 * guard). `PrismaService` y `SupabaseStorageService` llegan de sus módulos
 * globales (`PrismaModule` / `StorageModule`), así que no se reimportan acá.
 */
@Module({
  imports: [AuthModule],
  controllers: [ReporteController],
  providers: [ReporteService],
  exports: [ReporteService],
})
export class ReporteModule {}
