import { Injectable, Logger } from '@nestjs/common';
import { SellerAnalyticsService } from '../services/seller-analytics.service';
import { ToolResult } from './types';

export interface SellerAnalyticsInput {
  limit?: number;
}

/**
 * Tool chatbot `get_seller_analytics` — KNOWLEDGE TOOL cho NGƯỜI BÁN.
 *
 * Quan trọng:
 * - sellerId LẤY TỪ ctx.userId (người đăng nhập), KHÔNG nhận từ tham số LLM ⇒
 *   không thể truy vấn analytics của shop khác (chống rò rỉ dữ liệu).
 * - Mọi số liệu do SellerAnalyticsService tính từ DB. Gemini chỉ tóm tắt/giải
 *   thích, không được bịa (xem grounding KNOWLEDGE BASE + output-validator).
 */
@Injectable()
export class SellerAnalyticsTool {
  private readonly logger = new Logger(SellerAnalyticsTool.name);

  constructor(private readonly analytics: SellerAnalyticsService) {}

  async run(input: SellerAnalyticsInput, sellerId: string): Promise<ToolResult> {
    try {
      const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
      const data = await this.analytics.getSellerAnalytics(sellerId, limit);
      return { success: true, data };
    } catch (err) {
      this.logger.error('SellerAnalyticsTool error', err);
      return { success: false, error: 'Lỗi lấy số liệu phân tích người bán' };
    }
  }
}
