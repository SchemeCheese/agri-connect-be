import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export type SelectableRole = 'BUYER' | 'SELLER' | 'ADMIN';

// Dùng cho POST /auth/select-role (login-time, kèm tempToken).
export class SelectRoleDto {
  @IsString()
  @IsNotEmpty()
  tempToken: string;

  @IsString()
  @IsIn(['BUYER', 'SELLER', 'ADMIN'])
  role: SelectableRole;
}

// Dùng cho POST /auth/switch-role (đang đăng nhập, đổi workspace).
export class SwitchRoleDto {
  @IsString()
  @IsIn(['BUYER', 'SELLER', 'ADMIN'])
  role: SelectableRole;
}
