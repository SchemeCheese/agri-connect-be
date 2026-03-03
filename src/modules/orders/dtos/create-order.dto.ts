import {
  IsString,
  IsArray,
  ValidateNested,
  IsNumber,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  ArrayMinSize,
} from 'class-validator';
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

class SellerOrderDto {
  /** ID của shop (bắt buộc) */
  @IsString()
  @IsNotEmpty()
  seller_id: string;

  /** Danh sách sản phẩm của shop này */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  /** Mã giảm giá riêng của shop này (tùy chọn) */
  @IsString()
  @IsOptional()
  voucher_code?: string;
}

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  shipping_address: string;

  @IsEnum(PaymentMethod)
  payment_method: PaymentMethod;

  @IsString()
  @IsOptional()
  note?: string;

  /**
   * Mọi shop trong giỏ hàng — mỗi shop là 1 phần tử.
   * Voucher được apply riêng cho từng shop.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SellerOrderDto)
  seller_orders: SellerOrderDto[];
}