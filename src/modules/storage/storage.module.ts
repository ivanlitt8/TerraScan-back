import { Global, Module } from '@nestjs/common';
import { SupabaseStorageService } from './storage.service';

/**
 * Módulo global de acceso a Supabase Storage. Es `@Global()` porque el cliente
 * de Storage es único (server-to-server con service role) y cualquier feature
 * que necesite firmar/subir archivos puede inyectarlo sin reimportar el módulo.
 */
@Global()
@Module({
  providers: [SupabaseStorageService],
  exports: [SupabaseStorageService],
})
export class StorageModule {}
