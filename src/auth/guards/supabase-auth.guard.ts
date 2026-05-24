import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type {
  AuthenticatedUser,
  SupabaseJwtPayload,
} from '../types/authenticated-user';

/**
 * Guard para Nest que valida un Access Token emitido por Supabase Auth.
 *
 * Reglas:
 * - Espera el header `Authorization: Bearer <jwt>`. Cualquier desviación
 *   (header ausente, esquema distinto, token vacío) responde `401`.
 * - Verifica firma HS256 contra `SUPABASE_JWT_SECRET`, expiración y, si está
 *   configurado, el `iss` (`${SUPABASE_URL}/auth/v1`) y el `aud` (`authenticated`).
 * - Si todo OK, adjunta `request.user = { id: payload.sub, email: payload.email }`.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);

  constructor(private readonly jwtService: JwtService) {}

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
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      this.logger.error(
        'SUPABASE_JWT_SECRET no está definido. No se puede validar el JWT.',
      );
      throw new UnauthorizedException('Servidor mal configurado.');
    }

    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
    const issuer = supabaseUrl ? `${supabaseUrl}/auth/v1` : undefined;

    try {
      return await this.jwtService.verifyAsync<SupabaseJwtPayload>(token, {
        secret,
        algorithms: ['HS256'],
        audience: 'authenticated',
        ...(issuer ? { issuer } : {}),
      });
    } catch (cause) {
      this.logger.warn(
        `JWT inválido: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      throw new UnauthorizedException('Token inválido o expirado.');
    }
  }
}
