import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { SentinelModule } from '../sentinel/sentinel.module';
import { LoteController } from './lote.controller';
import { LoteService } from './lote.service';

@Module({
  imports: [AuthModule, SentinelModule],
  controllers: [LoteController],
  providers: [LoteService],
  exports: [LoteService],
})
export class LoteModule {}
