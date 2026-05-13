import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import { ToolResult } from './types';

export interface RecommendSellersInput {
  category?: string;
  product_name?: string;
  min_rating?: number;
  limit?: number;
}

export interface SellerScore {
  seller_id: string;
  store_name: string | null;
  composite_score: number;
  stats: {
    total_orders: number;
    completion_rate: number;
    avg_rating: number;
    review_count: number;
    active_products: number;
    avg_price: number | null;
  };
  top_products: Array<{ name: string; price: number; unit: string }>;
  verdict: string;
}

@Injectable()
export class SellerRecommendationTool {
  private readonly logger = new Logger(SellerRecommendationTool.name);

  constructor(private readonly db: DatabaseService) {}

  async recommendSellers(input: RecommendSellersInput): Promise<ToolResult<SellerScore[]>> {
    try {
      const limit = Math.min(input.limit ?? 5, 10);
      const minRating = input.min_rating ?? 3.0;

      const sellers = await this.db.user.findMany({
        where: {
          is_seller: true,
          is_active: true,
          ...(input.product_name || input.category
            ? {
                products: {
                  some: {
                    is_active: true,
                    ...(input.product_name && {
                      name: { contains: input.product_name, mode: 'insensitive' },
                    }),
                    ...(input.category && {
                      category: { name: { contains: input.category, mode: 'insensitive' } },
                    }),
                  },
                },
              }
            : {}),
        },
        include: {
          profile: { select: { store_name: true, is_verified: true } },
          products: {
            where: {
              is_active: true,
              ...(input.product_name && {
                name: { contains: input.product_name, mode: 'insensitive' },
              }),
              ...(input.category && {
                category: { name: { contains: input.category, mode: 'insensitive' } },
              }),
            },
            select: { name: true, reference_price: true, unit: true },
            take: 3,
          },
          sell_orders: {
            select: {
              status: true,
              reviews: { select: { rating: true } },
            },
            take: 100,
            orderBy: { created_at: 'desc' },
          },
          _count: {
            select: { products: { where: { is_active: true } } },
          },
        },
        take: 30,
      });

      const scored: SellerScore[] = sellers
        .map((seller) => {
          const orders = seller.sell_orders;
          const finishedOrders = orders.filter((o) =>
            ['COMPLETED', 'CANCELLED', 'FAILED'].includes(o.status),
          );
          const completedOrders = orders.filter((o) => o.status === 'COMPLETED');
          const completionRate =
            finishedOrders.length > 0 ? completedOrders.length / finishedOrders.length : 0;

          const allRatings = orders.flatMap((o) => o.reviews).map((r) => r.rating);
          const avgRating =
            allRatings.length > 0
              ? allRatings.reduce((a, b) => a + b, 0) / allRatings.length
              : 0;

          if (avgRating < minRating && allRatings.length > 0) return null;

          const prices = seller.products.map((p) => Number(p.reference_price));
          const avgPrice =
            prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;

          // Composite score:
          // completion_rate × 0.35 + (avg_rating/5) × 0.35 + review_trust × 0.20 + listing_activity × 0.10
          const reviewTrust = Math.min(allRatings.length / 20, 1); // trust grows up to 20 reviews
          const listingActivity = Math.min(seller._count.products / 5, 1); // up to 5 active products
          const compositeScore = Math.round(
            (completionRate * 0.35 +
              (avgRating / 5) * 0.35 +
              reviewTrust * 0.2 +
              listingActivity * 0.1) *
              100,
          );

          const topProducts = seller.products.slice(0, 3).map((p) => ({
            name: p.name,
            price: Number(p.reference_price),
            unit: p.unit,
          }));

          return {
            seller_id: seller.id,
            store_name: seller.profile?.store_name ?? null,
            composite_score: compositeScore,
            stats: {
              total_orders: finishedOrders.length,
              completion_rate: Math.round(completionRate * 100),
              avg_rating: Math.round(avgRating * 10) / 10,
              review_count: allRatings.length,
              active_products: seller._count.products,
              avg_price: avgPrice,
            },
            top_products: topProducts,
            verdict: this.buildVerdict(compositeScore, completionRate, avgRating, allRatings.length),
          };
        })
        .filter(Boolean)
        .sort((a, b) => b!.composite_score - a!.composite_score)
        .slice(0, limit) as SellerScore[];

      return { success: true, data: scored };
    } catch (err) {
      this.logger.error('SellerRecommendationTool error', err);
      return { success: false, error: 'Lỗi tìm seller' };
    }
  }

  private buildVerdict(
    score: number,
    completionRate: number,
    avgRating: number,
    reviewCount: number,
  ): string {
    if (reviewCount === 0) return 'Seller mới, chưa có đánh giá';
    if (score >= 80 && completionRate >= 0.9) return 'Seller tin cậy cao — hoàn thành đơn xuất sắc';
    if (score >= 65 && avgRating >= 4.0) return 'Seller tốt — đánh giá tích cực';
    if (score >= 50) return 'Seller ổn — hoạt động bình thường';
    return 'Seller mới hoặc ít giao dịch';
  }
}
