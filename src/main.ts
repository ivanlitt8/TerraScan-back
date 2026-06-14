import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { GeeService } from './modules/gee/gee.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');

  // Inicialización de Google Earth Engine antes de aceptar tráfico.
  //
  // Decisión: un fallo de GEE NO aborta el arranque. GEE es una de varias
  // integraciones (Sentinel Hub, FIRMS, Supabase) y tirar todo el API
  // abajo porque el túnel a GEE no abrió dejaría sin servicio a endpoints
  // que no dependen de él. El `GeeService` queda con `ready=false` y los
  // consumidores deben chequear `isReady()` (o reintentar `initialize()`).
  //
  // El smoke test (`probarConexion`) sólo corre si la init fue OK, y su
  // error tampoco es fatal: confirma el túnel en boot sin condicionar el
  // arranque a la disponibilidad de un asset externo.
  const gee = app.get(GeeService);
  try {
    await gee.initialize();
    const smoke = await gee.probarConexion();
    Logger.log(
      `Earth Engine listo · elevación La Plata ≈ ${smoke.elevacion} m (${smoke.asset})`,
      'Bootstrap',
    );
  } catch (error) {
    Logger.error(
      `No se pudo inicializar Google Earth Engine: ${(error as Error).message}. ` +
        `El API arranca igual; las features que usan GEE quedarán deshabilitadas hasta reintentar.`,
      'Bootstrap',
    );
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const allowedOrigins = [
    'http://localhost:3000',
    'https://terrascan-platform.vercel.app'
  ];
  
  app.enableCors({
    origin: (origin, callback) => {
      // Si la petición no tiene origin (como Postman) o está en la lista, pasa directo
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Bloqueado por CORS de TerraScan'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    // Headers HTTP custom que el browser debe permitir leer desde el
    // cliente JS cross-origin. Sin esta whitelist, `response.headers.get(...)`
    // devuelve `null` aunque el server los esté enviando.
    //
    // - `X-NDVI-Bbox`: bbox usado para enmarcar la imagen NDVI; el frontend
    //   lo lee desde `useNDVILayer` para posicionar el `image` source.
    exposedHeaders: ['X-NDVI-Bbox'],
  });

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);

  Logger.log(
    `Terrascan API escuchando en http://localhost:${port}/api (CORS: ${allowedOrigins.join(', ')})`,
    'Bootstrap',
  );
}

void bootstrap();
