import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth, ApiConsumes, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/decorators/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { AIAssistantService } from './services/ai-assistant.service';
import { SellerAnalyticsService } from './services/seller-analytics.service';

// Chỉ nhận ảnh upload trực tiếp (multipart) — KHÔNG nhận URL ngoài để chống SSRF.
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

@ApiTags('Seller AI')
@ApiBearerAuth('access-token')
@Controller('seller')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SELLER)
export class SellerAiController {
  constructor(
    private readonly ai: AIAssistantService,
    private readonly analytics: SellerAnalyticsService,
  ) {}

  /**
   * GET /seller/analytics — Số liệu phân tích người bán (real data từ DB).
   * Dùng cho dashboard FE và là nguồn cho tool chatbot `get_seller_analytics`.
   * SELLER-only. Trả về best-seller (50/30/20), need-improvement (có lý do),
   * doanh thu hôm nay/tháng/tổng, conversion, top khách hàng.
   */
  @ApiOperation({ summary: 'Phân tích người bán (best-seller, cần cải thiện, doanh thu, top KH)' })
  @Get('analytics')
  async getAnalytics(@Req() req: { user: { sub: string } }) {
    return this.analytics.getSellerAnalytics(req.user.sub);
  }

  /**
   * POST /seller/suggest-product — Magic Fill.
   * Upload 1 ảnh (multipart field `file`) → Gemini Vision gợi ý
   * name/description/suggestedPrice/unit/categoryId/confidence.
   *
   * - SELLER-only, rate-limit 5 req/phút/IP.
   * - KHÔNG ghi file xuống đĩa: FileInterceptor mặc định memoryStorage → dùng
   *   file.buffer → base64 đẩy thẳng cho Gemini (tránh junk file + SSRF).
   * - CHỈ trả gợi ý; KHÔNG tạo sản phẩm trong DB (nút "Lưu" mới insert).
   */
  @ApiOperation({
    summary: 'AI gợi ý sản phẩm từ ảnh (Magic Fill)',
    description: 'Upload ảnh → gợi ý form. Không lưu DB. SELLER-only, 5 req/phút.',
  })
  @ApiConsumes('multipart/form-data')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('suggest-product')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  async suggestProduct(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Thiếu file ảnh.');
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException('Chỉ chấp nhận ảnh JPEG, PNG, WEBP hoặc HEIC.');
    }
    if (file.size > MAX_BYTES) throw new BadRequestException('Ảnh vượt quá 5MB.');

    const base64 = file.buffer.toString('base64');
    return this.ai.suggestProductForSeller(base64, file.mimetype);
  }
}
