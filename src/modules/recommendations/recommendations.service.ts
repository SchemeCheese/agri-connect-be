import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

type RecommendationContext = 'home' | 'product_detail' | 'chat' | 'cart' | 'detail';

type BuyerType = 'new' | 'returning';

type RecommendationItem = {
  id: string;
  name: string;
  price: number;
  unit: string;
  category: string;
  images: string[];
  shop: {
    id: string;
    store_name: string;
    avatar_url: string | null;
  };
  recommendation: {
    total_score: number;
    reason: string;
    buyer_type: BuyerType;
    /** Đóng góp từng thành phần (đã nhân trọng số). Keys khác nhau giữa new/returning. */
    breakdown: Record<string, number>;
    weights: Record<string, number>;
  };
};

/**
 * ════════════════════════════════════════════════════════════════════════════
 * BUYER RECOMMENDATION ENGINE v2  (không hardcode, không random)
 * ════════════════════════════════════════════════════════════════════════════
 * Mọi tín hiệu lấy TỪ DB (đơn hàng, UserBehavior, review). Engine chỉ tính điểm;
 * phần "giải thích bằng lời" do AI chatbot làm dựa trên dữ liệu này (xem P6).
 *
 * Hai chế độ:
 *   • RETURNING (đã có lịch sử): điểm = 40% lịch sử mua + 25% giỏ + 20% xem +
 *     10% từ khoá tìm + 5% trending.
 *   • NEW / cold-start (chưa có hành vi): điểm = 40% trending + 30% best-seller +
 *     20% rating + 10% sản phẩm mới.
 *
 * Ý tưởng cốt lõi: hành vi trên 1 SẢN PHẨM lan toả thành ƯU TIÊN theo DANH MỤC
 * của nó. Mua Cà chua/Dưa leo (Rau củ) ⇒ Rau củ được boost ⇒ gợi ý thêm sản phẩm
 * Rau củ / hạt giống rau / phân bón rau; KHÔNG gợi ý Thịt cá/Máy móc (danh mục
 * khác, điểm mua/giỏ/xem ≈ 0).
 */

// ── Trọng số công thức (RETURNING) — tổng = 1.0 ───────────────────────────────
const W_RETURNING = { purchase: 0.4, cart: 0.25, view: 0.2, search: 0.1, trending: 0.05 };
// ── Trọng số công thức (NEW / cold-start) — tổng = 1.0 ────────────────────────
const W_NEW = { trending: 0.4, bestSeller: 0.3, rating: 0.2, newProduct: 0.1 };

/**
 * BUYER BEHAVIOR SCORING RULE
 *
 * Mỗi loại hành vi có "trọng số chủ đích" thể hiện mức độ quan tâm. Xem lâu (>2
 * phút) và xem lặp lại là tín hiệu mạnh, NHƯNG bị CHẶN TRẦN để tránh overfitting:
 * vài lần refresh / click nhầm không được lấn át.
 *
 * Caps:
 * - repeated view: tối đa 3 lượt / sản phẩm / 7 ngày  ⇒ điểm xem-lặp tối đa = 20
 * - long view: tính 1 lần / sản phẩm / ngày            ⇒ điểm xem-lâu = 25 nếu có
 * - bỏ qua view < 5 giây (click nhầm)                  ⇒ MIN_VIEW_SECONDS
 */
const BW = {
  purchase: 50, // mua sản phẩm/danh mục
  cart: 35, // thêm giỏ
  longView: 25, // xem chi tiết > 2 phút
  repeatedView: 20, // xem cùng sản phẩm ≥ 3 lần trong 7 ngày (giá trị TRẦN)
  searchMatch: 15, // từ khoá tìm khớp danh mục/sản phẩm
  shopClick: 10, // bấm vào hồ sơ shop 
  wishlist: 30, // sản phẩm đã lưu/wishlist 
} as const;

const REPEATED_VIEW_CAP = 3;
const LONG_VIEW_SECONDS = 120; // > 2 phút
const MIN_VIEW_SECONDS = 5; // bỏ qua view ngắn hơn (click nhầm)
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const RESTRICTED_TRUST = 'RESTRICTED'; // không gợi ý sản phẩm của seller bị hạn chế

@Injectable()
export class RecommendationsService {
  private readonly DEFAULT_LIMIT = 8;
  private readonly DEFAULT_CONTEXT: RecommendationContext = 'home';
  private readonly CACHE_TTL_MS = 60 * 60 * 1000;

  constructor(private readonly db: DatabaseService) {}

  async getPersonalizedProducts(
    userId: string,
    limit?: number,
    context?: RecommendationContext,
    targetId?: string,
  ) {
    const safeLimit = Math.max(1, Math.min(limit ?? this.DEFAULT_LIMIT, 24));
    const safeContext = this.normalizeContext(context ?? this.DEFAULT_CONTEXT);
    const useCache = safeContext === 'home' && !targetId;

    const now = new Date();
    if (useCache) {
      const cached = await this.db.recommendationCache.findUnique({ where: { user_id: userId } });
      if (cached) {
        const age = now.getTime() - cached.updated_at.getTime();
        if (age < this.CACHE_TTL_MS && Array.isArray(cached.data)) {
          const cachedItems = cached.data as RecommendationItem[];
          return {
            context: safeContext,
            source: 'cache',
            ttl_minutes: Math.floor(this.CACHE_TTL_MS / 60000),
            generated_at: cached.updated_at,
            items: cachedItems.slice(0, safeLimit),
          };
        }
      }
    }

    const generatedItems = await this.buildRecommendations(
      userId,
      Math.max(safeLimit, 24),
      safeContext,
      targetId,
    );

    if (useCache) {
      await this.db.recommendationCache.upsert({
        where: { user_id: userId },
        create: { user_id: userId, data: generatedItems },
        update: { data: generatedItems },
      });
    }

    return {
      context: safeContext,
      source: 'computed',
      ttl_minutes: Math.floor(this.CACHE_TTL_MS / 60000),
      generated_at: now,
      items: generatedItems.slice(0, safeLimit),
    };
  }

  private async buildRecommendations(
    userId: string,
    poolSize: number,
    context: Exclude<RecommendationContext, 'detail'>,
    targetId?: string,
  ): Promise<RecommendationItem[]> {
    const now = new Date();

    // ── 1. Lấy dữ liệu thô ────────────────────────────────────────────────────
    const [candidatesRaw, userBehaviors, userCompletedItems, targetProduct] = await Promise.all([
      // EXCLUSION RULE (§4 + acceptance): chỉ ứng viên còn ĐANG BÁN và CÒN HÀNG.
      // Loại seller RESTRICTED lọc ở JS (profile có thể null → query `not` sẽ
      // loại nhầm cả seller chưa có profile).
      this.db.product.findMany({
        where: { is_active: true, stock_quantity: { gt: 0 } },
        include: {
          category: { select: { id: true, name: true } },
          seller: {
            select: {
              id: true,
              full_name: true,
              profile: { select: { store_name: true, trust_status: true } },
            },
          },
        },
        orderBy: { created_at: 'desc' },
        take: Math.max(poolSize * 3, 120),
      }),
      this.db.userBehavior.findMany({
        where: { user_id: userId },
        select: { action: true, target_id: true, metadata: true, weight: true, created_at: true },
        orderBy: { created_at: 'desc' },
        take: 800,
      }),
      this.db.orderItem.findMany({
        where: { order: { buyer_id: userId, status: 'COMPLETED' } },
        select: { product_id: true, quantity: true },
      }),
      context === 'product_detail' && targetId
        ? this.db.product.findUnique({
            where: { id: targetId },
            select: { id: true, category_id: true, seller_id: true, reference_price: true },
          })
        : Promise.resolve(null),
    ]);

    // Loại seller RESTRICTED (null trust ⇒ giữ lại, coi như NORMAL).
    const candidates = candidatesRaw.filter(
      (p) => p.seller.profile?.trust_status !== RESTRICTED_TRUST,
    );
    if (candidates.length === 0) return [];
    const candidateIds = candidates.map((p) => p.id);

    // ── 2. Map productId → categoryId cho TẤT CẢ sản phẩm user đã tương tác ─────
    // (sản phẩm đã mua/xem có thể không nằm trong pool ứng viên — vẫn cần category
    // của chúng để lan toả ưu tiên sang danh mục.)
    const behaviorProductIds = new Set<string>();
    for (const b of userBehaviors) if (b.target_id) behaviorProductIds.add(b.target_id);
    for (const it of userCompletedItems) behaviorProductIds.add(it.product_id);
    const interactedCategoryMap = await this.loadCategoryMap(
      [...behaviorProductIds].filter((id) => !candidateIds.includes(id)),
    );
    // Gộp thêm category của ứng viên (đã có sẵn).
    for (const p of candidates) interactedCategoryMap.set(p.id, String(p.category.id));

    // ── 3. Popularity + ảnh + avatar cho ứng viên ──────────────────────────────
    const [productImages, popularitySales, popularityReviews, sellerAvatars] = await Promise.all([
      this.db.attachment.findMany({
        where: { target_type: 'PRODUCT', target_id: { in: candidateIds } },
        select: { target_id: true, url: true },
      }),
      this.db.orderItem.groupBy({
        by: ['product_id'],
        where: { product_id: { in: candidateIds }, order: { status: 'COMPLETED' } },
        _sum: { quantity: true },
      }),
      this.db.review.findMany({
        where: { order: { order_items: { some: { product_id: { in: candidateIds } } } } },
        select: {
          rating: true,
          order: {
            select: {
              order_items: {
                where: { product_id: { in: candidateIds } },
                select: { product_id: true },
              },
            },
          },
        },
      }),
      this.db.attachment.findMany({
        where: {
          target_type: 'AVATAR',
          target_id: { in: [...new Set(candidates.map((p) => p.seller_id))] },
        },
        select: { target_id: true, url: true },
      }),
    ]);

    const imageMap = productImages.reduce((acc, r) => {
      (acc[r.target_id] ??= []).push(r.url);
      return acc;
    }, {} as Record<string, string[]>);
    const avatarMap = sellerAvatars.reduce(
      (acc, r) => ({ ...acc, [r.target_id]: r.url }),
      {} as Record<string, string>,
    );
    const salesMap = popularitySales.reduce(
      (acc, r) => ({ ...acc, [r.product_id]: Number(r._sum.quantity ?? 0) }),
      {} as Record<string, number>,
    );
    const reviewMap = new Map<string, { sum: number; count: number }>();
    for (const rv of popularityReviews) {
      for (const oi of rv.order.order_items) {
        const cur = reviewMap.get(oi.product_id) ?? { sum: 0, count: 0 };
        reviewMap.set(oi.product_id, { sum: cur.sum + rv.rating, count: cur.count + 1 });
      }
    }

    // ── 4. Tổng hợp tín hiệu hành vi → AFFINITY THEO DANH MỤC ──────────────────
    const { purchaseAffinity, cartAffinity, viewAffinity, searchKeywords, searchedCategories } =
      this.buildCategorySignals(userBehaviors, userCompletedItems, interactedCategoryMap, now);

    const isNewBuyer =
      userCompletedItems.length === 0 &&
      purchaseAffinity.size === 0 &&
      cartAffinity.size === 0 &&
      viewAffinity.size === 0 &&
      searchKeywords.length === 0 &&
      searchedCategories.size === 0;

    // Chuẩn hoá affinity về 0..1 (chia cho max danh mục) để ghép vào công thức.
    const maxPurchase = Math.max(1, ...purchaseAffinity.values());
    const maxCart = Math.max(1, ...cartAffinity.values());
    const maxView = Math.max(1, ...viewAffinity.values());
    const maxSold = Math.max(1, ...Object.values(salesMap));
    // Sản phẩm mới: chuẩn hoá theo tuổi (exp decay 30 ngày).
    const newestMs = Math.max(...candidates.map((p) => p.created_at.getTime()), now.getTime());

    // ── 5. Chấm điểm từng ứng viên ─────────────────────────────────────────────
    const ranked = candidates.map((p) => {
      const catId = String(p.category.id);
      const sold = salesMap[p.id] ?? 0;
      const rAgg = reviewMap.get(p.id) ?? { sum: 0, count: 0 };
      const ratingNorm = rAgg.count > 0 ? rAgg.sum / rAgg.count / 5 : 0;
      const trendingScore = 0.7 * (sold / maxSold) + 0.3 * ratingNorm;

      let breakdown: Record<string, number>;
      let weights: Record<string, number>;
      let total: number;

      if (isNewBuyer) {
        // COLD-START: chưa biết gì về buyer ⇒ xếp theo chất lượng thị trường.
        const bestSeller = sold / maxSold;
        const ageDays = Math.max(0, (newestMs - p.created_at.getTime()) / 86_400_000);
        const newProduct = Math.exp(-ageDays / 30); // mới hơn → gần 1 hơn
        breakdown = {
          trending: W_NEW.trending * trendingScore,
          bestSeller: W_NEW.bestSeller * bestSeller,
          rating: W_NEW.rating * ratingNorm,
          newProduct: W_NEW.newProduct * newProduct,
        };
        weights = W_NEW;
      } else {
        // RETURNING: cá nhân hoá theo affinity danh mục + từ khoá + trending.
        const purchaseScore = (purchaseAffinity.get(catId) ?? 0) / maxPurchase;
        const cartScore = (cartAffinity.get(catId) ?? 0) / maxCart;
        const viewScore = (viewAffinity.get(catId) ?? 0) / maxView;
        const searchScore =
          searchedCategories.has(catId) ||
          searchKeywords.some(
            (kw) => p.name.toLowerCase().includes(kw) || p.category.name.toLowerCase().includes(kw),
          )
            ? 1
            : 0;
        breakdown = {
          purchase: W_RETURNING.purchase * purchaseScore,
          cart: W_RETURNING.cart * cartScore,
          view: W_RETURNING.view * viewScore,
          search: W_RETURNING.search * searchScore,
          trending: W_RETURNING.trending * trendingScore,
        };
        weights = W_RETURNING;
      }

      total = Object.values(breakdown).reduce((s, v) => s + v, 0);

      // PRODUCT SIMILARITY (§4): trang chi tiết → ưu tiên sản phẩm liên quan
      // (cùng danh mục, cùng shop, giá gần nhau). Loại chính sản phẩm đang xem.
      if (context === 'product_detail' && targetProduct) {
        if (p.id === targetProduct.id) {
          total = -1;
        } else {
          if (p.category_id === targetProduct.category_id) total += 0.3;
          if (p.seller_id === targetProduct.seller_id) total += 0.1;
          const tp = Number(targetProduct.reference_price);
          const pp = Number(p.reference_price);
          if (tp > 0 && Math.abs(pp - tp) / tp <= 0.3) total += 0.1; // giá trong ±30%
        }
      }

      return {
        id: p.id,
        name: p.name,
        price: Number(p.reference_price),
        unit: p.unit,
        category: p.category.name,
        images: imageMap[p.id] ?? [],
        shop: {
          id: p.seller.id,
          store_name: p.seller.profile?.store_name || p.seller.full_name,
          avatar_url: avatarMap[p.seller.id] ?? null,
        },
        recommendation: {
          total_score: Number(total.toFixed(6)),
          reason: this.buildReason(breakdown, isNewBuyer),
          buyer_type: (isNewBuyer ? 'new' : 'returning') as BuyerType,
          breakdown: Object.fromEntries(
            Object.entries(breakdown).map(([k, v]) => [k, Number(v.toFixed(6))]),
          ),
          weights,
        },
      };
    });

    return ranked
      .filter((item) => (context === 'product_detail' && targetId ? item.id !== targetId : true))
      .sort((a, b) => b.recommendation.total_score - a.recommendation.total_score)
      .slice(0, poolSize);
  }

  /**
   * Tổng hợp hành vi user thành affinity theo DANH MỤC, áp dụng đầy đủ trọng số
   * và CAP (xem BUYER BEHAVIOR SCORING RULE ở trên).
   *
   * GHI CHÚ DỮ LIỆU CHƯA CÓ (không bịa, không hardcode):
   * - shop-click (+10): chưa có event SHOP_CLICK trong enum BehaviorAction → bỏ
   *   qua, sẽ bổ sung khi thêm enum (cần migration).
   * - wishlist (+30): chưa có model Wishlist → bỏ qua tương tự.
   * - long-view (+25): đọc từ metadata.durationSeconds nếu FE gửi kèm (không cần
   *   migration vì metadata là JSON). Chưa gửi ⇒ chỉ tính điểm xem-lặp.
   */
  private buildCategorySignals(
    behaviors: Array<{
      action: string;
      target_id: string | null;
      metadata: unknown;
      weight: number | null;
      created_at: Date;
    }>,
    completedItems: Array<{ product_id: string }>,
    categoryOf: Map<string, string>,
    now: Date,
  ) {
    const purchaseAffinity = new Map<string, number>();
    const cartAffinity = new Map<string, number>();
    const viewAffinity = new Map<string, number>();
    const searchKeywords: string[] = [];
    const searchedCategories = new Set<string>();

    const addAffinity = (map: Map<string, number>, catId: string | undefined, amount: number) => {
      if (!catId) return;
      map.set(catId, (map.get(catId) ?? 0) + amount);
    };

    // (a) PURCHASE +50 — từ đơn COMPLETED (mỗi sản phẩm tính 1 lần, không nhân qty
    //     để tránh 1 đơn sỉ lấn át toàn bộ gợi ý).
    const purchasedProducts = new Set(completedItems.map((i) => i.product_id));
    for (const pid of purchasedProducts) addAffinity(purchaseAffinity, categoryOf.get(pid), BW.purchase);

    // (b) CART +35 — mỗi sản phẩm thêm giỏ tính 1 lần.
    const cartedProducts = new Set<string>();
    // (c) VIEW — gom theo sản phẩm để áp cap repeated/long view.
    const viewsByProduct = new Map<string, { count7d: number; longView: boolean }>();

    for (const b of behaviors) {
      const pid = b.target_id ?? undefined;

      if (b.action === 'PURCHASE' && pid) {
        // PURCHASE behavior (ngoài đơn hàng) cũng tính như mua.
        if (!purchasedProducts.has(pid)) addAffinity(purchaseAffinity, categoryOf.get(pid), BW.purchase);
      }

      if (b.action === 'ADD_TO_CART' && pid && !cartedProducts.has(pid)) {
        cartedProducts.add(pid);
        addAffinity(cartAffinity, categoryOf.get(pid), BW.cart);
      }

      if (b.action === 'VIEW_PRODUCT' && pid) {
        const meta = (b.metadata && typeof b.metadata === 'object' ? b.metadata : {}) as Record<string, unknown>;
        const duration = Number(meta.durationSeconds ?? meta.duration ?? NaN);
        // Bỏ qua view < 5 giây (click nhầm) — chỉ khi FE có gửi duration.
        if (Number.isFinite(duration) && duration < MIN_VIEW_SECONDS) continue;

        const within7d = now.getTime() - b.created_at.getTime() <= SEVEN_DAYS_MS;
        const cur = viewsByProduct.get(pid) ?? { count7d: 0, longView: false };
        if (within7d) cur.count7d += 1;
        if (Number.isFinite(duration) && duration > LONG_VIEW_SECONDS) cur.longView = true;
        viewsByProduct.set(pid, cur);
      }

      if (b.action === 'SEARCH' && b.metadata && typeof b.metadata === 'object') {
        const meta = b.metadata as Record<string, unknown>;
        const catId = meta.categoryId;
        const keyword = meta.keyword ?? meta.query ?? meta.q;
        if (catId !== undefined && catId !== null) searchedCategories.add(String(catId));
        if (typeof keyword === 'string' && keyword.trim().length >= 2) {
          searchKeywords.push(keyword.trim().toLowerCase());
        }
      }
    }

    // Áp CAP cho view rồi quy về affinity danh mục.
    for (const [pid, v] of viewsByProduct) {
      // repeated-view: trần 3 lượt/7 ngày → tỉ lệ ×20.
      const repeatedScore = (Math.min(v.count7d, REPEATED_VIEW_CAP) / REPEATED_VIEW_CAP) * BW.repeatedView;
      // long-view: +25 nếu có ít nhất 1 lượt > 2 phút (tính 1 lần).
      const longScore = v.longView ? BW.longView : 0;
      addAffinity(viewAffinity, categoryOf.get(pid), repeatedScore + longScore);
    }

    return { purchaseAffinity, cartAffinity, viewAffinity, searchKeywords, searchedCategories };
  }

  /** Lấy categoryId cho danh sách productId (sản phẩm đã tương tác ngoài pool). */
  private async loadCategoryMap(productIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (productIds.length === 0) return map;
    const rows = await this.db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, category_id: true },
    });
    for (const r of rows) map.set(r.id, String(r.category_id));
    return map;
  }

  private normalizeContext(context: RecommendationContext): Exclude<RecommendationContext, 'detail'> {
    if (context === 'detail') return 'product_detail';
    return context;
  }

  /** Lý do hiển thị: chọn thành phần đóng góp NHIỀU NHẤT (đã có số liệu thật). */
  private buildReason(breakdown: Record<string, number>, isNewBuyer: boolean): string {
    const strongest = Object.entries(breakdown).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (isNewBuyer) {
      const map: Record<string, string> = {
        trending: 'Sản phẩm đang được quan tâm nhiều trên sàn',
        bestSeller: 'Sản phẩm bán chạy trên sàn',
        rating: 'Sản phẩm được đánh giá cao',
        newProduct: 'Sản phẩm mới đáng chú ý',
      };
      return map[strongest ?? 'trending'] ?? map.trending;
    }
    const map: Record<string, string> = {
      purchase: 'Vì bạn từng mua sản phẩm cùng nhóm',
      cart: 'Vì bạn từng thêm vào giỏ sản phẩm cùng nhóm',
      view: 'Vì bạn đã xem nhiều sản phẩm cùng nhóm',
      search: 'Khớp với từ khoá bạn vừa tìm',
      trending: 'Sản phẩm đang được quan tâm cao',
    };
    return map[strongest ?? 'trending'] ?? map.trending;
  }
}
