import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class SearchService {
  constructor(private readonly db: DatabaseService) {}

  async search(q: string) {
    if (!q || q.trim().length === 0) {
      return { shops: [], products: [] };
    }

    const keyword = q.trim();

    // ─── 1. Tìm kiếm Shop theo store_name ───────────────────────────────────
    const shopProfiles = await this.db.profile.findMany({
      where: {
        store_name: { contains: keyword, mode: 'insensitive' },
      },
      include: {
        user: { select: { id: true, full_name: true } },
      },
      take: 10,
    });

    const shopIds = shopProfiles.map((p) => p.user_id);

    // Lấy avatar + product_count song song
    const [shopAvatars, productCounts] = await Promise.all([
      shopIds.length > 0
        ? this.db.attachment.findMany({
            where: { target_id: { in: shopIds }, target_type: 'AVATAR' },
            select: { target_id: true, url: true },
          })
        : Promise.resolve([]),
      shopIds.length > 0
        ? this.db.product.groupBy({
            by: ['seller_id'],
            where: { seller_id: { in: shopIds }, is_active: true },
            _count: { id: true },
          })
        : Promise.resolve([]),
    ]);

    const avatarMap = (shopAvatars as { target_id: string; url: string }[]).reduce(
      (acc, a) => ({ ...acc, [a.target_id]: a.url }),
      {} as Record<string, string>,
    );

    const productCountMap = (productCounts as { seller_id: string; _count: { id: number } }[]).reduce(
      (acc, s) => ({ ...acc, [s.seller_id]: s._count.id }),
      {} as Record<string, number>,
    );

    // Tính avg_rating cho từng shop (dùng Prisma aggregate qua relation)
    const shopRatingResults = await Promise.all(
      shopIds.map(async (sellerId) => {
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
    );

    const ratingMap = shopRatingResults.reduce(
      (acc, s) => ({ ...acc, [s.seller_id]: s }),
      {} as Record<string, { avg_rating: number; total_reviews: number }>,
    );

    const shops = shopProfiles.map((p) => ({
      id: p.user_id,
      store_name: p.store_name || p.user.full_name,
      avatar_url: avatarMap[p.user_id] ?? null,
      rating: ratingMap[p.user_id]?.avg_rating ?? 0,
      total_reviews: ratingMap[p.user_id]?.total_reviews ?? 0,
      product_count: productCountMap[p.user_id] ?? 0,
    }));

    // ─── 2. Tìm kiếm Sản phẩm theo name hoặc description ───────────────────
    const rawProducts = await this.db.product.findMany({
      where: {
        is_active: true,
        OR: [
          { name: { contains: keyword, mode: 'insensitive' } },
          { description: { contains: keyword, mode: 'insensitive' } },
        ],
      },
      include: {
        seller: {
          select: { id: true, profile: { select: { store_name: true } } },
        },
        category: { select: { name: true } },
      },
      take: 20,
    });

    const productIds = rawProducts.map((p) => p.id);
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

    const products = rawProducts.map((p) => ({
      id: p.id,
      name: p.name,
      price: Number(p.reference_price),
      images: imageMap[p.id] ?? [],
      category: p.category.name,
      seller: {
        id: p.seller.id,
        store_name: p.seller.profile?.store_name ?? null,
      },
    }));

    return { shops, products };
  }
}
