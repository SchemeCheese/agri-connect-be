import { IsString, IsArray, ValidateNested, IsNumber, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';

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

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}