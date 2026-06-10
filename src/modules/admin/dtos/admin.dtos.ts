import { IsArray, IsBoolean, IsEnum, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { DisputeOutcome, ResolutionAction } from '@prisma/client';

// ─── Governance ──────────────────────────────────────────────────────────────
export class SetUserStatusDto {
  @IsBoolean()
  is_active: boolean;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class VerifyShopDto {
  @IsBoolean()
  is_verified: boolean;
}

export class ModerateProductDto {
  // Admin chỉ được ẩn (INACTIVE) hoặc khôi phục (ACTIVE) — không cho set DELETED/OUT_OF_STOCK tại đây.
  @IsIn(['ACTIVE', 'INACTIVE'])
  status: 'ACTIVE' | 'INACTIVE';

  @IsOptional()
  @IsString()
  reason?: string;
}

// ─── Dispute ─────────────────────────────────────────────────────────────────
export class CreateDisputeDto {
  @IsString()
  @MinLength(5)
  reason: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsString()
  video?: string;
}

export class SellerRespondDto {
  @IsString()
  @MinLength(5)
  explanation: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsString()
  video?: string;
}

export class AdjudicateDto {
  @IsEnum(DisputeOutcome)
  outcome: DisputeOutcome;

  @IsEnum(ResolutionAction)
  action_taken: ResolutionAction;

  @IsOptional()
  @IsString()
  admin_notes?: string;
}
