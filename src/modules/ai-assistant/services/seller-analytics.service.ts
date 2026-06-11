import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';

/**
 * SELLER ANALYTICS ENGINE
 * ───────────────────────────────────────────────────────────────────────────
 * Nguồn dữ liệu DUY NHẤT cho mọi phân tích người bán (HTTP `GET /seller/analytics`
 * và tool chatbot `get_seller_analytics`). Mọi con số đều lấy TRỰC TIẾP từ DB —
 * KHÔNG hardcode, KHÔNG để LLM tự bịa. Gemini chỉ nhận object kết quả ở đây rồi
 * diễn giải bằng tiếng Việt.
 *
 * Định nghĩa "đã bán": chỉ tính qua đơn COMPLETED (khớp toàn hệ thống).
 * Doanh thu sản phẩm = Σ(OrderItem.quantity × OrderItem.negotiated_price) —
 * dùng negotiated_price (giá chốt thực tế, đã gồm thương lượng), KHÔNG dùng
 * reference_price (giá niêm yết).
 */

// Ngưỡng nghiệp vụ — tập trung 1 chỗ để dễ tinh chỉnh, không rải rác magic number.
const STALE_DAYS = 30; // Không bán được trong 30 ngày ⇒ coi là tồn lâu.
const MIN_VIEWS_FOR_CONVERSION = 20; // Dưới 20 view thì conversion chưa đủ ý nghĩa thống kê.
const LOW_CONVERSION_RATE = 0.02; // < 2% đơn/lượt-xem ⇒ chuyển đổi kém.
const LOW_RATING = 4; // < 4 sao ⇒ cần cải thiện.
const HIGH_CART_NO_BUY = 5; // ≥ 5 lượt thêm giỏ mà bán ít ⇒ nghi ngại giá/ảnh/mô tả.

export interface BestSellerEntry {
  id: string;
  name: string;
  unit: string;
  sold: number;
  revenue: number;
  orders: number;
  /** Điểm tổng hợp 0–100 theo công thức 50% sản lượng + 30% doanh thu + 20% số đơn. */
  score: number;
}

export interface NeedImprovementEntry {
  id: string;
  name: string;
  views: number;
  orders: number;
  conversionRate: number | null; // orders / views (null nếu chưa đủ view)
  cartAdds: number;
  avgRating: number | null;
  reviewCount: number;
  hasDispute: boolean;
  daysSinceLastSale: number | null; // null = chưa bán được lần nào
  stock: number;
  /** Lý do cụ thể (đã có số liệu) để chatbot giải thích, KHÔNG nói chung chung. */
  reasons: string[];
  /** Khuyến nghị hành động cụ thể cho từng vấn đề. */
  recommendations: string[];
}

export interface TopCustomerEntry {
  buyerId: string;
  name: string;
  orders: number;
  spent: number;
}

export interface SellerAnalytics {
  generatedAt: string;
  revenue: { today: number; thisMonth: number; total: number };
  totalOrders: number;
  activeProducts: number;
  /** Tỷ lệ chuyển đổi toàn shop = tổng đơn (item) / tổng lượt xem sản phẩm. */
  overallConversionRate: number | null;
  bestSellers: BestSellerEntry[];
  needImprovement: NeedImprovementEntry[];
  topCustomers: TopCustomerEntry[];
  /** true khi shop hầu như chưa có dữ liệu — để chatbot nói "chưa đủ dữ liệu". */
  hasData: boolean;
}

interface ProductStatRow {
  id: string;
  name: string;
  unit: string;
  stock: number;
  sold: number;
  revenue: number;
  order_count: number;
  last_sale: Date | null;
  avg_rating: number | null;
  review_count: number;
  views: number;
  cart_adds: number;
  dispute_count: number;
}

interface RevenueRow {
  today: number;
  month: number;
  total: number;
  orders: number;
}

interface CustomerRow {
  buyer_id: string;
  full_name: string | null;
  orders: number;
  spent: number;
}

@Injectable()
export class SellerAnalyticsService {
  private readonly logger = new Logger(SellerAnalyticsService.name);

  constructor(private readonly db: DatabaseService) {}

  async getSellerAnalytics(sellerId: string, limit = 5): Promise<SellerAnalytics> {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [productRows, revenueRows, customerRows, activeProducts] = await Promise.all([
      // ── Gom mọi tín hiệu mỗi sản phẩm trong 1 query ──────────────────────────
      // sold/revenue/order_count/last_sale: từ OrderItem ⋈ Order COMPLETED.
      // rating: Review của order áp lên từng product trong order (giữ semantics cũ).
      // views/cart_adds: từ UserBehavior (VIEW_PRODUCT / ADD_TO_CART, target_id = productId).
      // dispute_count: Dispute ⋈ OrderItem theo seller.
      this.db.$queryRaw<ProductStatRow[]>`
        WITH sold AS (
          SELECT oi."product_id",
                 SUM(oi."quantity")::float AS sold,
                 SUM(oi."quantity" * oi."negotiated_price")::float AS revenue,
                 COUNT(DISTINCT o."id")::int AS order_count,
                 MAX(o."created_at") AS last_sale
          FROM "OrderItem" oi
          JOIN "Order" o ON o."id" = oi."order_id"
          WHERE o."seller_id" = ${sellerId} AND o."status" = 'COMPLETED'
          GROUP BY oi."product_id"
        ),
        rating AS (
          SELECT oi."product_id",
                 AVG(r."rating")::float AS avg_rating,
                 COUNT(r."id")::int AS review_count
          FROM "Review" r
          JOIN "Order" o ON o."id" = r."order_id"
          JOIN "OrderItem" oi ON oi."order_id" = o."id"
          WHERE o."seller_id" = ${sellerId}
          GROUP BY oi."product_id"
        ),
        views AS (
          SELECT "target_id" AS product_id, COUNT(*)::int AS views
          FROM "UserBehavior"
          WHERE "action" = 'VIEW_PRODUCT' AND "target_id" IS NOT NULL
          GROUP BY "target_id"
        ),
        carts AS (
          SELECT "target_id" AS product_id, COUNT(*)::int AS cart_adds
          FROM "UserBehavior"
          WHERE "action" = 'ADD_TO_CART' AND "target_id" IS NOT NULL
          GROUP BY "target_id"
        ),
        disputes AS (
          SELECT oi."product_id", COUNT(DISTINCT d."id")::int AS dispute_count
          FROM "Dispute" d
          JOIN "OrderItem" oi ON oi."order_id" = d."order_id"
          WHERE d."seller_id" = ${sellerId}
          GROUP BY oi."product_id"
        )
        SELECT p."id", p."name", p."unit",
               p."stock_quantity"::float AS stock,
               COALESCE(s.sold, 0)::float AS sold,
               COALESCE(s.revenue, 0)::float AS revenue,
               COALESCE(s.order_count, 0)::int AS order_count,
               s.last_sale,
               rt.avg_rating,
               COALESCE(rt.review_count, 0)::int AS review_count,
               COALESCE(v.views, 0)::int AS views,
               COALESCE(c.cart_adds, 0)::int AS cart_adds,
               COALESCE(d.dispute_count, 0)::int AS dispute_count
        FROM "Product" p
        LEFT JOIN sold s ON s."product_id" = p."id"
        LEFT JOIN rating rt ON rt."product_id" = p."id"
        LEFT JOIN views v ON v."product_id" = p."id"
        LEFT JOIN carts c ON c."product_id" = p."id"
        LEFT JOIN disputes d ON d."product_id" = p."id"
        WHERE p."seller_id" = ${sellerId} AND p."is_active" = true
      `,
      this.db.$queryRaw<RevenueRow[]>`
        SELECT
          COALESCE(SUM("final_total_price") FILTER (WHERE "created_at" >= ${todayStart}), 0)::float AS today,
          COALESCE(SUM("final_total_price") FILTER (WHERE "created_at" >= ${monthStart}), 0)::float AS month,
          COALESCE(SUM("final_total_price"), 0)::float AS total,
          COUNT(*)::int AS orders
        FROM "Order"
        WHERE "seller_id" = ${sellerId} AND "status" = 'COMPLETED'
      `,
      this.db.$queryRaw<CustomerRow[]>`
        SELECT o."buyer_id", u."full_name",
               COUNT(*)::int AS orders,
               SUM(o."final_total_price")::float AS spent
        FROM "Order" o
        JOIN "User" u ON u."id" = o."buyer_id"
        WHERE o."seller_id" = ${sellerId} AND o."status" = 'COMPLETED'
        GROUP BY o."buyer_id", u."full_name"
        ORDER BY spent DESC
        LIMIT ${limit}
      `,
      this.db.product.count({ where: { seller_id: sellerId, is_active: true } }),
    ]);

    const rows = productRows.map((r) => ({
      ...r,
      sold: Number(r.sold),
      revenue: Number(r.revenue),
      order_count: Number(r.order_count),
      avg_rating: r.avg_rating !== null ? Number(r.avg_rating) : null,
      views: Number(r.views),
      cart_adds: Number(r.cart_adds),
      dispute_count: Number(r.dispute_count),
      stock: Number(r.stock),
    }));

    return {
      generatedAt: now.toISOString(),
      revenue: {
        today: revenueRows[0]?.today ?? 0,
        thisMonth: revenueRows[0]?.month ?? 0,
        total: revenueRows[0]?.total ?? 0,
      },
      totalOrders: revenueRows[0]?.orders ?? 0,
      activeProducts,
      overallConversionRate: this.computeOverallConversion(rows),
      bestSellers: this.computeBestSellers(rows, limit),
      needImprovement: this.computeNeedImprovement(rows, now, limit),
      topCustomers: customerRows.map((c) => ({
        buyerId: c.buyer_id,
        name: c.full_name ?? 'Khách hàng',
        orders: Number(c.orders),
        spent: Number(c.spent),
      })),
      hasData: rows.some((r) => r.sold > 0 || r.views > 0),
    };
  }

  /**
   * BEST SELLER SCORING RULE
   * ─────────────────────────────────────────────────────────────────────────
   * Điểm = 50% sản lượng bán + 30% doanh thu + 20% số đơn hàng.
   *
   * Lý do dùng 3 tín hiệu thay vì chỉ "số lượng bán":
   * - Chỉ theo SẢN LƯỢNG ⇒ thiên vị hàng giá rẻ bán lẻ tẻ.
   * - Cộng DOANH THU ⇒ tôn trọng hàng giá trị cao.
   * - Cộng SỐ ĐƠN ⇒ tôn trọng độ phổ biến (nhiều người mua), không phải 1 đơn sỉ.
   *
   * Chuẩn hoá (normalize) từng tín hiệu theo GIÁ TRỊ LỚN NHẤT trong shop ⇒ mỗi
   * tín hiệu về thang 0..1, không để đơn vị (cái vs đồng) lấn át nhau. Điểm ×100.
   */
  private computeBestSellers(rows: ProductStatRow[], limit: number): BestSellerEntry[] {
    const sellable = rows.filter((r) => r.sold > 0);
    if (sellable.length === 0) return [];

    const maxSold = Math.max(...sellable.map((r) => r.sold));
    const maxRevenue = Math.max(...sellable.map((r) => r.revenue));
    const maxOrders = Math.max(...sellable.map((r) => r.order_count));

    return sellable
      .map((r) => {
        const normSold = maxSold > 0 ? r.sold / maxSold : 0;
        const normRevenue = maxRevenue > 0 ? r.revenue / maxRevenue : 0;
        const normOrders = maxOrders > 0 ? r.order_count / maxOrders : 0;
        const score = Math.round((normSold * 0.5 + normRevenue * 0.3 + normOrders * 0.2) * 100);
        return {
          id: r.id,
          name: r.name,
          unit: r.unit,
          sold: r.sold,
          revenue: r.revenue,
          orders: r.order_count,
          score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * NEED-IMPROVEMENT RULE
   * ─────────────────────────────────────────────────────────────────────────
   * Một sản phẩm "cần cải thiện" nếu dính ÍT NHẤT một dấu hiệu CÓ SỐ LIỆU:
   *   1. View cao nhưng chuyển đổi thấp  (views ≥ 20 và orders/views < 2%)
   *   2. Nhiều lượt thêm giỏ nhưng bán ít (cart_adds ≥ 5 mà orders ≤ cart_adds/2)
   *   3. Rating < 4 sao                   (đã có review)
   *   4. Có khiếu nại (dispute)
   *   5. Tồn lâu không bán                (còn kho mà >30 ngày không có đơn)
   *
   * Mỗi dấu hiệu sinh 1 dòng "reason" + 1 "recommendation" CỤ THỂ (kèm số thực),
   * để chatbot giải thích đúng kiểu: "Khay ươm hạt có 1.200 lượt xem nhưng chỉ 12
   * đơn (1%) → giảm giá 5-10%, cập nhật ảnh, bổ sung mô tả." KHÔNG nói chung chung.
   *
   * Xếp hạng theo SỐ dấu hiệu (nhiều vấn đề hơn = ưu tiên xử lý trước).
   */
  private computeNeedImprovement(
    rows: ProductStatRow[],
    now: Date,
    limit: number,
  ): NeedImprovementEntry[] {
    const entries: NeedImprovementEntry[] = [];

    for (const r of rows) {
      const reasons: string[] = [];
      const recommendations: string[] = [];

      const conversionRate = r.views >= MIN_VIEWS_FOR_CONVERSION ? r.order_count / r.views : null;
      const daysSinceLastSale = r.last_sale
        ? Math.floor((now.getTime() - new Date(r.last_sale).getTime()) / 86_400_000)
        : null;

      // 1. View cao, conversion thấp.
      if (conversionRate !== null && conversionRate < LOW_CONVERSION_RATE) {
        reasons.push(
          `Có ${r.views} lượt xem nhưng chỉ ${r.order_count} đơn (tỷ lệ chuyển đổi ${(conversionRate * 100).toFixed(1)}%).`,
        );
        recommendations.push('Giảm giá 5–10%, cập nhật ảnh sản phẩm, bổ sung mô tả chi tiết.');
      }

      // 2. Thêm giỏ nhiều nhưng bán ít ⇒ rào cản ở bước checkout (giá/ship/niềm tin).
      if (r.cart_adds >= HIGH_CART_NO_BUY && r.order_count <= r.cart_adds / 2) {
        reasons.push(
          `${r.cart_adds} lượt thêm vào giỏ nhưng chỉ ${r.order_count} đơn — khách bỏ giỏ nhiều.`,
        );
        recommendations.push('Cân nhắc giảm giá hoặc tặng voucher, kiểm tra phí/điều kiện mua.');
      }

      // 3. Rating thấp.
      if (r.avg_rating !== null && r.avg_rating < LOW_RATING) {
        reasons.push(`Đánh giá trung bình ${r.avg_rating.toFixed(1)}/5 (${r.review_count} đánh giá).`);
        recommendations.push('Cải thiện chất lượng/đóng gói, phản hồi đánh giá tiêu cực.');
      }

      // 4. Có khiếu nại.
      if (r.dispute_count > 0) {
        reasons.push(`Có ${r.dispute_count} khiếu nại liên quan sản phẩm này.`);
        recommendations.push('Rà soát quy trình giao hàng/mô tả để giảm tranh chấp.');
      }

      // 5. Tồn lâu (còn hàng nhưng lâu không bán / chưa bán bao giờ).
      if (r.stock > 0 && (daysSinceLastSale === null || daysSinceLastSale > STALE_DAYS)) {
        reasons.push(
          daysSinceLastSale === null
            ? `Còn ${r.stock} tồn kho nhưng chưa bán được lần nào.`
            : `Còn ${r.stock} tồn kho, đã ${daysSinceLastSale} ngày không có đơn.`,
        );
        recommendations.push('Chạy khuyến mãi đẩy hàng tồn, làm mới tiêu đề/ảnh, gắn voucher.');
      }

      if (reasons.length > 0) {
        entries.push({
          id: r.id,
          name: r.name,
          views: r.views,
          orders: r.order_count,
          conversionRate,
          cartAdds: r.cart_adds,
          avgRating: r.avg_rating,
          reviewCount: r.review_count,
          hasDispute: r.dispute_count > 0,
          daysSinceLastSale,
          stock: r.stock,
          reasons,
          recommendations,
        });
      }
    }

    return entries.sort((a, b) => b.reasons.length - a.reasons.length).slice(0, limit);
  }

  /** Conversion toàn shop = tổng đơn-item / tổng lượt xem. null nếu chưa có view. */
  private computeOverallConversion(rows: ProductStatRow[]): number | null {
    const totalViews = rows.reduce((s, r) => s + r.views, 0);
    const totalOrders = rows.reduce((s, r) => s + r.order_count, 0);
    return totalViews > 0 ? totalOrders / totalViews : null;
  }
}
