import { Global, Module } from '@nestjs/common';
import { GeeService } from './gee.service';

/**
 * Módulo de integración con Google Earth Engine.
 *
 * `@Global` porque `GeeService` envuelve un cliente con estado global y
 * único (el token de GEE vive en el módulo `ee`, no por instancia):
 * tenerlo disponible en toda la app sin re-importar evita la tentación de
 * crear segundas instancias que dispararían autenticaciones duplicadas.
 */
@Global()
@Module({
  providers: [GeeService],
  exports: [GeeService],
})
export class GeeModule {}
