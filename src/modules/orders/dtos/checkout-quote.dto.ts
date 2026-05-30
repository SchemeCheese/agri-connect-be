import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CheckoutQuoteDto {
  @IsString()
  @IsNotEmpty()
  quoteId: string;

  @IsIn(['COD', 'MOMO'])
  paymentMethod: 'COD' | 'MOMO';

  @IsOptional()
  @IsString()
  shippingAddress?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  note?: string;
}