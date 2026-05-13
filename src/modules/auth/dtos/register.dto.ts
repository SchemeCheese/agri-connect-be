import { IsEmail, IsNotEmpty, IsString, MinLength, IsBoolean, IsOptional } from 'class-validator';

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

  @IsOptional()
  @IsBoolean()
  is_buyer?: boolean;

  @IsOptional()
  @IsBoolean()
  is_seller?: boolean;
}
