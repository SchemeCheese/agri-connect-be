import { IsEnum, IsNotEmpty, IsString } from 'class-validator';

export enum GoogleAuthRole {
  BUYER = 'BUYER',
  SELLER = 'SELLER',
}

export class GoogleRegisterDto {
  @IsString()
  @IsNotEmpty()
  idToken: string;

  @IsEnum(GoogleAuthRole)
  @IsNotEmpty()
  role: GoogleAuthRole;
}

export class GoogleLoginDto {
  @IsString()
  @IsNotEmpty()
  idToken: string;

  @IsEnum(GoogleAuthRole)
  role?: GoogleAuthRole; // Optional: client may send selected role when multiple exist
}
