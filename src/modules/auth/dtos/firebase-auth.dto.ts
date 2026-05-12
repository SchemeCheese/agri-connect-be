import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { UserRole } from '@prisma/client';

export class FirebaseAuthDto {
  /**
   * Firebase ID token obtained from the client SDK after a successful
   * Google (or any Firebase-supported) sign-in.
   */
  @IsString()
  @IsNotEmpty({ message: 'Firebase ID token không được để trống.' })
  idToken: string;

  /**
   * Desired role for the account when it is created for the first time.
   * Ignored for existing accounts.
   */
  @IsOptional()
  @IsEnum(UserRole, { message: 'Quyền hạn không hợp lệ (BUYER, SELLER).' })
  role?: UserRole;
}
