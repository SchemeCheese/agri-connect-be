import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import { ToolResult } from './types';

export interface AnalyzePriceTrendsInput {
  product_name: string;
  period_days?: number;
}

export interface WeeklyPriceData {
  week_start: string;
  avg_price: number;
  min_price: number;
  max_price: number;
  volume: number;
}

export interface PriceTrendResult {
  product_name: string;
  period_days: number;
  overall: {
    avg_price: number;
    min_price: number;
    max_price: number;
    total_transactions: number;
    price_range_pct: number;
  };
  trend: {
    direction: 'INCREASING' | 'DECREASING' | 'STABLE' | 'INSUFFICIENT_DATA';
    change_pct: number;
    description: string;
  };
  weekly_data: WeeklyPriceData[];
  insight: string;
}

@Injectable()
export class PriceAnalysisTool {
  private readonly logger = new Logger(PriceAnalysisTool.name);

  constructor(private readonly db: DatabaseService) {}

  async analyzePriceTrends(input: AnalyzePriceTrendsInput): Promise<ToolResult<PriceTrendResult>> {
    try {
      const periodDays = input.period_days ?? 30;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - periodDays);

      const orderItems = await this.db.orderItem.findMany({
        where: {
          product: { name: { contains: input.product_name, mode: 'insensitive' } },
          order: {
            status: 'COMPLETED',
            created_at: { gte: cutoffDate },
          },
        },
        include: {
          order: { select: { created_at: true } },
        },
        orderBy: { order: { created_at: 'asc' } },
        take: 300,
      });

      if (orderItems.length === 0) {
        return {
          success: true,
          data: {
            product_name: input.product_name,
            period_days: periodDays,
            overall: { avg_price: 0, min_price: 0, max_price: 0, total_transactions: 0, price_range_pct: 0 },
            trend: {
              direction: 'INSUFFICIENT_DATA',
              change_pct: 0,
              description: 'Chưa có đủ dữ liệu giao dịch trong kỳ này',
            },
            weekly_data: [],
            insight: `Chưa có giao dịch hoàn thành nào cho "${input.product_name}" trong ${periodDays} ngày qua.`,
          },
        };
      }

      const prices = orderItems.map((i) => Number(i.negotiated_price));
      const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const priceRangePct = maxPrice > 0 ? Math.round(((maxPrice - minPrice) / avgPrice) * 100) : 0;

      // Group by week
      const weeklyMap = new Map<string, number[]>();
      for (const item of orderItems) {
        const date = new Date(item.order.created_at);
        // Round to Monday of that week
        const day = date.getDay();
        const monday = new Date(date);
        monday.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
        monday.setHours(0, 0, 0, 0);
        const key = monday.toISOString().split('T')[0];

        if (!weeklyMap.has(key)) weeklyMap.set(key, []);
        weeklyMap.get(key)!.push(Number(item.negotiated_price));
      }

      const weeklyData: WeeklyPriceData[] = Array.from(weeklyMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week_start, weekPrices]) => ({
          week_start,
          avg_price: Math.round(weekPrices.reduce((a, b) => a + b, 0) / weekPrices.length),
          min_price: Math.min(...weekPrices),
          max_price: Math.max(...weekPrices),
          volume: weekPrices.length,
        }));

      // Calculate trend: compare first half vs second half
      let trendDirection: PriceTrendResult['trend']['direction'] = 'INSUFFICIENT_DATA';
      let changePct = 0;
      let trendDescription = '';

      if (weeklyData.length >= 2) {
        const midpoint = Math.floor(weeklyData.length / 2);
        const firstHalfAvg =
          weeklyData.slice(0, midpoint).reduce((sum, w) => sum + w.avg_price, 0) / midpoint;
        const secondHalfAvg =
          weeklyData.slice(midpoint).reduce((sum, w) => sum + w.avg_price, 0) /
          (weeklyData.length - midpoint);

        changePct = Math.round(((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100 * 10) / 10;

        if (Math.abs(changePct) < 2) {
          trendDirection = 'STABLE';
          trendDescription = 'Giá ổn định trong kỳ';
        } else if (changePct > 0) {
          trendDirection = 'INCREASING';
          trendDescription = `Giá tăng ${changePct}% so với đầu kỳ`;
        } else {
          trendDirection = 'DECREASING';
          trendDescription = `Giá giảm ${Math.abs(changePct)}% so với đầu kỳ`;
        }
      } else if (weeklyData.length === 1) {
        trendDirection = 'STABLE';
        trendDescription = 'Dữ liệu 1 tuần, chưa đủ để xác định xu hướng';
      }

      const insight = this.buildInsight(input.product_name, avgPrice, trendDirection, changePct, orderItems.length, priceRangePct);

      return {
        success: true,
        data: {
          product_name: input.product_name,
          period_days: periodDays,
          overall: {
            avg_price: avgPrice,
            min_price: minPrice,
            max_price: maxPrice,
            total_transactions: orderItems.length,
            price_range_pct: priceRangePct,
          },
          trend: { direction: trendDirection, change_pct: changePct, description: trendDescription },
          weekly_data: weeklyData,
          insight,
        },
      };
    } catch (err) {
      this.logger.error('PriceAnalysisTool.analyzePriceTrends error', err);
      return { success: false, error: 'Lỗi phân tích giá' };
    }
  }

  private buildInsight(
    productName: string,
    avgPrice: number,
    trend: string,
    changePct: number,
    txCount: number,
    rangePercent: number,
  ): string {
    const priceStr = avgPrice.toLocaleString('vi-VN');

    const volatility =
      rangePercent > 20 ? 'biến động mạnh' : rangePercent > 10 ? 'biến động vừa' : 'khá ổn định';

    const trendNote =
      trend === 'INCREASING'
        ? `đang tăng ${changePct}%`
        : trend === 'DECREASING'
          ? `đang giảm ${Math.abs(changePct)}%`
          : 'đang ổn định';

    return (
      `Dữ liệu từ ${txCount} giao dịch thực. ` +
      `Giá trung bình ${priceStr}đ, ${trendNote}. ` +
      `Thị trường ${volatility} (biên độ ±${rangePercent}%).`
    );
  }
}
