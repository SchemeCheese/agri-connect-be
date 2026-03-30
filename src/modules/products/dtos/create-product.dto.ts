import { IsNotEmpty, IsString, IsNumber, IsOptional, Min } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class CreateProductDto {
  @IsNotEmpty({ message: 'Tên sản phẩm không được để trống' })
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Transform(({ value }) => value === '' ? undefined : value)
  @Type(() => Number) // Chuyển đổi từ string sang number nếu cần
  @IsNumber()
  @Min(0)
  reference_price?: number;

  @IsNotEmpty()
  @IsString()
  unit: string; // Ví dụ: kg, tạ, tấn

  @IsOptional()
  @Transform(({ value }) => value === '' ? undefined : value)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stock_quantity?: number;

  @IsOptional()
  @Transform(({ value }) => value === '' ? undefined : value)
  @Type(() => Number) // category_id trong DB là Int
  @IsNumber()
  category_id?: number;

  @IsOptional()
  @IsString()
  location?: string;
  
  @IsOptional()
  @IsString()
  certification?: string; // VietGAP, GlobalGAP...

  @IsOptional()
  @Transform(({ value }) => value === '' ? undefined : value)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  min_negotiation_qty?: number; // null = không cho phép thương lượng; > 0 = số kg tối thiểu

  // ----- Alias fields to accept existing FE payload -----
  @IsOptional()
  @Transform(({ value }) => value === '' ? undefined : value)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price?: number; // FE sends price

  @IsOptional()
  @Transform(({ value }) => value === '' ? undefined : value)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stock?: number; // FE sends stock

  @IsOptional()
  @IsString()
  category?: string; // FE sends slug/category name

  @IsOptional()
  @IsString()
  origin?: string; // FE sends origin instead of location

  @IsOptional()
  @IsString({ each: true })
  image_urls?: string[]; // optional pre-uploaded URLs
}