/**
 * Forma de cada detección de incendio en la respuesta del endpoint
 * `GET /api/lotes/:id/incendios`.
 *
 * El frontend recibe este shape sin necesidad de conocer los campos
 * crudos de NASA FIRMS (que tienen nombres técnicos y son verbosos).
 * Renombramos a español-corto para que la UI no tenga que mapear.
 *
 * Una "detección" representa **un píxel térmico de 375 m × 375 m** que
 * VIIRS (sensor a bordo de SNPP / NOAA-20) clasificó como fuente de
 * calor en una pasada del satélite. No es un incendio en sí: un mismo
 * incendio puede generar decenas o cientos de detecciones distribuidas
 * en el área y en el tiempo. La UI suele agruparlas por fecha.
 */
export interface IncendioResponse {
  /** ID interno (autoincrement de Postgres). Útil como key en React. */
  id: number;
  /** Latitud del centro del píxel térmico, EPSG:4326. */
  latitude: number;
  /** Longitud del centro del píxel térmico, EPSG:4326. */
  longitude: number;
  /**
   * Fecha del paso del satélite en ISO 8601 (`YYYY-MM-DD`). FIRMS guarda
   * solo la fecha del paso; la hora vive en `hora`.
   */
  fecha: string;
  /**
   * Hora UTC del paso, formato `HHMM` (e.g. `"0515"`). `null` si el
   * registro no la trae (caso raro en VIIRS pero el campo es opcional).
   */
  hora: string | null;
  /**
   * Confianza de la detección — VIIRS usa un valor categórico:
   *  - `"l"` → low
   *  - `"n"` → nominal
   *  - `"h"` → high
   *
   * El frontend puede mapearlo a una etiqueta humana o filtrar por nivel.
   */
  confianza: string | null;
  /**
   * **Fire Radiative Power** en MW (megavatios). Proxy de la "intensidad"
   * de la fuente de calor: incendios chicos suelen estar < 5 MW, focos
   * intensos > 50 MW. `null` cuando FIRMS no la calculó (e.g. pixel
   * saturado por sol especular).
   */
  frp: number | null;
  /**
   * Brillo del píxel en la banda I-4 (4 µm), en Kelvin. Es la temperatura
   * de brillo aparente del píxel. Valores típicos de incendios: 320 K+.
   */
  brillo: number | null;
  /**
   * Temperatura de fondo en la banda I-5 (11 µm), en Kelvin. Sirve para
   * descartar falsos positivos: si `brillo - bright_t31` es chico, no
   * había contraste térmico (el "fuego" puede ser un techo metálico
   * caliente, por ejemplo).
   */
  brightT31: number | null;
  /** `"D"` (día) o `"N"` (noche). Crítico para interpretar la confianza. */
  daynight: string | null;
  /** `"N20"` (NOAA-20) o `"SNPP"` (Suomi-NPP). */
  satelite: string;
  /**
   * Clasificación FIRMS del tipo de fuente:
   *  - `0` → vegetation fire (incendio forestal / pastizal). El caso de uso.
   *  - `1` → active volcano.
   *  - `2` → other static land source (industria, flares).
   *  - `3` → offshore (plataformas marinas).
   *
   * `null` en SNPP histórico (el producto VIIRS legacy no lo computaba).
   */
  tipo: number | null;
}
