import { BadRequestException } from '@nestjs/common';
import type { Feature, Geometry, MultiPolygon, Polygon } from 'geojson';

/**
 * Helpers de normalización de GeoJSON compartidos entre módulos.
 *
 * Los lotes se persisten como `Feature<Polygon>` (así llegan del front),
 * pero tanto PostGIS (`ST_GeomFromGeoJSON`) como Earth Engine (`ee.Geometry`)
 * esperan una **geometría plana** (`Polygon`/`MultiPolygon`), NO el `Feature`
 * envolvente. Pasar el `Feature` entero hace que PostGIS responda
 * `invalid GeoJson representation` y que GEE arroje un error equivalente.
 *
 * Centralizamos la extracción acá para no duplicar los type-guards en cada
 * módulo que consulta geometrías del lote (incendios, análisis espacial, …).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPolygonGeometry(value: unknown): value is Polygon | MultiPolygon {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  return (
    (value.type === 'Polygon' || value.type === 'MultiPolygon') &&
    Array.isArray(value.coordinates)
  );
}

function isFeature(value: unknown): value is Feature<Geometry> {
  return (
    isRecord(value) &&
    value.type === 'Feature' &&
    isPolygonGeometry((value as { geometry?: unknown }).geometry)
  );
}

/**
 * Devuelve la geometría `Polygon`/`MultiPolygon` de un valor que puede ser
 * un `Feature` envolvente o ya una geometría plana. Lanza
 * `BadRequestException` (HTTP 400) si el valor no contiene una geometría de
 * polígono válida.
 */
export function normalizePolygonGeometry(
  value: unknown,
): Polygon | MultiPolygon {
  const candidate = isFeature(value) ? value.geometry : value;

  if (!isPolygonGeometry(candidate)) {
    throw new BadRequestException(
      'La geometría del lote no es un Polygon/MultiPolygon GeoJSON válido.',
    );
  }

  return candidate;
}

/**
 * Igual que `normalizePolygonGeometry` pero serializado a `string`, listo
 * para `ST_GeomFromGeoJSON(...)` (que espera `text`).
 */
export function toPostgisGeometryGeoJSON(value: unknown): string {
  return JSON.stringify(normalizePolygonGeometry(value));
}
