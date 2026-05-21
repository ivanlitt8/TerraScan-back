import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
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

  @Get()
  findAll() {
    return this.loteService.findAllForDemoUser();
  }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.loteService.findOne(id);
  }
}
