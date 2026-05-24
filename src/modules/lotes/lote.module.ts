import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { LoteController } from './lote.controller';
import { LoteService } from './lote.service';

@Module({
  imports: [AuthModule],
  controllers: [LoteController],
  providers: [LoteService],
  exports: [LoteService],
})
export class LoteModule {}
