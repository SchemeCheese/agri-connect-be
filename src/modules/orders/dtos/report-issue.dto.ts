import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ReportIssueDto {
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string; // Mô tả sự cố (không bắt buộc)
}
