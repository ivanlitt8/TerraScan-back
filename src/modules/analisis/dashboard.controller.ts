import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { DashboardService } from './dashboard.service';
import type { DashboardResponse } from './types/dashboard.response';

/**
 * Endpoint agregador del dashboard gerencial (`/api/analisis/dashboard`).
 *
 * Consolida KPIs, matriz de riesgo hídrico y monitor de incendios del usuario
 * autenticado usando **solo** datos locales (DB + caché GEE + PostGIS), sin
 * llamadas en vivo a Google Earth Engine ni Sentinel Hub: la pantalla debe
 * abrir en milisegundos.
 */
@Controller('analisis')
@UseGuards(SupabaseAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * `GET /api/analisis/dashboard`
   *
   * Devuelve el resumen del dashboard para el `userId` del JWT. Si el usuario
   * no tiene lotes, responde una estructura vacía limpia (no 404/500).
   *
   * `Cache-Control: private, max-age=60` — el dato es semi-dinámico (depende
   * de cargas de FIRMS y de recálculos GEE puntuales); 60 s de caché cliente
   * evitan refetch al rebotar entre pestañas sin servir datos rancios.
   */
  @Get('dashboard')
  @Header('Cache-Control', 'private, max-age=60')
  async getDashboard(
    @CurrentUser('id') userId: string,
  ): Promise<DashboardResponse> {
    return this.dashboardService.getDashboard(userId);
  }
}
