import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  Equals,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class GeoJSONPolygonGeometryDto {
  @Equals('Polygon')
  type!: 'Polygon';

  @IsArray()
  @ArrayMinSize(1)
  coordinates!: number[][][];
}

export class PoligonoGeoJSONDto {
  @Equals('Feature')
  type!: 'Feature';

  @ValidateNested()
  @Type(() => GeoJSONPolygonGeometryDto)
  geometry!: GeoJSONPolygonGeometryDto;

  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;
}

export class AnalyzeLoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombre!: string;

  @ValidateNested()
  @Type(() => PoligonoGeoJSONDto)
  poligonoGeoJSON!: PoligonoGeoJSONDto;
}
