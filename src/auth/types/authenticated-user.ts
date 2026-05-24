/**
 * Forma del usuario autenticado que el `SupabaseAuthGuard` adjunta a `request.user`.
 *
 * `id` es el `sub` del JWT de Supabase (UUID de `auth.users`); `email` viene del
 * mismo payload y puede no estar presente en flujos OAuth en los que el provider
 * no comparta correo, por eso se tipa como opcional.
 */
export interface AuthenticatedUser {
  id: string;
  email?: string;
}

/**
 * Payload mínimo que esperamos de un JWT emitido por Supabase Auth.
 *
 * Supabase agrega más campos (`app_metadata`, `user_metadata`, `role`, `phone`,
 * etc.); acá sólo declaramos los que el guard necesita validar o reexportar.
 */
export interface SupabaseJwtPayload {
  sub: string;
  email?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  iat?: number;
  role?: string;
}
