import { IsString, IsOptional, MaxLength } from 'class-validator';

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
}
