import { IsNotEmpty, IsString } from 'class-validator';

export class MomoCreateDto {
  @IsString()
  @IsNotEmpty()
  order_id: string;
}
