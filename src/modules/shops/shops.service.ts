import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { buildMapsOpenUrl } from '../profile/profile.service';

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
      };
    });

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
