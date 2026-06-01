/**
 * Script de verificación end-to-end del `SentinelService` contra
 * Sentinel Hub Process API real (Bearer token en `.env.local`).
 *
 * No bootea AppModule (sin Prisma, sin Supabase, sin HTTP server). Solo
 * instancia el `SentinelService` con un `HttpService` standalone para que el
 * test sea estanco y rápido. Si esto pasa, sabemos que el camino front →
 * controller → LoteService → SentinelService está correcto end-to-end.
 *
 * Uso:
 *   npm run verify:sentinel
 *
 * Salida esperada:
 *   - éxito: tamaño del PNG recibido + path al archivo guardado en disco.
 *   - error: status HTTP de Sentinel + body crudo (vía `error.cause` enriquecido
 *     en `SentinelService.translateAxiosError`).
 */

import 'reflect-metadata';

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { HttpService } from '@nestjs/axios';
import { HttpException } from '@nestjs/common';
import axios from 'axios';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  SentinelService,
  type Bbox,
  type TimeRange,
} from '../modules/sentinel/sentinel.service';

/**
 * Mismo bbox que el curl de referencia (Roma, Italia) — zona urbana con buena
 * cobertura Sentinel-2 y bajo cloud cover histórico, ideal como caso happy path.
 */
const VERIFY_BBOX: Bbox = [12.44693, 41.870072, 12.541001, 41.917096];

/**
 * Mismo rango temporal del curl de referencia. Si Sentinel no encontrase
 * escenas en esa ventana respondería `400` con `IMAGE_PROCESSING_ERROR`,
 * lo cual también es un caso útil para verificar el error handling.
 */
const VERIFY_TIMERANGE: TimeRange = {
  from: '2026-04-30',
  to: '2026-05-31',
};

const OUTPUT_PATH = path.resolve(process.cwd(), 'verify-sentinel-output.png');

interface SentinelCause {
  sentinelStatus: number;
  sentinelBody: string;
}

function isSentinelCause(value: unknown): value is SentinelCause {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sentinelStatus' in value &&
    'sentinelBody' in value
  );
}

/**
 * Ofusca un token largo dejando solo los últimos 6 caracteres visibles
 * para no escupir el JWT entero a stdout.
 */
function maskToken(token: string | undefined): string {
  if (!token) return '(no definido)';
  if (token.length <= 12) return '***';
  return `***${token.slice(-6)} (len=${token.length})`;
}

async function main(): Promise<void> {
  console.log('▶ verify-sentinel — chequeando integración con Sentinel Hub\n');
  console.log('Configuración leída de .env.local:');
  console.log(
    `  PLANET_API_KEY       = ${maskToken(process.env.PLANET_API_KEY)} (no se envía en Authorization)`,
  );
  console.log(`  BEARER_KEY           = ${maskToken(process.env.BEARER_KEY)}`);
  console.log(
    `  SENTINEL_PROCESS_URL = ${process.env.SENTINEL_PROCESS_URL ?? '(default)'}`,
  );
  console.log(`  bbox                 = [${VERIFY_BBOX.join(', ')}]`);
  console.log(
    `  timeRange            = ${VERIFY_TIMERANGE.from} → ${VERIFY_TIMERANGE.to}\n`,
  );

  // Reproducimos la misma config de HttpModule.register({ timeout, maxRedirects })
  // pero standalone — no levantamos AppModule porque no necesitamos Prisma.
  const httpInstance = axios.create({ timeout: 30_000, maxRedirects: 0 });
  const httpService = new HttpService(httpInstance);
  const sentinel = new SentinelService(httpService);

  const startedAt = Date.now();

  try {
    const buffer = await sentinel.getNDVI(VERIFY_BBOX, VERIFY_TIMERANGE);
    const elapsedMs = Date.now() - startedAt;

    await fs.writeFile(OUTPUT_PATH, buffer);

    console.log(`\n✓ ÉXITO en ${elapsedMs} ms`);
    console.log(`  Buffer PNG     : ${buffer.byteLength} bytes`);
    console.log(`  Archivo escrito: ${OUTPUT_PATH}`);
    console.log(
      '  Abrilo con cualquier visor de imágenes para confirmar visualmente\n' +
        '  que la paleta NDVI semáforo es correcta (rojo→verde).',
    );
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    console.error(`\n✕ FALLO en ${elapsedMs} ms`);

    if (error instanceof HttpException) {
      console.error(`  Excepción Nest : ${error.constructor.name}`);
      console.error(`  Status HTTP    : ${error.getStatus()}`);
      console.error(`  Mensaje        : ${error.message}`);

      const cause = (error as Error).cause;
      if (isSentinelCause(cause)) {
        console.error(`  Sentinel status: ${cause.sentinelStatus}`);
        console.error('  Sentinel body  :');
        console.error(indent(cause.sentinelBody, '    '));
      } else if (cause !== undefined) {
        console.error('  Causa          :', cause);
      }
    } else if (error instanceof Error) {
      console.error(`  ${error.name}: ${error.message}`);
      if (error.stack) console.error(error.stack);
    } else {
      console.error('  Error inesperado:', error);
    }

    console.error(
      '\nSugerencias:\n' +
        '  · Si el status fue 401, el `BEARER_KEY` está ausente, expirado o no corresponde a Sentinel Hub — ' +
        'regenerar el access token y actualizar `.env.local`.\n' +
        '  · `PLANET_API_KEY` queda reservado para pedir/renovar Bearer tokens; no se envía directo a `/process`.\n' +
        '  · Si fue 4xx por timeRange, revisar que el rango caiga dentro de ' +
        'la cobertura de Sentinel-2 L2A.\n' +
        '  · Si fue 5xx, suele ser inestabilidad temporal de Sentinel — reintentar.',
    );

    process.exitCode = 1;
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

void main();
