import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { SentinelService } from './sentinel.service';

/**
 * Wrapper sobre Sentinel Hub Process API.
 *
 * `HttpModule.register` se configura una sola vez para todo el módulo:
 * - `timeout: 30_000` — Sentinel suele responder en 5–15 s; 30 s deja
 *   margen para escenas grandes sin bloquear request slots por demasiado tiempo.
 * - `maxRedirects: 0` — el endpoint `/api/v1/process` nunca redirige; si
 *   apareciera un redirect inesperado preferimos fallar antes que seguirlo
 *   ciegamente (defensa contra mal-config de proxies internos).
 */
@Module({
  imports: [
    HttpModule.register({
      timeout: 30_000,
      maxRedirects: 0,
    }),
  ],
  providers: [SentinelService],
  exports: [SentinelService],
})
export class SentinelModule {}
