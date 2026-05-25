import { IsNotEmpty, IsNumber, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class SendNegotiationQuoteDto {
  @IsString()
  @IsNotEmpty()
  conversationId: string;

  @IsString()
  @IsNotEmpty()
  productId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  productName: string;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  quantity: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  price: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  unit: string;
}
