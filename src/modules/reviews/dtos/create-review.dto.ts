import { IsString, IsNotEmpty, IsInt, Min, Max, IsOptional } from 'class-validator';

export class CreateReviewDto {
  @IsString()
  @IsNotEmpty({ message: 'Vui lòng cung cấp mã đơn hàng.' })
  order_id: string;

  @IsInt({ message: 'Đánh giá phải là số nguyên.' })
  @Min(1, { message: 'Đánh giá tối thiểu là 1 sao.' })
  @Max(5, { message: 'Đánh giá tối đa là 5 sao.' })
  rating: number;

  @IsOptional()
  @IsString()
  comment?: string;

  // FE có thể gửi kèm product_id — whitelist để không bị reject
  @IsOptional()
  @IsString()
  product_id?: string;
}
