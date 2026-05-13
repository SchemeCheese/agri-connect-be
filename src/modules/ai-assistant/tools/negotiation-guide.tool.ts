import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import { ToolResult } from './types';

export interface GetNegotiationGuidanceInput {
  product_id: string;
  desired_quantity: number;
  role: 'BUYER' | 'SELLER';
}

export interface PriceBucket {
  ratio_label: string;
  price_range: string;
  acceptance_rate: number;
  sample_count: number;
}

export interface NegotiationGuidanceResult {
  product_id: string;
  product_name: string;
  reference_price: number;
  unit: string;
  is_negotiable: boolean;
  min_negotiation_qty: number | null;
  quantity_check: { ok: boolean; message: string };
  suggested_price: number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NO_DATA';
  acceptance_rate_at_suggestion: number | null;
  price_buckets: PriceBucket[];
  recommendation: string;
  data_source: string;
}

@Injectable()
export class NegotiationGuideTool {
  private readonly logger = new Logger(NegotiationGuideTool.name);

  constructor(private readonly db: DatabaseService) {}

  async getNegotiationGuidance(
    input: GetNegotiationGuidanceInput,
  ): Promise<ToolResult<NegotiationGuidanceResult>> {
    try {
      const product = await this.db.product.findUnique({
        where: { id: input.product_id },
        select: {
          id: true,
          name: true,
          reference_price: true,
          unit: true,
          min_negotiation_qty: true,
        },
      });

      if (!product) {
        return { success: false, error: 'Không tìm thấy sản phẩm' };
      }

      const refPrice = Number(product.reference_price);
      const minNegQty = product.min_negotiation_qty ? Number(product.min_negotiation_qty) : null;
      const isNegotiable = minNegQty !== null;

      // Quantity feasibility check
      const quantityCheck = this.checkQuantity(input.desired_quantity, minNegQty, isNegotiable);

      // Fetch historical negotiation quotes for this product
      const quotes = await this.db.chatMessage.findMany({
        where: {
          message_type: 'NEGOTIATION_QUOTE',
          quote_product_id: input.product_id,
          quote_status: { in: ['ACCEPTED', 'REJECTED'] },
          quote_price: { not: null },
        },
        select: {
          quote_price: true,
          proposed_quantity: true,
          quote_status: true,
        },
        take: 200,
        orderBy: { created_at: 'desc' },
      });

      if (quotes.length < 3) {
        const suggestion = this.fallbackSuggestion(refPrice, input.role);
        return {
          success: true,
          data: {
            product_id: product.id,
            product_name: product.name,
            reference_price: refPrice,
            unit: product.unit,
            is_negotiable: isNegotiable,
            min_negotiation_qty: minNegQty,
            quantity_check: quantityCheck,
            suggested_price: suggestion,
            confidence: 'LOW',
            acceptance_rate_at_suggestion: null,
            price_buckets: [],
            recommendation: this.buildRecommendation(input.role, suggestion, refPrice, null, 'LOW'),
            data_source: `Chưa đủ lịch sử giao dịch (${quotes.length} mẫu). Dựa trên giá tham chiếu.`,
          },
        };
      }

      // Build price buckets: ratio = quote_price / reference_price
      const bucketMap = new Map<
        number,
        { accepted: number; total: number; prices: number[] }
      >();

      for (const q of quotes) {
        const price = Number(q.quote_price);
        // Round to nearest 5% bucket of reference price
        const ratio = Math.round((price / refPrice) * 20) / 20; // 0.05 precision
        if (!bucketMap.has(ratio)) {
          bucketMap.set(ratio, { accepted: 0, total: 0, prices: [] });
        }
        const bucket = bucketMap.get(ratio)!;
        bucket.total++;
        bucket.prices.push(price);
        if (q.quote_status === 'ACCEPTED') bucket.accepted++;
      }

      const priceBuckets: PriceBucket[] = Array.from(bucketMap.entries())
        .map(([ratio, stats]) => ({
          ratio_label: `${Math.round(ratio * 100)}% giá tham chiếu`,
          price_range: `${Math.round(refPrice * ratio).toLocaleString('vi-VN')}đ`,
          acceptance_rate: Math.round((stats.accepted / stats.total) * 100),
          sample_count: stats.total,
        }))
        .filter((b) => b.sample_count >= 2)
        .sort((a, b) => b.acceptance_rate - a.acceptance_rate);

      // Find the best price suggestion
      const bestBucket = priceBuckets[0];
      let suggestedPrice: number | null = null;
      let acceptanceRateAtSuggestion: number | null = null;
      let confidence: NegotiationGuidanceResult['confidence'] = 'NO_DATA';

      if (bestBucket) {
        const ratio = parseFloat(bestBucket.ratio_label) / 100;
        suggestedPrice = Math.round(refPrice * ratio);
        acceptanceRateAtSuggestion = bestBucket.acceptance_rate;

        if (bestBucket.sample_count >= 10 && bestBucket.acceptance_rate >= 60) {
          confidence = 'HIGH';
        } else if (bestBucket.sample_count >= 5 && bestBucket.acceptance_rate >= 40) {
          confidence = 'MEDIUM';
        } else {
          confidence = 'LOW';
        }
      }

      const recommendation = this.buildRecommendation(
        input.role,
        suggestedPrice,
        refPrice,
        acceptanceRateAtSuggestion,
        confidence,
      );

      return {
        success: true,
        data: {
          product_id: product.id,
          product_name: product.name,
          reference_price: refPrice,
          unit: product.unit,
          is_negotiable: isNegotiable,
          min_negotiation_qty: minNegQty,
          quantity_check: quantityCheck,
          suggested_price: suggestedPrice,
          confidence,
          acceptance_rate_at_suggestion: acceptanceRateAtSuggestion,
          price_buckets: priceBuckets.slice(0, 5),
          recommendation,
          data_source: `Phân tích từ ${quotes.length} lần thương lượng thực tế.`,
        },
      };
    } catch (err) {
      this.logger.error('NegotiationGuideTool error', err);
      return { success: false, error: 'Lỗi lấy thông tin thương lượng' };
    }
  }

  private checkQuantity(
    desired: number,
    minNegQty: number | null,
    isNegotiable: boolean,
  ): { ok: boolean; message: string } {
    if (!isNegotiable) {
      return { ok: false, message: 'Sản phẩm này không hỗ trợ thương lượng giá' };
    }
    if (minNegQty !== null && desired < minNegQty) {
      return {
        ok: false,
        message: `Số lượng tối thiểu để thương lượng là ${minNegQty}. Bạn cần mua ít nhất ${minNegQty} đơn vị.`,
      };
    }
    return { ok: true, message: 'Số lượng đủ điều kiện thương lượng' };
  }

  private fallbackSuggestion(refPrice: number, role: 'BUYER' | 'SELLER'): number {
    // Buyer: start at 85-90% of ref price; Seller: don't go below 90%
    return role === 'BUYER' ? Math.round(refPrice * 0.88) : Math.round(refPrice * 0.92);
  }

  private buildRecommendation(
    role: 'BUYER' | 'SELLER',
    suggestedPrice: number | null,
    refPrice: number,
    acceptanceRate: number | null,
    confidence: string,
  ): string {
    if (!suggestedPrice) {
      return role === 'BUYER'
        ? 'Chưa đủ dữ liệu lịch sử. Hãy bắt đầu đề xuất ở mức 85-90% giá tham chiếu và thương lượng dần.'
        : 'Chưa đủ dữ liệu lịch sử. Hãy linh hoạt với mức giảm 5-15% cho đơn lớn.';
    }

    const priceStr = suggestedPrice.toLocaleString('vi-VN');
    const ratioStr = Math.round((suggestedPrice / refPrice) * 100);
    const rateStr = acceptanceRate ? `Tỷ lệ chấp nhận lịch sử: ${acceptanceRate}%. ` : '';

    if (role === 'BUYER') {
      return (
        `Đề xuất mức giá ${priceStr}đ (${ratioStr}% giá tham chiếu). ` +
        rateStr +
        (confidence === 'HIGH'
          ? 'Đây là mức giá có xác suất được chấp nhận cao nhất.'
          : 'Có thể thương lượng thêm tùy tình hình.')
      );
    } else {
      return (
        `Mức giá tối ưu để giữ tỷ lệ chốt đơn cao: ${priceStr}đ (${ratioStr}% giá tham chiếu). ` +
        rateStr +
        'Giảm dưới mức này sẽ ảnh hưởng đến biên lợi nhuận.'
      );
    }
  }
}
