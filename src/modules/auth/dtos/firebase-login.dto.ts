import { IsString, IsBoolean, IsOptional } from 'class-validator';

export class FirebaseLoginDto {
  @IsString()
  idToken: string;

  @IsOptional()
  @IsBoolean()
  is_buyer?: boolean;

  @IsOptional()
  @IsBoolean()
  is_seller?: boolean;
}
