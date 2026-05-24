import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Inyecta el `AuthenticatedUser` que el `SupabaseAuthGuard` colocó en
 * `request.user`. Si se pasa una clave, devuelve sólo esa propiedad
 * (`@CurrentUser('id') userId: string`).
 *
 * Debe usarse SIEMPRE en rutas protegidas por `SupabaseAuthGuard`; en caso
 * contrario `request.user` será `undefined` y este decorador devolverá lo mismo.
 */
export const CurrentUser = createParamDecorator(
  <K extends keyof AuthenticatedUser>(
    key: K | undefined,
    ctx: ExecutionContext,
  ): AuthenticatedUser | AuthenticatedUser[K] | undefined => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    if (!request.user) {
      return undefined;
    }

    return key ? request.user[key] : request.user;
  },
);
