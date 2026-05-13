import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class GetRecommendationsQueryDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(24)
  limit?: number;

  @IsOptional()
  @IsIn(['home', 'product_detail', 'detail', 'chat', 'cart'])
  context?: 'home' | 'product_detail' | 'detail' | 'chat' | 'cart';

  @IsOptional()
  @IsString()
  targetId?: string;
}
