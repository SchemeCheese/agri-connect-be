import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { AIMode } from '@prisma/client';

export class AskQuestionDto {
  @IsString()
  @MaxLength(500)
  content: string;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsEnum(AIMode)
  mode: AIMode;

  @IsOptional()
  context?: {
    productId?: string;
    shopId?: string;
    conversationId?: string;
  };
}
