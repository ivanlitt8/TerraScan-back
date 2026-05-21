import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AnalyzeLoteDto } from './dto/analyze-lote.dto';
import { LoteService } from './lote.service';

@Controller('lotes')
export class LoteController {
  constructor(private readonly loteService: LoteService) {}

  @Post('analyze')
  @HttpCode(HttpStatus.CREATED)
  analyze(@Body() dto: AnalyzeLoteDto) {
    return this.loteService.analyze(dto);
  }
}
