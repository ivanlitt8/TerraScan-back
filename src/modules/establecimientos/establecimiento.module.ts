import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { EstablecimientoController } from './establecimiento.controller';
import { EstablecimientoService } from './establecimiento.service';

@Module({
  imports: [AuthModule],
  controllers: [EstablecimientoController],
  providers: [EstablecimientoService],
  exports: [EstablecimientoService],
})
export class EstablecimientoModule {}
