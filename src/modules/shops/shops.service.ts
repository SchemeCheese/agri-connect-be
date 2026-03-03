import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

type TopShopSort = 'sales' | 'rating' | 'reviews';

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
        role: 'SELLER',
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
            cover_url: true,
          },
        },
      },
    });

    const sellerIds = sellers.map((s) => s.id);
    if (sellerIds.length === 0) return [];

    // 2. Lấy thống kê song song: avatar, review agg, sales count
    const [avatars, reviewAggs, salesCounts] = await Promise.all([
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
        where: {
          seller_id: { in: sellerIds },
          status: 'COMPLETED',
        },
        _count: { id: true },
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

    // 4. Combine và sort
    const result = sellers.map((s) => ({
      id: s.id,
      store_name: s.profile?.store_name || s.full_name,
      store_address: s.profile?.address ?? null,
      description: s.profile?.description ?? null,
      avatar_url: avatarMap[s.id] ?? null,
      banner_url: s.profile?.cover_url ?? null,
      avg_rating: reviewMap[s.id]?.avg_rating ?? 0,
      total_reviews: reviewMap[s.id]?.total_reviews ?? 0,
      total_sales: salesMap[s.id] ?? 0,
    }));

    // Sort
    if (sort === 'rating') {
      result.sort((a, b) => b.avg_rating - a.avg_rating);
    } else if (sort === 'reviews') {
      result.sort((a, b) => b.total_reviews - a.total_reviews);
    } else {
      // default: sales
      result.sort((a, b) => b.total_sales - a.total_sales);
    }

    return result.slice(0, limit);
  }

  /**
   * GET /shops/:id — Lấy thông tin chi tiết một shop (public)
   * Trả về profile shop, thống kê, và danh sách sản phẩm active
   */
  async getShopById(shopId: string) {
    const seller = await this.db.user.findUnique({
      where: { id: shopId, role: 'SELLER' },
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

    return {
      id: seller.id,
      store_name: seller.profile?.store_name || seller.full_name,
      store_address: seller.profile?.address ?? null,
      description: seller.profile?.description ?? null,
      avatar_url: avatar?.url ?? null,
      banner_url: seller.profile?.cover_url ?? null,
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
      })),
    };
  }
}
