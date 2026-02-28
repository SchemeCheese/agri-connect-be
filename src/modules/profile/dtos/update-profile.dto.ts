import { IsString, IsOptional, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  full_name?: string;

  @IsOptional()
  @IsString()
  phone_number?: string;

  // Profile (shop info — dành cho SELLER, BUYER cũng có thể điền)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  store_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
