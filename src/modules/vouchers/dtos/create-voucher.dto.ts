import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsNumber,
  Min,
  IsDateString,
  IsOptional,
  IsBoolean,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DiscountType } from '@prisma/client';

export class CreateVoucherDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code: string;

  @IsEnum(DiscountType)
  discount_type: DiscountType;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  discount_value: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  min_order_value: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  max_discount_amount: number;

  @IsDateString()
  valid_from: string;

  @IsDateString()
  valid_to: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  usage_limit?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
