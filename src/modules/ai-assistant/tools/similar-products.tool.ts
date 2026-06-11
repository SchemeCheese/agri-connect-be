import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import { ToolResult } from './types';

export interface SimilarProductsInput {
  product_id: string;
  limit?: number;
}

/**
 * Tool chatbot `get_similar_products` — "có sản phẩm tương tự X không?".
 *
 * PRODUCT SIMILARITY RULE (§4): cùng danh mục, giá gần (±40%), CÒN bán & CÒN hàng,
 * loại seller RESTRICTED, ưu tiên đánh giá/bán chạy. KHÔNG gợi ý hàng ẩn/hết hàng.
 * Trả mảng sản phẩm thật → entity tự được whitelist + render card.
 */
@Injectable()
export class SimilarProductsTool {
  private readonly logger = new Logger(SimilarProductsTool.name);

  constructor(private readonly db: DatabaseService) {}

  async run(input: SimilarProductsInput): Promise<ToolResult> {
    try {
      if (!input.product_id) return { success: false, error: 'Thiếu product_id' };
      const limit = Math.min(Math.max(input.limit ?? 6, 1), 10);

      const target = await this.db.product.findUnique({
        where: { id: input.product_id },
        select: { id: true, category_id: true, reference_price: true },
      });
      if (!target) return { success: true, data: [] };

      const price = Number(target.reference_price);
      const candidates = await this.db.product.findMany({
        where: {
          id: { not: target.id },
          category_id: target.category_id,
          is_active: true,
          stock_quantity: { gt: 0 },
          seller: { profile: { trust_status: { not: 'RESTRICTED' } } },
          ...(price > 0
            ? { reference_price: { gte: price * 0.6, lte: price * 1.4 } } // ±40%
            : {}),
        },
        select: {
          id: true,
          name: true,
          reference_price: true,
          unit: true,
          location: true,
          seller: { select: { id: true, profile: { select: { store_name: true } } } },
          category: { select: { name: true } },
        },
        orderBy: { created_at: 'desc' },
        take: limit,
      });

      return {
        success: true,
        data: candidates.map((p) => ({
          id: p.id,
          name: p.name,
          reference_price: Number(p.reference_price),
          unit: p.unit,
          location: p.location,
          category: p.category.name,
          seller: { id: p.seller.id, store_name: p.seller.profile?.store_name ?? null },
        })),
      };
    } catch (err) {
      this.logger.error('SimilarProductsTool error', err);
      return { success: false, error: 'Lỗi tìm sản phẩm tương tự' };
    }
  }
}
