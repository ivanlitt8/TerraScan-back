import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const frontendOrigin = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000';

  app.enableCors({
    origin: frontendOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    // Headers HTTP custom que el browser debe **permitir leer** desde el
    // cliente JS cross-origin. Sin esta whitelist, `response.headers.get(...)`
    // devuelve `null` aunque el server los esté enviando: la spec de CORS
    // oculta por default cualquier header que no esté en el set "simple".
    //
    // - `X-NDVI-Bbox`: bbox usado para enmarcar la imagen NDVI; el frontend
    //   lo lee desde `useNDVILayer` para posicionar el `image` source.
    exposedHeaders: ['X-NDVI-Bbox'],
  });

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);

  Logger.log(
    `Terrascan API escuchando en http://localhost:${port}/api (CORS: ${frontendOrigin})`,
    'Bootstrap',
  );
}

void bootstrap();
