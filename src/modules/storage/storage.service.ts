import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  createClient,
  type SupabaseClient,
} from '@supabase/supabase-js';

/**
 * Nombre por defecto del bucket privado de Supabase Storage donde viven los
 * PDFs de reportes. Se puede sobreescribir con `SUPABASE_STORAGE_BUCKET`.
 */
const DEFAULT_BUCKET = 'reportes';

/**
 * Expiración por defecto (segundos) de las URLs firmadas. Corta a propósito:
 * la URL sólo necesita vivir lo justo para que el browser dispare la descarga.
 */
const DEFAULT_SIGNED_URL_TTL_SECONDS = 60;

/**
 * Acceso server-side a Supabase Storage.
 *
 * Usa el **service role key** (NUNCA expuesto al cliente) para firmar URLs de
 * descarga sobre un bucket privado. El frontend nunca toca Storage directo: el
 * backend valida ownership del reporte y entrega una URL firmada de vida corta.
 *
 * El cliente se inicializa de forma perezosa (primera vez que se usa) para que
 * un `.env.local` incompleto no tumbe el arranque de toda la app — sólo fallan
 * los endpoints que realmente necesitan Storage.
 */
@Injectable()
export class SupabaseStorageService {
  private readonly logger = new Logger(SupabaseStorageService.name);
  private client: SupabaseClient | null = null;

  /** Bucket activo (configurable por env). */
  get bucket(): string {
    return process.env.SUPABASE_STORAGE_BUCKET?.trim() || DEFAULT_BUCKET;
  }

  /**
   * Genera una URL firmada de descarga para un objeto del bucket privado.
   *
   * @param path Path relativo del archivo dentro del bucket (lo que se guarda
   *   en `Reporte.urlStorage`).
   * @param expiresInSeconds Vida de la URL en segundos (default 60).
   */
  async createSignedUrl(
    path: string,
    expiresInSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
  ): Promise<{ url: string; expiresIn: number }> {
    const client = this.getClient();

    const { data, error } = await client.storage
      .from(this.bucket)
      .createSignedUrl(path, expiresInSeconds);

    if (error || !data?.signedUrl) {
      this.logger.error(
        `No se pudo firmar la URL para "${path}" en bucket "${this.bucket}": ${
          error?.message ?? 'respuesta vacía'
        }`,
      );
      throw new InternalServerErrorException(
        'No se pudo generar el enlace de descarga del reporte.',
      );
    }

    return { url: data.signedUrl, expiresIn: expiresInSeconds };
  }

  /**
   * Devuelve (y cachea) el cliente de Supabase con el service role key.
   * Lanza si faltan credenciales: es un error de configuración del servidor,
   * no del cliente HTTP.
   */
  private getClient(): SupabaseClient {
    if (this.client) {
      return this.client;
    }

    const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceRoleKey) {
      this.logger.error(
        'Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY: no se puede inicializar Supabase Storage.',
      );
      throw new InternalServerErrorException(
        'Servidor mal configurado para descargas de reportes.',
      );
    }

    // `persistSession: false`: es un cliente server-to-server sin contexto de
    // usuario, no debe escribir/leer sesiones en disco.
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    this.logger.log(
      `Supabase Storage inicializado (bucket por defecto: "${this.bucket}")`,
    );
    return this.client;
  }
}
