import { IsEmail, IsNotEmpty, IsString, MinLength, IsBoolean, IsOptional, Matches, IsIn, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'Email không hợp lệ' })
  @IsNotEmpty()
  email: string;

  @IsString()
  @MinLength(8, { message: 'Mật khẩu phải có ít nhất 8 ký tự' })
  @MaxLength(72, { message: 'Mật khẩu tối đa 72 ký tự (giới hạn bcrypt)' })
  // Yêu cầu: ít nhất 1 chữ hoa, 1 chữ thường, 1 chữ số. Ký tự đặc biệt tùy chọn.
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/, {
    message: 'Mật khẩu cần ít nhất 1 chữ hoa, 1 chữ thường và 1 chữ số',
  })
  password: string;

  @IsString()
  @IsNotEmpty({ message: 'Họ tên không được để trống' })
  @MinLength(2)
  @MaxLength(80)
  full_name: string;

  // ─── Vai trò — chấp nhận 1 trong 2 cách: ────────────────────────────────
  // 1. Truyền `role: 'BUYER' | 'SELLER'` (alias đơn giản cho FE)
  // 2. Truyền `is_buyer` / `is_seller` boolean (multi-role native)
  // Service sẽ map về boolean flags. Default = BUYER nếu không truyền gì.
  @IsOptional()
  @IsString()
  @IsIn(['BUYER', 'SELLER'])
  role?: 'BUYER' | 'SELLER';

  @IsOptional()
  @IsBoolean()
  is_buyer?: boolean;

  @IsOptional()
  @IsBoolean()
  is_seller?: boolean;
}
