import { IsNotEmpty, IsString } from 'class-validator';

export class StartConversationDto {
  @IsString()
  @IsNotEmpty()
  partnerId: string;
}
