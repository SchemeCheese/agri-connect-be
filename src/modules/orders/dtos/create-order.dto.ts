import { IsString, IsArray, ValidateNested, IsNumber, IsNotEmpty, IsEnum, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentMethod } from '@prisma/client';

class OrderItemDto {
  @IsString()
  @IsNotEmpty()
  product_id: string;

  @IsNumber()
  quantity: number;

  @IsNumber()
  price: number; // Giá tại thời điểm mua
}

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  shipping_address: string;

  @IsEnum(PaymentMethod)
  payment_method: PaymentMethod; // COD | QR_CODE | MOMO | ZALOPAY

  @IsString()
  @IsOptional()
  note?: string; // Ghi chú đơn hàng

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}