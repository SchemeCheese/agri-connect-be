import { IsString, IsNotEmpty, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ValidateVoucherDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @IsNotEmpty()
  seller_id: string;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  order_total: number;
}
