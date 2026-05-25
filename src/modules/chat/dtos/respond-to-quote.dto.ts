import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export type QuoteAction = 'ACCEPTED' | 'REJECTED';

export class RespondToQuoteDto {
  @IsString()
  @IsNotEmpty()
  conversationId: string;

  @IsString()
  @IsNotEmpty()
  messageId: string;

  @IsIn(['ACCEPTED', 'REJECTED'])
  action: QuoteAction;
}
