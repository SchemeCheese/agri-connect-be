import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  conversationId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  content: string;

  @IsOptional()
  @IsString()
  clientMessageId?: string;
}
