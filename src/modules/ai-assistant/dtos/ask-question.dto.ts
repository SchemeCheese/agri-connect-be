import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AIMode } from '@prisma/client';
import { SUPPORTED_IMAGE_MIME_TYPES } from './suggest-product.dto';

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

  /**
   * Ảnh đính kèm (base64, chấp nhận cả data-URI — server tự strip prefix).
   * ~14M chars ≈ 10MB decoded. Gateway phải nâng maxHttpBufferSize tương ứng.
   */
  @IsOptional()
  @IsString()
  @MaxLength(14_000_000, { message: 'Ảnh quá lớn — tối đa ~10MB.' })
  imageBase64?: string;

  /** Bắt buộc gửi kèm khi có imageBase64 — fallback suy từ data-URI prefix. */
  @IsOptional()
  @IsString()
  @IsIn(SUPPORTED_IMAGE_MIME_TYPES, {
    message: `imageMimeType phải là một trong: ${SUPPORTED_IMAGE_MIME_TYPES.join(', ')}`,
  })
  imageMimeType?: string;
}
