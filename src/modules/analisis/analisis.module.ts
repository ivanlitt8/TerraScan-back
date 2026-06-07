import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { LoteModule } from '../lotes/lote.module';
import { AnalisisService } from './analisis.service';
import { GeeController } from './gee.controller';

/**
 * Módulo de análisis espacial (Opción A): contiene tanto el `GeeController`
 * (ruta `/api/gee/analisis/:loteId`) como el `AnalisisService`.
 *
 * Dependencias:
 *  - `AuthModule`: provee el `SupabaseAuthGuard` del controller.
 *  - `LoteModule`: provee `LoteService` (ownership + geometría del lote).
 *  - `GeeService`: NO se importa acá — llega del `GeeModule`, que es
 *    `@Global`. Esto es lo que **evita la dependencia circular**: si
 *    importáramos `GeeModule` y `GeeModule` necesitara este módulo, habría
 *    ciclo. Al ser global, lo inyectamos sin importarlo.
 *  - `PrismaService`: idem, llega del `PrismaModule` global.
 */
@Module({
  imports: [AuthModule, LoteModule],
  controllers: [GeeController],
  providers: [AnalisisService],
})
export class AnalisisModule {}
