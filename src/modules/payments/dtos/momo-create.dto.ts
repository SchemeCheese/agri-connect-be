import { IsOptional, IsString } from 'class-validator';

export class MomoCreateDto {
  // Flow mới: nhóm thanh toán nhiều shop. Ưu tiên field này.
  @IsString()
  @IsOptional()
  checkout_session_id?: string;

  // Legacy: id đơn lẻ — controller resolve về session của đơn đó nếu có.
  @IsString()
  @IsOptional()
  order_id?: string;
}
