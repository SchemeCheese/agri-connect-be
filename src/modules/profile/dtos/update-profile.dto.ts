import { IsString, IsOptional, MaxLength, IsNumber, Min, Max } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  full_name?: string;

  @IsOptional()
  @IsString()
  phone_number?: string;

  // Shop info — buyer cũng có thể điền
  @IsOptional()
  @IsString()
  @MaxLength(100)
  store_name?: string;

  // Alias cho address (tương thích với FE dùng store_address)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  store_address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  // Alias dành cho seller (store_description)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  store_description?: string;

  // ─── Shop location / Google Maps ──────────────────────────────────────
  @IsOptional()
  @IsString()
  @MaxLength(150)
  shop_location_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  shop_google_maps_url?: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' || value === null ? undefined : value))
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  shop_latitude?: number;

  @IsOptional()
  @Transform(({ value }) => (value === '' || value === null ? undefined : value))
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  shop_longitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  place_id?: string;
}
