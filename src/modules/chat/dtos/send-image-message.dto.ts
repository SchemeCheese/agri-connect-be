import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class SendImageMessageDto {
  @IsString()
  @IsNotEmpty()
  conversationId: string;

  @IsString()
  @IsNotEmpty()
  imageUrl: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  caption?: string;

  @IsOptional()
  @IsString()
  clientMessageId?: string;
}
