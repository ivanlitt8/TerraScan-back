import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user';
import { AnalyzeLoteDto } from './dto/analyze-lote.dto';
import { LoteService } from './lote.service';

@Controller('lotes')
@UseGuards(SupabaseAuthGuard)
export class LoteController {
  constructor(private readonly loteService: LoteService) {}

  @Post('analyze')
  @HttpCode(HttpStatus.CREATED)
  analyze(@Body() dto: AnalyzeLoteDto, @CurrentUser() user: AuthenticatedUser) {
    return this.loteService.analyze(dto, user);
  }

  @Get()
  findAll(@CurrentUser('id') userId: string) {
    return this.loteService.findAllForUser(userId);
  }

  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.loteService.findOneForUser(id, userId);
  }
}
