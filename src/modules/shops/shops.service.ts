import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { buildMapsOpenUrl } from '../profile/profile.service';

type TopShopSort = 'score' | 'sales' | 'rating' | 'reviews';

/**
 * TOP SHOP SCORING RULE
 * ───────────────────────────────────────────────────────────────────────────
 * Top shop KHÔNG tính theo số sản phẩm. Điểm tổng hợp (mỗi thành phần chuẩn hoá
 * 0..1, tổng trọng số = 1.0):
 *
 *   ShopScore = 0.40×Revenue + 0.25×CompletedOrders + 0.15×Rating
 *             + 0.10×DisputeScore + 0.10×ResponseRate
 *
 * - Revenue        = Σ final_total_price (đơn COMPLETED) / max toàn bộ shop
 * - CompletedOrders= số đơn COMPLETED / max
 * - Rating         = avg_rating / 5
 * - DisputeScore   = 1 − tỷ-lệ-tranh-chấp (disputes / đơn, chặn trần 1) → ít dispute = điểm cao
 * - ResponseRate   = proxy mức độ phản hồi chat: tỷ lệ hội thoại mà shop CÓ trả lời
 *                    (đo từ ChatMessage — KHÔNG bịa; chưa có SLA thời gian phản hồi).
 */
const SHOP_SCORE_WEIGHTS = {
  revenue: 0.4,
  completed: 0.25,
  rating: 0.15,
  dispute: 0.1,
  response: 0.1,
};

@Injectable()
export class ShopsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * GET /shops/top?limit=4&sort=sales|rating|reviews
   * Trả về các shop hàng đầu, sắp xếp theo doanh số / rating / số đánh giá
   */
  async getTopShops(limit = 4, sort: TopShopSort = 'sales') {
    // 1. Lấy tất cả seller (có profile)
    const sellers = await this.db.user.findMany({
      where: {
        is_seller: true,
        is_active: true,
        profile: { isNot: null },
      },
      select: {
        id: true,
        full_name: true,
        profile: {
          select: {
            store_name: true,
            address: true,
            description: true,
            is_verified: true, // public: dấu tích shop đã xác minh
            trust_status: true, // public: mức tin cậy (KHÔNG expose số report/dispute thô)
            cover_url: true,
            shop_location_name: true,
            shop_google_maps_url: true,
            shop_latitude: true,
            shop_longitude: true,
          },
        },
      },
    });

    const sellerIds = sellers.map((s) => s.id);
    if (sellerIds.length === 0) return [];

    // 2. Lấy thống kê song song: avatar, review agg, sales count, revenue, dispute, chat
    const [avatars, reviewAggs, salesCounts, revenueAgg, disputeCounts, convosRaw, repliedRaw] =
      await Promise.all([
        // Avatar của từng seller
        this.db.attachment.findMany({
          where: { target_id: { in: sellerIds }, target_type: 'AVATAR' },
          select: { target_id: true, url: true },
        }),

        // avg_rating + total_reviews per seller
        Promise.all(
          sellerIds.map(async (sellerId) => {
            const agg = await this.db.review.aggregate({
              where: { order: { seller_id: sellerId } },
              _avg: { rating: true },
              _count: { id: true },
            });
            return {
              seller_id: sellerId,
              avg_rating: agg._avg.rating ?? 0,
              total_reviews: agg._count.id,
            };
          }),
        ),

        // total_sales = số đơn COMPLETED per seller
        this.db.order.groupBy({
          by: ['seller_id'],
          where: { seller_id: { in: sellerIds }, status: 'COMPLETED' },
          _count: { id: true },
        }),

        // revenue = Σ final_total_price (đơn COMPLETED) per seller
        this.db.order.groupBy({
          by: ['seller_id'],
          where: { seller_id: { in: sellerIds }, status: 'COMPLETED' },
          _sum: { final_total_price: true },
        }),

        // dispute count per seller (tín hiệu xấu)
        this.db.dispute.groupBy({
          by: ['seller_id'],
          where: { seller_id: { in: sellerIds } },
          _count: { id: true },
        }),

        // ResponseRate proxy: các hội thoại shop tham gia (user1 hoặc user2)
        this.db.conversation.findMany({
          where: { OR: [{ user1_id: { in: sellerIds } }, { user2_id: { in: sellerIds } }] },
          select: { id: true, user1_id: true, user2_id: true },
        }),
        // các hội thoại mà shop ĐÃ gửi tin (có trả lời)
        this.db.chatMessage.findMany({
          where: { sender_id: { in: sellerIds } },
          select: { conversation_id: true, sender_id: true },
          distinct: ['conversation_id', 'sender_id'],
        }),
      ]);

    // 3. Build maps
    const avatarMap = avatars.reduce(
      (acc, a) => ({ ...acc, [a.target_id]: a.url }),
      {} as Record<string, string>,
    );

    const reviewMap = reviewAggs.reduce(
      (acc, r) => ({ ...acc, [r.seller_id]: r }),
      {} as Record<string, { avg_rating: number; total_reviews: number }>,
    );

    const salesMap = (salesCounts as { seller_id: string; _count: { id: number } }[]).reduce(
      (acc, s) => ({ ...acc, [s.seller_id]: s._count.id }),
      {} as Record<string, number>,
    );

    const revenueMap = (
      revenueAgg as { seller_id: string; _sum: { final_total_price: unknown } }[]
    ).reduce(
      (acc, s) => ({ ...acc, [s.seller_id]: Number(s._sum.final_total_price ?? 0) }),
      {} as Record<string, number>,
    );

    const disputeMap = (disputeCounts as { seller_id: string; _count: { id: number } }[]).reduce(
      (acc, s) => ({ ...acc, [s.seller_id]: s._count.id }),
      {} as Record<string, number>,
    );

    // ResponseRate proxy: với mỗi shop, tỷ lệ hội thoại mà shop đã trả lời.
    const convoTotalMap: Record<string, number> = {};
    const sellerIdSet = new Set(sellerIds);
    for (const c of convosRaw) {
      if (sellerIdSet.has(c.user1_id)) convoTotalMap[c.user1_id] = (convoTotalMap[c.user1_id] ?? 0) + 1;
      if (sellerIdSet.has(c.user2_id)) convoTotalMap[c.user2_id] = (convoTotalMap[c.user2_id] ?? 0) + 1;
    }
    const repliedMap: Record<string, number> = {};
    for (const m of repliedRaw) {
      repliedMap[m.sender_id] = (repliedMap[m.sender_id] ?? 0) + 1;
    }

    // Max để chuẩn hoá 0..1.
    const maxRevenue = Math.max(1, ...Object.values(revenueMap));
    const maxCompleted = Math.max(1, ...Object.values(salesMap));

    // 4. Combine và sort
    const result = sellers.map((s) => {
      const lat = s.profile?.shop_latitude != null ? Number(s.profile.shop_latitude) : null;
      const lng = s.profile?.shop_longitude != null ? Number(s.profile.shop_longitude) : null;
      return {
        id: s.id,
        store_name: s.profile?.store_name || s.full_name,
        // `address` is canonical; `store_address` kept as alias for legacy FE mapping.
        address: s.profile?.address ?? null,
        store_address: s.profile?.address ?? null,
        description: s.profile?.description ?? null,
        avatar_url: avatarMap[s.id] ?? null,
        banner_url: s.profile?.cover_url ?? null,
        is_verified: s.profile?.is_verified ?? false,
        trust_status: s.profile?.trust_status ?? 'NORMAL',
        // ─── Shop location / Google Maps ─────────────────────────────────
        shop_location_name: s.profile?.shop_location_name ?? null,
        shop_google_maps_url: s.profile?.shop_google_maps_url ?? null,
        shop_latitude: lat,
        shop_longitude: lng,
        shop_maps_open_url: buildMapsOpenUrl({
          shop_google_maps_url: s.profile?.shop_google_maps_url,
          shop_latitude: lat,
          shop_longitude: lng,
          address: s.profile?.address,
        }),
        avg_rating: reviewMap[s.id]?.avg_rating ?? 0,
        total_reviews: reviewMap[s.id]?.total_reviews ?? 0,
        total_sales: salesMap[s.id] ?? 0,
        total_revenue: revenueMap[s.id] ?? 0,
        ...this.computeShopScore(s.id, {
          revenueMap,
          salesMap,
          reviewMap,
          disputeMap,
          convoTotalMap,
          repliedMap,
          maxRevenue,
          maxCompleted,
        }),
      };
    });

    // Sort — mặc định theo điểm tổng hợp; giữ các sort cũ để tương thích.
    if (sort === 'rating') {
      result.sort((a, b) => b.avg_rating - a.avg_rating);
    } else if (sort === 'reviews') {
      result.sort((a, b) => b.total_reviews - a.total_reviews);
    } else if (sort === 'sales') {
      result.sort((a, b) => b.total_sales - a.total_sales);
    } else {
      result.sort((a, b) => b.shop_score - a.shop_score);
    }

    return result.slice(0, limit);
  }

  /**
   * Tính ShopScore tổng hợp (xem TOP SHOP SCORING RULE) + breakdown để AI/FE
   * giải thích "vì sao shop đứng top". Mọi thành phần chuẩn hoá 0..1, điểm ×100.
   */
  private computeShopScore(
    sellerId: string,
    maps: {
      revenueMap: Record<string, number>;
      salesMap: Record<string, number>;
      reviewMap: Record<string, { avg_rating: number; total_reviews: number }>;
      disputeMap: Record<string, number>;
      convoTotalMap: Record<string, number>;
      repliedMap: Record<string, number>;
      maxRevenue: number;
      maxCompleted: number;
    },
  ) {
    const revenue = maps.revenueMap[sellerId] ?? 0;
    const completed = maps.salesMap[sellerId] ?? 0;
    const rating = maps.reviewMap[sellerId]?.avg_rating ?? 0;
    const disputes = maps.disputeMap[sellerId] ?? 0;
    const convos = maps.convoTotalMap[sellerId] ?? 0;
    const replied = maps.repliedMap[sellerId] ?? 0;

    const revenueScore = revenue / maps.maxRevenue;
    const completedScore = completed / maps.maxCompleted;
    const ratingScore = rating / 5;
    // Ít tranh chấp = điểm cao. Tỷ lệ dispute theo số đơn (chặn trần 1).
    const disputeRate = completed > 0 ? Math.min(1, disputes / completed) : disputes > 0 ? 1 : 0;
    const disputeScore = 1 - disputeRate;
    // Proxy phản hồi chat: tỷ lệ hội thoại shop có trả lời (chưa có hội thoại ⇒ 0).
    const responseScore = convos > 0 ? Math.min(1, replied / convos) : 0;

    const score =
      SHOP_SCORE_WEIGHTS.revenue * revenueScore +
      SHOP_SCORE_WEIGHTS.completed * completedScore +
      SHOP_SCORE_WEIGHTS.rating * ratingScore +
      SHOP_SCORE_WEIGHTS.dispute * disputeScore +
      SHOP_SCORE_WEIGHTS.response * responseScore;

    return {
      shop_score: Math.round(score * 100),
      score_breakdown: {
        revenue: Number((SHOP_SCORE_WEIGHTS.revenue * revenueScore * 100).toFixed(1)),
        completed_orders: Number((SHOP_SCORE_WEIGHTS.completed * completedScore * 100).toFixed(1)),
        rating: Number((SHOP_SCORE_WEIGHTS.rating * ratingScore * 100).toFixed(1)),
        low_dispute: Number((SHOP_SCORE_WEIGHTS.dispute * disputeScore * 100).toFixed(1)),
        response_rate: Number((SHOP_SCORE_WEIGHTS.response * responseScore * 100).toFixed(1)),
      },
    };
  }

  /**
   * GET /shops/:id — Lấy thông tin chi tiết một shop (public)
   * Trả về profile shop, thống kê, và danh sách sản phẩm active
   */
  async getShopById(shopId: string) {
    const seller = await this.db.user.findFirst({
      where: { id: shopId, is_seller: true },
      select: {
        id: true,
        full_name: true,
        profile: true,
      },
    });

    if (!seller) return null;

    const [avatar, reviewAgg, salesCount, products] = await Promise.all([
      this.db.attachment.findFirst({
        where: { target_id: shopId, target_type: 'AVATAR' },
        select: { url: true },
      }),
      this.db.review.aggregate({
        where: { order: { seller_id: shopId } },
        _avg: { rating: true },
        _count: { id: true },
      }),
      this.db.order.count({
        where: { seller_id: shopId, status: 'COMPLETED' },
      }),
      this.db.product.findMany({
        where: { seller_id: shopId, is_active: true },
        include: { category: { select: { name: true } } },
        orderBy: { created_at: 'desc' },
      }),
    ]);

    // Lấy ảnh sản phẩm
    const productIds = products.map((p) => p.id);
    const productImages =
      productIds.length > 0
        ? await this.db.attachment.findMany({
            where: { target_id: { in: productIds }, target_type: 'PRODUCT' },
            select: { target_id: true, url: true },
          })
        : [];

    const imageMap = productImages.reduce((acc, a) => {
      if (!acc[a.target_id]) acc[a.target_id] = [];
      acc[a.target_id].push(a.url);
      return acc;
    }, {} as Record<string, string[]>);

    const shopLat =
      seller.profile?.shop_latitude != null ? Number(seller.profile.shop_latitude) : null;
    const shopLng =
      seller.profile?.shop_longitude != null ? Number(seller.profile.shop_longitude) : null;
    const banners = (seller.profile?.banners1 ?? []).slice(0, 3);

    // Shop identity dùng để gắn vào từng sản phẩm — giúp giỏ hàng (FE/mobile) luôn
    // có seller_id + tên shop ngay khi Add to Cart từ trang shop, tránh "Shop #".
    const storeName = seller.profile?.store_name || seller.full_name;
    const shopIdentity = {
      id: seller.id,
      store_name: storeName,
      avatar_url: avatar?.url ?? null,
    };

    return {
      id: seller.id,
      store_name: seller.profile?.store_name || seller.full_name,
      // `address` is the canonical column; `store_address` is kept as an alias
      // for the existing FE mapping. Buyer UI prefers shop_location_name → address.
      address: seller.profile?.address ?? null,
      store_address: seller.profile?.address ?? null,
      description: seller.profile?.description ?? null,
      avatar_url: avatar?.url ?? null,
      banner_url: seller.profile?.cover_url ?? null,
      banners,
      // Public: mức tin cậy shop (KHÔNG expose số report/dispute thô). FE hiện badge khi WARNING.
      trust_status: seller.profile?.trust_status ?? 'NORMAL',
      shop_location_name: seller.profile?.shop_location_name ?? null,
      shop_google_maps_url: seller.profile?.shop_google_maps_url ?? null,
      shop_latitude: shopLat,
      shop_longitude: shopLng,
      shop_maps_open_url: buildMapsOpenUrl({
        shop_google_maps_url: seller.profile?.shop_google_maps_url,
        shop_latitude: shopLat,
        shop_longitude: shopLng,
        address: seller.profile?.address,
      }),
      avg_rating: reviewAgg._avg.rating ?? 0,
      total_reviews: reviewAgg._count.id,
      total_sales: salesCount,
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        price: Number(p.reference_price),
        images: imageMap[p.id] ?? [],
        category: p.category.name,
        stock: Number(p.stock_quantity),
        unit: p.unit,
        // Quan hệ seller được nhúng sẵn để giỏ hàng group đúng shop.
        seller_id: seller.id,
        shop: shopIdentity,
      })),
    };
  }
}
