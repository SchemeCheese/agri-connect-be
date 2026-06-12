import { IsBoolean, IsNotEmpty, IsString, IsNumber, IsOptional, Min } from 'class-validator';
import { Type, Transform } from 'class-transformer';

// Multipart submissions deliver empty inputs as '' instead of omitting them — collapse to
// undefined so @IsOptional/@Type(() => Number) work the same as a JSON payload would.
const emptyStringToUndefined = ({ value }: { value: unknown }) => (value === '' ? undefined : value);
const multipartBoolean = ({ value }: { value: unknown }) =>
  value === true || value === 'true';

export class CreateProductDto {
  @IsNotEmpty({ message: 'Tên sản phẩm không được để trống' })
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Transform(emptyStringToUndefined)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  reference_price?: number;

  @IsNotEmpty()
  @IsString()
  unit: string;

  @IsOptional()
  @Transform(emptyStringToUndefined)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stock_quantity?: number;

  @IsOptional()
  @Transform(emptyStringToUndefined)
  @Type(() => Number)
  @IsNumber()
  category_id?: number;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  certification?: string;

  @IsOptional()
  @Transform(emptyStringToUndefined)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  min_negotiation_qty?: number;

  @IsOptional()
  @IsString({ each: true })
  image_urls?: string[];

  @IsOptional()
  @IsString({ each: true })
  retained_image_urls?: string[];

  @IsOptional()
  @Transform(multipartBoolean)
  @IsBoolean()
  replace_images?: boolean;
}
