import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import type {
  AuthenticatedUser,
  SupabaseJwtPayload,
} from '../types/authenticated-user';

/**
 * Guard para Nest que valida un Access Token emitido por Supabase Auth contra
 * el JWKS público del proyecto (`/.well-known/jwks.json`).
 *
 * Reglas:
 * - Espera el header `Authorization: Bearer <jwt>`. Cualquier desviación
 *   (header ausente, esquema distinto, token vacío) responde `401`.
 * - Verifica firma (RS256 o ES256), expiración, `iss` (`${SUPABASE_URL}/auth/v1`)
 *   y `aud` (`authenticated`).
 * - Si todo OK, adjunta `request.user = { id: payload.sub, email: payload.email }`.
 *
 * El `JWKSet` remoto se cachea en memoria con TTL interno (`jose` lo maneja);
 * sólo se inicializa la primera vez que llega una request, y se rotará solo
 * si Supabase publica una clave nueva con un `kid` desconocido.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);
  private jwks: JWTVerifyGetKey | null = null;
  private issuer: string | null = null;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    const token = this.extractBearerToken(request);
    const payload = await this.verifyToken(token);

    if (!payload.sub) {
      throw new UnauthorizedException(
        'Token sin identificador de usuario (`sub`).',
      );
    }

    request.user = {
      id: payload.sub,
      email: payload.email,
    };

    return true;
  }

  private extractBearerToken(request: Request): string {
    const header = request.headers.authorization;

    if (!header) {
      throw new UnauthorizedException('Falta el header Authorization.');
    }

    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException(
        'Authorization mal formado. Esperado: "Bearer <token>".',
      );
    }

    return token.trim();
  }

  private async verifyToken(token: string): Promise<SupabaseJwtPayload> {
    const { jwks, issuer } = this.getJwksAndIssuer();

    try {
      const { payload } = await jwtVerify<SupabaseJwtPayload>(token, jwks, {
        algorithms: ['RS256', 'ES256'],
        audience: 'authenticated',
        issuer,
      });

      return payload;
    } catch (cause) {
      const reason =
        cause instanceof joseErrors.JOSEError
          ? `${cause.code}: ${cause.message}`
          : cause instanceof Error
            ? cause.message
            : String(cause);

      this.logger.warn(`JWT inválido: ${reason}`);
      throw new UnauthorizedException('Token inválido o expirado.');
    }
  }

  private getJwksAndIssuer(): { jwks: JWTVerifyGetKey; issuer: string } {
    if (this.jwks && this.issuer) {
      return { jwks: this.jwks, issuer: this.issuer };
    }

    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
    if (!supabaseUrl) {
      this.logger.error(
        'SUPABASE_URL no está definido. No se puede construir el JWKS.',
      );
      throw new UnauthorizedException('Servidor mal configurado.');
    }

    const issuer = `${supabaseUrl}/auth/v1`;
    const jwksUrl = new URL(`${issuer}/.well-known/jwks.json`);
    this.jwks = createRemoteJWKSet(jwksUrl);
    this.issuer = issuer;

    this.logger.log(`JWKS configurado contra ${jwksUrl.toString()}`);
    return { jwks: this.jwks, issuer };
  }
}
