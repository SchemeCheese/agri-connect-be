import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class ReplyReviewDto {
  @IsString()
  @IsNotEmpty({ message: 'Nội dung phản hồi không được để trống.' })
  @MaxLength(1000, { message: 'Phản hồi tối đa 1000 ký tự.' })
  reply: string;
}
