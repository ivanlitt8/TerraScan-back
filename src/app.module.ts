import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { IncendiosModule } from './modules/incendios/incendios.module';
import { LoteModule } from './modules/lotes/lote.module';
import { PrismaModule } from './modules/prisma/prisma.module';

@Module({
  imports: [PrismaModule, AuthModule, LoteModule, IncendiosModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
