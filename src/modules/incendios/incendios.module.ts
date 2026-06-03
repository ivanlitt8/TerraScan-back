import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { IncendiosController } from './incendios.controller';
import { IncendiosService } from './incendios.service';

/**
 * Módulo de incendios FIRMS.
 *
 * Depende de:
 *  - `AuthModule` para el `SupabaseAuthGuard` que protege el endpoint.
 *  - `PrismaModule` (global) para `PrismaService`, que se inyecta
 *    automáticamente en `IncendiosService`.
 *
 * No depende de `LoteModule`: el lookup de ownership lo hace directo
 * con `prisma.lote.findUnique` en el service para mantener acoplamiento
 * bajo entre módulos.
 *
 * Se exporta `IncendiosService` por si otro feature futuro lo necesita
 * (e.g. un job que pre-calcule el "incendio score histórico" del lote
 * y lo guarde en `Lote.scoreHistorico`).
 */
@Module({
  imports: [AuthModule],
  controllers: [IncendiosController],
  providers: [IncendiosService],
  exports: [IncendiosService],
})
export class IncendiosModule {}
