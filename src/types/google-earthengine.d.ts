/**
 * Declaración de tipos mínima para `@google/earthengine`.
 *
 * El paquete oficial (v1.7.x) NO publica tipos y es CommonJS
 * (`build/main.js`). En vez de tipar toda la API (cientos de algoritmos
 * server-side), declaramos sólo la superficie que el backend consume hoy:
 * autenticación, init y el patrón builder que usa la smoke test
 * (`ee.Image(...).reduceRegion(...).get(...).evaluate(...)`).
 *
 * Todo se agrupa bajo `namespace ee` y se exporta con `export = ee` para
 * que `import * as ee from '@google/earthengine'` exponga tanto los
 * valores (`ee.Image`, `ee.Geometry.Point`) como los tipos
 * (`ee.ComputedObject`, `ee.EEPrivateKey`). Lo no declarado cae en `any`
 * (`noImplicitAny: false`), así que ampliar el uso no rompe el build.
 *
 * Referencia: https://developers.google.com/earth-engine/apidocs
 */
declare module '@google/earthengine' {
  namespace ee {
    /**
     * Credenciales del Service Account (forma del `google-key.json` que
     * exporta Google Cloud). Sólo `private_key` y `client_email` son
     * imprescindibles para `authenticateViaPrivateKey`.
     */
    interface EEPrivateKey {
      type?: string;
      project_id?: string;
      private_key: string;
      client_email: string;
      [key: string]: unknown;
    }

    /**
     * Objeto computado server-side. Cualquier valor derivado en GEE se
     * resuelve trayéndolo al cliente con `evaluate` (async, no bloqueante)
     * o `getInfo` (sync/bloqueante — evitar en server).
     */
    interface ComputedObject {
      evaluate(callback: (result: any, error?: string) => void): void;
      getInfo(callback?: (result: any, error?: string) => void): any;
      get(key: string): ComputedObject;
    }

    interface Dictionary extends ComputedObject {
      get(key: string): ComputedObject;
    }

    interface Geometry extends ComputedObject {}

    interface Reducer {}

    interface Filter {}

    interface Feature extends ComputedObject {}

    interface ReduceRegionParams {
      reducer: Reducer;
      geometry: Geometry;
      scale?: number;
      crs?: string;
      bestEffort?: boolean;
      maxPixels?: number;
    }

    interface Image extends ComputedObject {
      reduceRegion(params: ReduceRegionParams): Dictionary;
      select(...args: any[]): Image;
      set(key: string, value: unknown): Image;
    }

    interface ImageCollection extends ComputedObject {
      filterBounds(geometry: Geometry): ImageCollection;
      filterDate(start: unknown, end: unknown): ImageCollection;
      filter(filter: Filter): ImageCollection;
      map(fn: (image: Image) => Image | ComputedObject): ImageCollection;
      select(...args: any[]): ImageCollection;
      size(): ComputedObject;
      first(): Image;
      aggregate_array(property: string): ComputedObject;
      toList(count: number, offset?: number): ComputedObject;
    }

    namespace data {
      /**
       * Autentica usando la private key de un Service Account (flujo no
       * interactivo, recomendado para backends).
       *
       * @param privateKey Objeto parseado del `google-key.json`.
       * @param success    Callback sin args cuando el token se obtuvo OK.
       * @param error      Callback `(message)` si la autenticación falló.
       * @param extraScopes Scopes OAuth adicionales (normalmente `null`).
       */
      function authenticateViaPrivateKey(
        privateKey: EEPrivateKey,
        success?: () => void,
        error?: (message: string) => void,
        extraScopes?: string[] | null,
      ): void;
    }

    /**
     * Inicializa la librería contra los endpoints de EE. Debe llamarse
     * después de autenticar y antes de cualquier operación.
     */
    function initialize(
      baseUrl?: string | null,
      tileUrl?: string | null,
      success?: () => void,
      error?: (message: string) => void,
      xsrfToken?: string | null,
      project?: string | null,
    ): void;

    function reset(): void;

    function Image(args?: unknown): Image;

    function ImageCollection(args?: unknown): ImageCollection;

    function Dictionary(properties: Record<string, unknown>): Dictionary;

    function Feature(geometry: unknown, properties?: Record<string, unknown>): Feature;

    // `Geometry` es a la vez tipo (interface, arriba), constructor callable
    // (`ee.Geometry(geojson)`) y namespace (`ee.Geometry.Point`). Las tres
    // declaraciones se fusionan en un único símbolo.
    function Geometry(
      geojson: unknown,
      proj?: unknown,
      geodesic?: boolean,
    ): Geometry;

    namespace Geometry {
      function Point(coords: [number, number], proj?: string): Geometry;
    }

    namespace Reducer {
      function first(): Reducer;
      function mean(): Reducer;
      function max(): Reducer;
    }

    namespace Filter {
      function eq(name: string, value: unknown): Filter;
    }
  }

  export = ee;
}
