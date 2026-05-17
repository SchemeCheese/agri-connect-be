import { IsString, MaxLength } from 'class-validator';

export class RemoveBannerDto {
  @IsString()
  @MaxLength(2048)
  url!: string;
}
