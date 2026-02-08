import { IsEmail, IsNotEmpty, IsString, MinLength, IsEnum } from 'class-validator';
import { UserRole } from '@prisma/client';

export class RegisterDto {
  @IsEmail({}, { message: 'Email không hợp lệ' })
  @IsNotEmpty()
  email: string;

  @IsString()
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  password: string;

  @IsString()
  @IsNotEmpty({ message: 'Họ tên không được để trống' })
  full_name: string;

  @IsEnum(UserRole, { message: 'Quyền hạn không hợp lệ (BUYER, SELLER)' })
  role: UserRole;
}