import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Mime types Gemini vision accepts for inline image data. */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

export class SuggestProductDto {
  /**
   * Base64-encoded image. A `data:image/...;base64,` URI prefix is tolerated
   * and stripped server-side. ~14M chars ≈ 10MB decoded — matches the JSON
   * body limit configured in main.ts.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(14_000_000, { message: 'Ảnh quá lớn — tối đa ~10MB.' })
  imageBase64: string;

  @IsString()
  @IsIn(SUPPORTED_IMAGE_MIME_TYPES, {
    message: `mimeType phải là một trong: ${SUPPORTED_IMAGE_MIME_TYPES.join(', ')}`,
  })
  mimeType: string;
}
