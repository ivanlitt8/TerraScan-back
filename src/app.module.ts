import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { AnalisisModule } from './modules/analisis/analisis.module';
import { GeeModule } from './modules/gee/gee.module';
import { IncendiosModule } from './modules/incendios/incendios.module';
import { LoteModule } from './modules/lotes/lote.module';
import { PrismaModule } from './modules/prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    GeeModule,
    LoteModule,
    IncendiosModule,
    AnalisisModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
