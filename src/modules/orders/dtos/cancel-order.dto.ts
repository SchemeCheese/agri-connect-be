import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class CancelOrderDto {
  @IsString()
  @IsNotEmpty({ message: 'Vui lòng nhập lý do hủy đơn hàng.' })
  @MaxLength(500, { message: 'Lý do không được vượt quá 500 ký tự.' })
  reason: string;
}
