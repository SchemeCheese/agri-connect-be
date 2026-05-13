import { BehaviorAction } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateBehaviorDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  sessionId?: string;

  @IsEnum(BehaviorAction)
  action: BehaviorAction;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  targetId?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  weight?: number;
}
