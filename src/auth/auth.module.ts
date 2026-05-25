import { Module } from '@nestjs/common';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard';

/**
 * Módulo de autenticación.
 *
 * El `SupabaseAuthGuard` valida los JWT contra el JWKS público de Supabase
 * usando `jose`; no necesita un `JwtModule` de Nest porque la verificación
 * incluye descarga y cacheo de claves públicas de forma autónoma.
 */
@Module({
  providers: [SupabaseAuthGuard],
  exports: [SupabaseAuthGuard],
})
export class AuthModule {}
