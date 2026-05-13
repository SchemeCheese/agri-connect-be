import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

type RecommendationContext = 'home' | 'product_detail' | 'chat' | 'cart' | 'detail';

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
    breakdown: {
      buy: number;
      intent: number;
      recency: number;
      popularity: number;
    };
    weights: {
      buy: number;
      intent: number;
      recency: number;
      popularity: number;
    };
  };
};

@Injectable()
export class RecommendationsService {
  private readonly DEFAULT_LIMIT = 8;
  private readonly DEFAULT_CONTEXT: RecommendationContext = 'home';
  private readonly CACHE_TTL_MS = 60 * 60 * 1000;

  private readonly weights = {
    buy: 0.45,
    intent: 0.30,
    recency: 0.15,
    popularity: 0.10,
  };

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
      const cached = await this.db.recommendationCache.findUnique({
        where: { user_id: userId },
      });

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
        create: {
          user_id: userId,
          data: generatedItems,
        },
        update: {
          data: generatedItems,
        },
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

    const [
      candidateProducts,
      userBehaviors,
      userCompletedItems,
      userIntentMessages,
      userReviews,
      targetProduct,
    ] = await Promise.all([
      this.db.product.findMany({
        where: { is_active: true },
        include: {
          category: { select: { id: true, name: true } },
          seller: {
            select: {
              id: true,
              full_name: true,
              profile: { select: { store_name: true } },
            },
          },
        },
        orderBy: { created_at: 'desc' },
        take: Math.max(poolSize, 50),
      }),
      this.db.userBehavior.findMany({
        where: { user_id: userId },
        select: {
          action: true,
          target_id: true,
          metadata: true,
          weight: true,
          created_at: true,
        },
        orderBy: { created_at: 'desc' },
        take: 800,
      }),
      this.db.orderItem.findMany({
        where: {
          order: {
            buyer_id: userId,
            status: 'COMPLETED',
          },
        },
        select: {
          product_id: true,
          quantity: true,
          order: { select: { created_at: true } },
        },
      }),
      this.db.chatMessage.findMany({
        where: {
          sender_id: userId,
          OR: [
            { context_product_id: { not: null } },
            { proposed_price: { not: null } },
            { proposed_quantity: { not: null } },
          ],
        },
        select: {
          context_product_id: true,
          created_at: true,
          proposed_price: true,
          proposed_quantity: true,
        },
      }),
      this.db.review.findMany({
        where: { reviewer_id: userId },
        select: {
          created_at: true,
          order: {
            select: {
              order_items: {
                select: { product_id: true },
              },
            },
          },
        },
      }),
      context === 'product_detail' && targetId
        ? this.db.product.findUnique({
            where: { id: targetId },
            select: { id: true, category_id: true, seller_id: true },
          })
        : Promise.resolve(null),
    ]);

    if (candidateProducts.length === 0) return [];

    const candidateIds = candidateProducts.map((p) => p.id);

    const [productImages, popularitySales, popularityReviewsRaw, sellerAvatars] = await Promise.all([
      this.db.attachment.findMany({
        where: {
          target_type: 'PRODUCT',
          target_id: { in: candidateIds },
        },
        select: { target_id: true, url: true },
      }),
      this.db.orderItem.groupBy({
        by: ['product_id'],
        where: {
          product_id: { in: candidateIds },
          order: { status: 'COMPLETED' },
        },
        _sum: { quantity: true },
      }),
      this.db.review.findMany({
        where: {
          order: {
            order_items: {
              some: {
                product_id: { in: candidateIds },
              },
            },
          },
        },
        select: {
          rating: true,
          order: {
            select: {
              order_items: {
                where: {
                  product_id: { in: candidateIds },
                },
                select: { product_id: true },
              },
            },
          },
        },
      }),
      this.db.attachment.findMany({
        where: {
          target_type: 'AVATAR',
          target_id: { in: [...new Set(candidateProducts.map((p) => p.seller_id))] },
        },
        select: { target_id: true, url: true },
      }),
    ]);

    const imageMap = productImages.reduce((acc, row) => {
      if (!acc[row.target_id]) acc[row.target_id] = [];
      acc[row.target_id].push(row.url);
      return acc;
    }, {} as Record<string, string[]>);

    const avatarMap = sellerAvatars.reduce(
      (acc, row) => ({ ...acc, [row.target_id]: row.url }),
      {} as Record<string, string>,
    );

    const userBuyMap = new Map<string, number>();
    const behaviorBuyMap = new Map<string, number>();
    const behaviorIntentMap = new Map<string, number>();
    const userLastInteractionMap = new Map<string, Date>();
    const categoryIntentMap = new Map<string, number>();
    const searchKeywords: string[] = [];

    for (const behavior of userBehaviors) {
      const behaviorWeight = Math.max(0.1, Number(behavior.weight || 0));
      const targetProductId = behavior.target_id ?? null;

      if (targetProductId) {
        const prev = userLastInteractionMap.get(targetProductId);
        if (!prev || behavior.created_at > prev) {
          userLastInteractionMap.set(targetProductId, behavior.created_at);
        }
      }

      if (behavior.action === 'PURCHASE' && targetProductId) {
        behaviorBuyMap.set(
          targetProductId,
          (behaviorBuyMap.get(targetProductId) ?? 0) + behaviorWeight,
        );
        behaviorIntentMap.set(
          targetProductId,
          (behaviorIntentMap.get(targetProductId) ?? 0) + behaviorWeight * 0.4,
        );
      }

      if (behavior.action === 'ADD_TO_CART' && targetProductId) {
        behaviorIntentMap.set(
          targetProductId,
          (behaviorIntentMap.get(targetProductId) ?? 0) + behaviorWeight,
        );
      }

      if (behavior.action === 'START_CHAT' && targetProductId) {
        behaviorIntentMap.set(
          targetProductId,
          (behaviorIntentMap.get(targetProductId) ?? 0) + behaviorWeight * 1.1,
        );
      }

      if (behavior.action === 'VIEW_PRODUCT' && targetProductId) {
        behaviorIntentMap.set(
          targetProductId,
          (behaviorIntentMap.get(targetProductId) ?? 0) + behaviorWeight * 0.5,
        );
      }

      if (behavior.action === 'SEARCH' && behavior.metadata && typeof behavior.metadata === 'object') {
        const meta = behavior.metadata as Record<string, unknown>;
        const categoryId = meta.categoryId;
        const categoryName = meta.category;
        const keyword = meta.keyword ?? meta.query ?? meta.q;

        if (categoryId !== undefined && categoryId !== null) {
          const categoryKey = String(categoryId).toLowerCase();
          categoryIntentMap.set(
            categoryKey,
            (categoryIntentMap.get(categoryKey) ?? 0) + behaviorWeight,
          );
        } else if (typeof categoryName === 'string' && categoryName.trim()) {
          const categoryKey = categoryName.trim().toLowerCase();
          categoryIntentMap.set(
            categoryKey,
            (categoryIntentMap.get(categoryKey) ?? 0) + behaviorWeight,
          );
        }

        if (typeof keyword === 'string' && keyword.trim().length >= 2) {
          searchKeywords.push(keyword.trim().toLowerCase());
        }
      }
    }

    for (const item of userCompletedItems) {
      userBuyMap.set(item.product_id, (userBuyMap.get(item.product_id) ?? 0) + Number(item.quantity));
      const prev = userLastInteractionMap.get(item.product_id);
      if (!prev || item.order.created_at > prev) {
        userLastInteractionMap.set(item.product_id, item.order.created_at);
      }
    }

    const userIntentMap = new Map<string, number>();
    for (const msg of userIntentMessages) {
      if (!msg.context_product_id) continue;
      const intentWeight = msg.proposed_price || msg.proposed_quantity ? 1 : 0.5;
      userIntentMap.set(msg.context_product_id, (userIntentMap.get(msg.context_product_id) ?? 0) + intentWeight);

      const prev = userLastInteractionMap.get(msg.context_product_id);
      if (!prev || msg.created_at > prev) {
        userLastInteractionMap.set(msg.context_product_id, msg.created_at);
      }
    }

    for (const rv of userReviews) {
      for (const oi of rv.order.order_items) {
        const prev = userLastInteractionMap.get(oi.product_id);
        if (!prev || rv.created_at > prev) {
          userLastInteractionMap.set(oi.product_id, rv.created_at);
        }
      }
    }

    const salesMap = popularitySales.reduce(
      (acc, row) => ({ ...acc, [row.product_id]: Number(row._sum.quantity ?? 0) }),
      {} as Record<string, number>,
    );

    const reviewMap = new Map<string, { sum: number; count: number }>();
    for (const rv of popularityReviewsRaw) {
      for (const oi of rv.order.order_items) {
        const cur = reviewMap.get(oi.product_id) ?? { sum: 0, count: 0 };
        reviewMap.set(oi.product_id, { sum: cur.sum + rv.rating, count: cur.count + 1 });
      }
    }

    const maxSales = Math.max(1, ...Object.values(salesMap));
    const maxIntentCount = Math.max(
      1,
      ...Array.from(userIntentMap.values()),
      ...Array.from(behaviorIntentMap.values()),
    );
    const maxBuyCount = Math.max(
      1,
      ...Array.from(userBuyMap.values()),
      ...Array.from(behaviorBuyMap.values()),
    );
    const maxCategoryIntent = Math.max(1, ...Array.from(categoryIntentMap.values()));

    const ranked = candidateProducts.map((p) => {
      const buyRaw = (userBuyMap.get(p.id) ?? 0) + (behaviorBuyMap.get(p.id) ?? 0);
      const buySignal = Math.min(1, buyRaw / maxBuyCount);

      const intentRaw = (userIntentMap.get(p.id) ?? 0) + (behaviorIntentMap.get(p.id) ?? 0);
      const baseIntentSignal = Math.min(1, intentRaw / maxIntentCount);

      const categoryFromId = categoryIntentMap.get(String(p.category.id).toLowerCase()) ?? 0;
      const categoryFromName = categoryIntentMap.get(p.category.name.toLowerCase()) ?? 0;
      const categorySignal = Math.min(1, Math.max(categoryFromId, categoryFromName) / maxCategoryIntent);

      const keywordSignal = searchKeywords.some((kw) => {
        const normalizedName = p.name.toLowerCase();
        const normalizedCategory = p.category.name.toLowerCase();
        return normalizedName.includes(kw) || normalizedCategory.includes(kw);
      })
        ? 1
        : 0;

      let contextSignal = 0;
      if (context === 'product_detail' && targetProduct) {
        if (p.id === targetProduct.id) {
          contextSignal = -1;
        } else {
          if (p.category_id === targetProduct.category_id) contextSignal += 0.25;
          if (p.seller_id === targetProduct.seller_id) contextSignal += 0.08;
        }
      }

      const intentSignal = Math.max(
        0,
        Math.min(1, baseIntentSignal + categorySignal * 0.5 + keywordSignal * 0.25 + contextSignal),
      );

      const lastInteraction = userLastInteractionMap.get(p.id);
      const recencySignal = lastInteraction
        ? Math.exp(-Math.max(0, now.getTime() - lastInteraction.getTime()) / (1000 * 60 * 60 * 24 * 30))
        : 0;

      const sold = salesMap[p.id] ?? 0;
      const soldSignal = sold / maxSales;
      const reviewAgg = reviewMap.get(p.id) ?? { sum: 0, count: 0 };
      const ratingSignal = reviewAgg.count > 0 ? (reviewAgg.sum / reviewAgg.count) / 5 : 0;
      const popularitySignal = 0.7 * soldSignal + 0.3 * ratingSignal;

      const breakdown = {
        buy: this.weights.buy * buySignal,
        intent: this.weights.intent * intentSignal,
        recency: this.weights.recency * recencySignal,
        popularity: this.weights.popularity * popularitySignal,
      };

      const total = breakdown.buy + breakdown.intent + breakdown.recency + breakdown.popularity;

      const strongest = Object.entries(breakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'popularity';
      const reason = this.mapReason(strongest as keyof typeof breakdown);

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
          reason,
          breakdown: {
            buy: Number(breakdown.buy.toFixed(6)),
            intent: Number(breakdown.intent.toFixed(6)),
            recency: Number(breakdown.recency.toFixed(6)),
            popularity: Number(breakdown.popularity.toFixed(6)),
          },
          weights: this.weights,
        },
      };
    });

    return ranked
      .filter((item) => (context === 'product_detail' && targetId ? item.id !== targetId : true))
      .sort((a, b) => b.recommendation.total_score - a.recommendation.total_score)
      .slice(0, poolSize);
  }

  private normalizeContext(context: RecommendationContext): Exclude<RecommendationContext, 'detail'> {
    if (context === 'detail') return 'product_detail';
    return context;
  }

  private mapReason(key: 'buy' | 'intent' | 'recency' | 'popularity') {
    if (key === 'buy') return 'Vì bạn từng mua sản phẩm tương tự';
    if (key === 'intent') return 'Vì bạn đã quan tâm và thương lượng gần đây';
    if (key === 'recency') return 'Vì bạn vừa tương tác gần đây';
    return 'Sản phẩm đang được quan tâm cao';
  }
}
