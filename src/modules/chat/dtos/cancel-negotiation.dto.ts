import { IsNotEmpty, IsString } from 'class-validator';

export class CancelNegotiationDto {
  @IsString()
  @IsNotEmpty()
  conversationId: string;
}
