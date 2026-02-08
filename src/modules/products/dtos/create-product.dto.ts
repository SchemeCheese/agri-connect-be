import { IsNotEmpty, IsString, IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProductDto {
  @IsNotEmpty({ message: 'Tên sản phẩm không được để trống' })
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNotEmpty()
  @Type(() => Number) // Chuyển đổi từ string sang number nếu cần
  @IsNumber()
  @Min(0)
  reference_price: number;

  @IsNotEmpty()
  @IsString()
  unit: string; // Ví dụ: kg, tạ, tấn

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stock_quantity: number;

  @IsNotEmpty()
  @Type(() => Number) // category_id trong DB là Int
  @IsNumber()
  category_id: number;

  @IsOptional()
  @IsString()
  location?: string;
  
  @IsOptional()
  @IsString()
  certification?: string; // VietGAP, GlobalGAP...
}