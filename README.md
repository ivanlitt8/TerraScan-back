# Terrascan — Backend

API REST en NestJS que procesa, cachea y persiste datos geoespaciales y satelitales para lotes rurales en Argentina. Expone endpoints JSON consumidos por el frontend Next.js (`../front/`).

> Repositorio público: este README describe el stack y cómo desarrollar localmente. Especificaciones de producto, bitácora de decisiones y reglas del equipo viven en archivos locales no versionados (ver [Documentación del equipo](#documentación-del-equipo)).

## Estado actual

El backend cubre el núcleo operativo del MVP:

| Área | Descripción |
|------|-------------|
| **Autenticación** | `SupabaseAuthGuard` — validación JWT vía JWKS (`jose`, RS256/ES256) |
| **Lotes** | Creación, listado, detalle, edición y borrado con geometría GeoJSON |
| **NDVI / salud** | Sentinel Hub (OAuth2 JIT): overlay PNG, estadísticas y score de salud |
| **Análisis espacial** | Google Earth Engine: elevación SRTM + historial de inundaciones (caché-aside) |
| **Incendios** | Consultas PostGIS sobre base histórica NASA FIRMS |
| **Dashboard** | Agregados locales (KPIs, matriz de riesgo hídrico, monitor de incendios) |
| **Establecimientos** | CRUD de campos que agrupan lotes por usuario |
| **Reportes** | Metadata en PostgreSQL + URLs firmadas de Supabase Storage |

Todas las rutas de negocio viven bajo el prefijo global `/api`. El puerto por defecto es **3001**.

## Stack

| Tecnología | Uso |
|------------|-----|
| [NestJS 11](https://nestjs.com/) + TypeScript | Framework HTTP |
| [Prisma 6](https://www.prisma.io/) | ORM contra PostgreSQL (Supabase) |
| [PostGIS](https://postgis.net/) | Queries espaciales (incendios FIRMS) |
| [@nestjs/axios](https://docs.nestjs.com/techniques/http-module) | Cliente HTTP (Sentinel Hub) |
| [@google/earthengine](https://developers.google.com/earth-engine) | Elevación e inundaciones históricas |
| [@supabase/supabase-js](https://supabase.com/docs) | Storage privado (reportes PDF) |
| [jose](https://github.com/panva/jose) | Verificación JWT Supabase (JWKS) |
| [@turf/turf](https://turfjs.org/) | Validación y cálculo de área GeoJSON |
| [class-validator](https://github.com/typestack/class-validator) | Validación de DTOs |
| Jest + supertest | Tests unitarios y e2e |

## Arquitectura

```
┌──────────────────────────────────────────────────────────────┐
│  Frontend Next.js (:3000)                                    │
│  Authorization: Bearer <Supabase JWT>                        │
└────────────────────────────┬─────────────────────────────────┘
                             │ REST /api/*
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  NestJS API (:3001)                                          │
│  Guards · ValidationPipe · CORS · Helmet                     │
├──────────────┬───────────────┬──────────────┬────────────────┤
│ Lotes        │ Analisis/GEE  │ Sentinel     │ Incendios      │
│ Establecim.  │ Dashboard     │              │ (PostGIS)      │
│ Reportes     │               │              │                │
└──────┬───────┴───────┬───────┴──────┬───────┴────────┬───────┘
       │               │              │                │
       ▼               ▼              ▼                ▼
  PostgreSQL      Google Earth    Sentinel Hub      CSV FIRMS
  (Supabase)      Engine API      (OAuth2)          (carga local)
       │
       ▼
  Supabase Storage (bucket privado `reportes`)
```

Principios de diseño:

- **Credenciales solo en servidor** — Sentinel, GEE, Supabase service role nunca salen del backend.
- **Caché obligatoria** — análisis GEE y tokens Sentinel se reutilizan para controlar costos y latencia.
- **Validación de geometría** — `Feature<Polygon>`, área mín/máx y bounds de la Pampea antes de llamar APIs satelitales.
- **GEE no bloquea el arranque** — si Earth Engine falla al boot, el API sigue levantado; las features que lo usan quedan deshabilitadas hasta reintentar.

## Estructura de carpetas

```
back/
├── prisma/
│   ├── schema.prisma           # Modelos User, Lote, Establecimiento, Reporte, AnalisisLote, Incendio
│   └── migrations/
├── src/
│   ├── main.ts                 # Bootstrap, CORS, ValidationPipe, init GEE
│   ├── auth/                   # SupabaseAuthGuard, decoradores
│   ├── modules/
│   │   ├── lotes/              # CRUD + NDVI/salud (Sentinel)
│   │   ├── establecimientos/   # CRUD de campos
│   │   ├── analisis/           # GEE + dashboard agregador
│   │   ├── sentinel/           # Cliente Sentinel Hub (OAuth + Process/Statistics)
│   │   ├── gee/                # Cliente Google Earth Engine
│   │   ├── incendios/          # Queries FIRMS por lote
│   │   ├── reportes/           # Centro de descargas
│   │   ├── storage/            # Supabase Storage (URLs firmadas)
│   │   └── prisma/             # PrismaService global
│   └── scripts/
│       ├── verify-sentinel.ts  # Smoke test Sentinel Hub
│       └── verify-gee.ts       # Smoke test Earth Engine
├── secrets/                    # Service account GEE (gitignored)
└── data/firms/                 # CSV históricos FIRMS (gitignored)
```

Convenciones: un módulo por dominio en `src/modules/<dominio>/` con `controller`, `service`, `dto` y `module`. Errores de dominio mapeados a `HttpException`. Logger nativo de Nest (sin `console.log` en producción).

## API REST

Todas las rutas requieren `Authorization: Bearer <jwt>` salvo indicación contraria. Base URL: `http://localhost:3001/api`.

### Lotes

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/lotes/analyze` | Crear lote y analizar geometría |
| `GET` | `/lotes` | Listar lotes del usuario (`?establecimientoId` opcional) |
| `GET` | `/lotes/:id` | Detalle de un lote |
| `PATCH` | `/lotes/:id` | Renombrar y/o reasignar establecimiento |
| `DELETE` | `/lotes/:id` | Borrar lote (cascada análisis GEE) |
| `GET` | `/lotes/:id/salud` | PNG NDVI (`?from` / `?to`) + header `X-NDVI-Bbox` |
| `GET` | `/lotes/:id/salud-analisis` | PNG base64 + stats + healthScore (dashboard) |
| `GET` | `/lotes/:id/salud-stats` | Solo serie temporal NDVI (gráfico 3/6/12 meses) |
| `GET` | `/lotes/:id/incendios` | Detecciones FIRMS en el polígono (`?from` / `?to`) |

### Análisis y dashboard

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/gee/analisis/:loteId` | Elevación + inundaciones (caché GEE, `?force=true` para recalcular) |
| `GET` | `/analisis/dashboard` | KPIs, matriz de riesgo hídrico, monitor de incendios |

### Establecimientos y reportes

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST/GET/PATCH/DELETE` | `/establecimientos` | CRUD de campos |
| `POST` | `/reportes` | Registrar metadata de un PDF subido |
| `GET` | `/reportes` | Listar reportes del usuario |
| `GET` | `/reportes/:id/download` | URL firmada de descarga (60 s) |
| `DELETE` | `/reportes/:id` | Soft delete |

Los tipos de respuesta siguen la forma de `../front/src/types/loteAnalysis.ts` hasta extraer un paquete compartido.

## Requisitos

- **Node.js** 20+ (recomendado)
- **npm**
- Proyecto **Supabase** con PostgreSQL + PostGIS habilitado
- Cuenta **Sentinel Hub** (OAuth client credentials)
- Cuenta **Google Earth Engine** con service account (opcional para desarrollo parcial)
- **Frontend** en `../front/` para pruebas end-to-end

## Variables de entorno

Crear `back/.env.local` (no se versiona). `main.ts` y `prisma.config.ts` lo cargan con `dotenv`.

```env
# Servidor
PORT=3001

# PostgreSQL (Supabase)
# DATABASE_URL → pooler (puerto 6543, ?pgbouncer=true)
# DIRECT_URL   → conexión directa (puerto 5432, para migraciones)
DATABASE_URL=postgresql://...
DIRECT_URL=postgresql://...

# Supabase
SUPABASE_URL=https://<tu-proyecto>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
SUPABASE_STORAGE_BUCKET=reportes

# Sentinel Hub (OAuth2 client credentials)
SENTINEL_CLIENT_ID=<client-id>
SENTINEL_CLIENT_SECRET=<client-secret>
# Opcionales (defaults internos si se omiten):
# SENTINEL_TOKEN_URL=
# SENTINEL_PROCESS_URL=
# SENTINEL_STATISTICS_URL=

# Google Earth Engine
# Opción A: JSON inline
# GOOGLE_GEE_KEY={"type":"service_account",...}
# Opción B: archivo (default secrets/google-key.json)
GEE_SERVICE_ACCOUNT_PATH=secrets/google-key.json
# GEE_EVALUATE_TIMEOUT_MS=30000

# Caché de análisis GEE (días)
# ANALISIS_TTL_DAYS=365
```

## Desarrollo local

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar back/.env.local (ver sección anterior)

# 3. Aplicar migraciones y generar cliente Prisma
npx prisma migrate deploy
npx prisma generate

# 4. (Opcional) Colocar service account GEE en secrets/google-key.json

# 5. Servidor de desarrollo (hot reload)
npm run start:dev
```

La API queda en **http://localhost:3001/api**.

Levantar el front en paralelo (`../front/`, puerto 3000) con `NEXT_PUBLIC_API_URL=http://localhost:3001`.

### Scripts de verificación

```bash
npm run verify:sentinel   # OAuth + Process API contra un polígono de prueba
npm run verify:gee        # Inicialización y smoke test de Earth Engine
```

### Verificación habitual

```bash
npx tsc --noEmit
npm run lint
npm run build
npm run test
```

> **Build de producción:** `tsconfig.build.json` fuerza `incremental: false` para evitar `dist` incompleto tras limpiar el directorio de salida.

## Scripts npm

| Comando | Descripción |
|---------|-------------|
| `npm run start:dev` | Desarrollo con `ts-node-dev` y recarga |
| `npm run build` | Compilar a `dist/` |
| `npm run start:prod` | Servir build (`node dist/main`) |
| `npm run lint` | ESLint |
| `npm run test` | Tests unitarios (Jest) |
| `npm run test:e2e` | Tests end-to-end (supertest) |
| `npm run verify:sentinel` | Diagnóstico Sentinel Hub |
| `npm run verify:gee` | Diagnóstico Google Earth Engine |

## Base de datos

- **ORM:** Prisma 6 contra Supabase PostgreSQL.
- **Pooler:** `DATABASE_URL` usa el pooler (6543) con `pgbouncer=true` para queries en runtime.
- **Migraciones:** `DIRECT_URL` apunta al puerto 5432 para `prisma migrate`.
- **PostGIS:** la tabla `incendios` usa `geometry(Point, 4326)`; las queries espaciales van por SQL raw, no por el cliente Prisma estándar.

Modelos principales: `User`, `Establecimiento`, `Lote`, `AnalisisLote`, `Reporte`, `Incendio`.

## Seguridad

- Credenciales en `.env.local` y `secrets/` — nunca en el repositorio.
- CORS restringido a orígenes conocidos (`localhost:3000`, producción en Vercel).
- Helmet habilitado (CSP desactivado: API JSON pura).
- Validación estricta de DTOs (`whitelist`, `forbidNonWhitelisted`).
- URLs de Storage firmadas con vida corta; el service role nunca se expone al cliente.

## Relación con el frontend

- El front consume esta API vía `src/services/apiService.ts` con el JWT de Supabase.
- La spec de producto vive en `../front/MVP_SPEC.md` (fuente de verdad de alcance).
- Cambios de contrato que afecten al front deben documentarse en `HISTORIAL.md`.

## Documentación del equipo

Archivos de trabajo internos **no incluidos en el repositorio** (ver `.gitignore`):

| Archivo | Propósito |
|---------|-----------|
| `HISTORIAL.md` | Bitácora de decisiones entre sesiones |
| `../front/MVP_SPEC.md` | Alcance y arquitectura del MVP |
| `.cursor/rules/` | Reglas de contexto y convenciones en Cursor |

Al retomar el trabajo: leer entradas recientes de `HISTORIAL.md` y, si aplica, `../front/MVP_SPEC.md`. Tras cambios importantes, documentar en el historial según la regla `historial-proyecto`.

## Licencia

Proyecto privado. Todos los derechos reservados.
