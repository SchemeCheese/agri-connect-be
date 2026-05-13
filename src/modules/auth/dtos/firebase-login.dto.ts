import { IsEnum, IsString, IsOptional } from 'class-validator';

export enum GoogleAuthRole {
  BUYER = 'BUYER',
  SELLER = 'SELLER',
}

export class FirebaseLoginDto {
  @IsString()
  idToken: string;

  @IsOptional()
  @IsEnum(GoogleAuthRole)
  role?: GoogleAuthRole;
}
