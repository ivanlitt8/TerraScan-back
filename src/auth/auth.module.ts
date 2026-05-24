import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard';

/**
 * Módulo de autenticación.
 *
 * Configura `JwtModule` "vacío": la verificación inyecta `secret`, `algorithms`,
 * `audience` e `issuer` en cada llamada del guard, leyéndolos de
 * `SUPABASE_JWT_SECRET` y `SUPABASE_URL` en runtime. Así evitamos que el
 * módulo se rehúse a arrancar si las env vars todavía no están seteadas
 * (por ejemplo, durante un build en CI sin secrets) y mantenemos el
 * comportamiento "fail-loud" sólo cuando una request realmente llega.
 */
@Module({
  imports: [JwtModule.register({})],
  providers: [SupabaseAuthGuard],
  exports: [SupabaseAuthGuard, JwtModule],
})
export class AuthModule {}
