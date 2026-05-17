import { IsNumber, IsOptional, Min, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Restock body — caller supplies EITHER:
 *   - `stock`: absolute new stock level (replaces current)
 *   - `add`:   delta to add to current stock
 * At least one is required; if both are sent, `stock` wins.
 */
export class RestockDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stock?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  add?: number;

  // Force at-least-one with a custom check
  @ValidateIf((o) => o.stock === undefined && o.add === undefined)
  @IsNumber({}, { message: 'Cần truyền stock hoặc add' })
  _atLeastOne?: never;
}
