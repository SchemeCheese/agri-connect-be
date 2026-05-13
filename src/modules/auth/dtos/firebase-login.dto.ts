import { IsOptional, IsString, IsIn } from 'class-validator';

export class FirebaseLoginDto {
  @IsString()
  idToken: string;

  @IsOptional()
  @IsString()
  @IsIn(['BUYER', 'SELLER', 'ADMIN'])
  role?: 'BUYER' | 'SELLER' | 'ADMIN';
}