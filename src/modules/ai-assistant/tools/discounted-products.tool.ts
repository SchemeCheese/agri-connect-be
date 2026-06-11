import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import { ToolResult } from './types';

export interface DiscountedProductsInput {
  category?: string;
  limit?: number;
}

/**
 * Tool chatbot `get_discounted_products` — "sản phẩm đang giảm giá?".
 *
 * GHI CHÚ DỮ LIỆU: Agri-Connect KHÔNG có giá sale ở cấp sản phẩm. Khuyến mãi đến
 * từ VOUCHER theo shop. Vì vậy "đang giảm giá" = sản phẩm thuộc shop CÓ voucher
 * đang hiệu lực (is_active, trong khoảng valid_from..valid_to, chưa hết lượt).
 * Trả kèm thông tin voucher để chatbot nói rõ mức giảm. Không bịa giá sale.
 */
@Injectable()
export class DiscountedProductsTool {
  private readonly logger = new Logger(DiscountedProductsTool.name);

  constructor(private readonly db: DatabaseService) {}

  async run(input: DiscountedProductsInput): Promise<ToolResult> {
    try {
      const limit = Math.min(Math.max(input.limit ?? 6, 1), 10);
      const now = new Date();

      // Voucher đang hiệu lực → seller đang khuyến mãi.
      const activeVouchers = await this.db.voucher.findMany({
        where: { is_active: true, valid_from: { lte: now }, valid_to: { gte: now } },
        select: {
          seller_id: true,
          code: true,
          discount_type: true,
          discount_value: true,
          usage_limit: true,
          used_count: true,
        },
      });
      const usableVouchers = activeVouchers.filter((v) => v.used_count < v.usage_limit);
      const sellerIds = [...new Set(usableVouchers.map((v) => v.seller_id))];
      if (sellerIds.length === 0) return { success: true, data: [] };

      // Voucher tốt nhất mỗi shop (để mô tả mức giảm).
      const bestVoucher = new Map<string, (typeof usableVouchers)[number]>();
      for (const v of usableVouchers) {
        const cur = bestVoucher.get(v.seller_id);
        if (!cur || Number(v.discount_value) > Number(cur.discount_value)) {
          bestVoucher.set(v.seller_id, v);
        }
      }

      const products = await this.db.product.findMany({
        where: {
          seller_id: { in: sellerIds },
          is_active: true,
          stock_quantity: { gt: 0 },
          seller: { profile: { trust_status: { not: 'RESTRICTED' } } },
          ...(input.category
            ? { category: { name: { contains: input.category, mode: 'insensitive' } } }
            : {}),
        },
        select: {
          id: true,
          name: true,
          reference_price: true,
          unit: true,
          seller_id: true,
          seller: { select: { id: true, profile: { select: { store_name: true } } } },
          category: { select: { name: true } },
        },
        orderBy: { created_at: 'desc' },
        take: limit,
      });

      return {
        success: true,
        data: products.map((p) => {
          const v = bestVoucher.get(p.seller_id);
          return {
            id: p.id,
            name: p.name,
            reference_price: Number(p.reference_price),
            unit: p.unit,
            category: p.category.name,
            seller: { id: p.seller.id, store_name: p.seller.profile?.store_name ?? null },
            voucher: v
              ? {
                  code: v.code,
                  discount_type: v.discount_type,
                  discount_value: Number(v.discount_value),
                }
              : null,
          };
        }),
      };
    } catch (err) {
      this.logger.error('DiscountedProductsTool error', err);
      return { success: false, error: 'Lỗi tìm sản phẩm khuyến mãi' };
    }
  }
}
