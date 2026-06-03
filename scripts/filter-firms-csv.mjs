#!/usr/bin/env node
/**
 * Filtra un CSV de NASA FIRMS al bbox de la **Región Pampeana**.
 *
 * Uso:
 *   node scripts/filter-firms-csv.mjs <input.csv> <output.csv>
 *
 * Por qué un script Node y no `awk`/`sed`/PowerShell directo:
 *  - Los CSVs originales pesan cientos de MB (millones de filas). Necesitamos
 *    streaming line-by-line (no cargar todo en memoria).
 *  - Node `readline` sobre `createReadStream` es portable Windows/Linux y
 *    no depende de herramientas que pueden no estar en PATH.
 *  - El parsing CSV es trivial porque FIRMS no usa comillas: una sola coma
 *    por delimitador, sin escapes. Si algún día agregaran campos con comas
 *    dentro de strings habría que pasar a `papaparse` o similar.
 *
 * Bbox de la Pampa argentina (caso de uso real de TerraScan):
 *   lat ∈ [-39, -31], lon ∈ [-65, -57]
 *
 * Cubre Buenos Aires, La Pampa, Córdoba, Santa Fe, Entre Ríos y el sur de
 * Santiago del Estero, San Luis y Mendoza — la zona productiva
 * pampeana clásica donde la app gestiona lotes.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

const MIN_LAT = -39;
const MAX_LAT = -31;
const MIN_LON = -65;
const MAX_LON = -57;

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error(
    "Uso: node scripts/filter-firms-csv.mjs <input.csv> <output.csv>",
  );
  process.exit(1);
}

const input = createReadStream(inputPath, { encoding: "utf-8" });
const output = createWriteStream(outputPath, { encoding: "utf-8" });
const rl = createInterface({ input, crlfDelay: Infinity });

let isFirstLine = true;
let totalLines = 0;
let keptLines = 0;
const startedAt = Date.now();

rl.on("line", (line) => {
  if (isFirstLine) {
    // Header: copiar tal cual sin parseo (es la fila 0 del CSV).
    output.write(line + "\n");
    isFirstLine = false;
    return;
  }

  totalLines += 1;

  // FIRMS pone latitude y longitude como las dos primeras columnas. No
  // parseamos el resto: solo necesitamos esos dos para decidir si la fila
  // entra al bbox. El resto se reescribe tal cual.
  const firstComma = line.indexOf(",");
  const secondComma = line.indexOf(",", firstComma + 1);
  if (firstComma === -1 || secondComma === -1) return;

  const lat = Number.parseFloat(line.slice(0, firstComma));
  const lon = Number.parseFloat(line.slice(firstComma + 1, secondComma));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  if (lat >= MIN_LAT && lat <= MAX_LAT && lon >= MIN_LON && lon <= MAX_LON) {
    output.write(line + "\n");
    keptLines += 1;
  }
});

rl.on("close", () => {
  output.end();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[filter-firms-csv] ${inputPath} → ${outputPath}: ` +
      `${keptLines.toLocaleString()} / ${totalLines.toLocaleString()} filas ` +
      `(${((keptLines / totalLines) * 100).toFixed(1)}%) en ${elapsed}s`,
  );
});
