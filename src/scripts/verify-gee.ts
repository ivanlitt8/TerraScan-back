/**
 * Script de verificación end-to-end del `GeeService` contra Google Earth
 * Engine real (private key del Service Account en `secrets/google-key.json`).
 *
 * No bootea AppModule (sin Prisma, sin HTTP server): instancia el
 * `GeeService` directo para que el test sea estanco y rápido. Si esto pasa,
 * el "túnel" backend ↔ GEE está abierto (auth válida, proyecto habilitado,
 * cómputo server-side resoluble).
 *
 * Uso:
 *   npm run verify:gee
 *
 * Salida esperada:
 *   - éxito: elevación SRTM en La Plata (~10–25 m s.n.m.).
 *   - error: mensaje con la causa (auth, proyecto no habilitado, red, etc.).
 */

import 'reflect-metadata';

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { GeeService } from '../modules/gee/gee.service';

async function main(): Promise<void> {
  console.log('▶ verify-gee — chequeando integración con Google Earth Engine\n');
  console.log('Configuración:');
  console.log(
    `  GEE_SERVICE_ACCOUNT_PATH = ${process.env.GEE_SERVICE_ACCOUNT_PATH ?? 'secrets/google-key.json (default)'}\n`,
  );

  const gee = new GeeService();
  const startedAt = Date.now();

  try {
    await gee.initialize();
    const smoke = await gee.probarConexion();
    const elapsedMs = Date.now() - startedAt;

    console.log(`\n✓ ÉXITO en ${elapsedMs} ms`);
    console.log(`  Asset      : ${smoke.asset}`);
    console.log(`  Punto      : [${smoke.punto.join(', ')}] (lng, lat)`);
    console.log(`  Elevación  : ${smoke.elevacion} m s.n.m.`);
    console.log(
      '\n  La Plata es llanura pampeana (~10–25 m): un valor en ese orden\n' +
        '  confirma que la consulta trajo datos reales del DEM.',
    );
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    console.error(`\n✕ FALLO en ${elapsedMs} ms`);

    if (error instanceof Error) {
      console.error(`  ${error.name}: ${error.message}`);
      if (error.stack) console.error(error.stack);
    } else {
      console.error('  Error inesperado:', error);
    }

    console.error(
      '\nSugerencias:\n' +
        '  · "Cannot find" / lectura de archivo: confirmá que secrets/google-key.json exista ' +
        'o configurá GEE_SERVICE_ACCOUNT_PATH.\n' +
        '  · "not registered" / "permission": el Service Account no está registrado en Earth Engine ' +
        'o el proyecto no tiene la API habilitada — registrá la cuenta en https://signup.earthengine.google.com\n' +
        '  · "invalid_grant" / auth: la private key está corrupta o rotada — regenerá la clave en GCP.\n' +
        '  · Timeout/red: GEE requiere salida a googleapis.com; revisá proxy/firewall.',
    );

    process.exitCode = 1;
  }
}

void main();
