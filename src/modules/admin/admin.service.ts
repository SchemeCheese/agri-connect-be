import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { OrderStatus, Prisma, ProductStatus, TrustStatus } from '@prisma/client';

const num = (v: string | undefined, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
};

@Injectable()
export class AdminService {
  constructor(private readonly db: DatabaseService) {}

  // ─── Dashboard analytics ─────────────────────────────────────────────────
  async dashboard() {
    const [totalUsers, buyers, sellers, admins, activeProducts, totalProducts, completedOrders, totalOrders, pendingShops, openDisputes] =
      await Promise.all([
        this.db.user.count(),
        this.db.user.count({ where: { is_buyer: true } }),
        this.db.user.count({ where: { is_seller: true } }),
        this.db.user.count({ where: { is_admin: true } }),
        this.db.product.count({ where: { status: ProductStatus.ACTIVE } }),
        this.db.product.count(),
        this.db.order.count({ where: { status: OrderStatus.COMPLETED } }),
        this.db.order.count(),
        this.db.profile.count({ where: { is_verified: false } }),
        this.db.dispute.count({ where: { status: { in: ['PENDING_SELLER_RESPONSE', 'UNDER_ADMIN_REVIEW'] } } }),
      ]);

    const revenueAgg = await this.db.order.aggregate({
      _sum: { final_total_price: true },
      where: { status: OrderStatus.COMPLETED },
    });

    const grouped = await this.db.order.groupBy({ by: ['status'], _count: { _all: true } });
    const ordersByStatus = grouped.map((g) => ({ status: g.status, count: g._count._all }));

    return {
      users: { total: totalUsers, buyers, sellers, admins },
      products: { active: activeProducts, total: totalProducts },
      orders: { total: totalOrders, completed: completedOrders, byStatus: ordersByStatus },
      revenue: Number(revenueAgg._sum.final_total_price ?? 0),
      pendingShops,
      openDisputes,
    };
  }

  // ─── User management ─────────────────────────────────────────────────────
  async listUsers(opts: { page?: string; limit?: string; search?: string }) {
    const page = num(opts.page, 1);
    const limit = Math.min(num(opts.limit, 20), 100);
    const search = opts.search?.trim();

    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { full_name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { phone_number: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [items, total] = await Promise.all([
      this.db.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          email: true,
          full_name: true,
          phone_number: true,
          is_buyer: true,
          is_seller: true,
          is_admin: true,
          is_active: true,
          verified_email: true,
          created_at: true,
        },
      }),
      this.db.user.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async setUserStatus(id: string, isActive: boolean) {
    const user = await this.db.user.findUnique({ where: { id }, select: { id: true, is_admin: true } });
    if (!user) throw new NotFoundException('Người dùng không tồn tại.');
    if (user.is_admin && !isActive) throw new ForbiddenException('Không thể khóa tài khoản Admin.');
    return this.db.user.update({
      where: { id },
      data: { is_active: isActive },
      select: { id: true, email: true, is_active: true },
    });
  }

  // ─── Seller / shop approval ──────────────────────────────────────────────
  async listPendingShops() {
    return this.db.profile.findMany({
      where: { is_verified: false, user: { is_seller: true } },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        store_name: true,
        address: true,
        description: true,
        shop_location_name: true,
        shop_google_maps_url: true,
        created_at: true,
        user: { select: { id: true, email: true, full_name: true } },
      },
    });
  }

  async verifyShop(userId: string, isVerified: boolean) {
    const profile = await this.db.profile.findUnique({ where: { user_id: userId } });
    if (!profile) throw new NotFoundException('Shop / hồ sơ không tồn tại.');
    return this.db.profile.update({
      where: { user_id: userId },
      data: { is_verified: isVerified },
      select: { id: true, store_name: true, is_verified: true },
    });
  }

  // Admin điều chỉnh mức tin cậy shop (penalty/trust). KHÔNG expose số report thô.
  async setShopTrust(userId: string, trust: TrustStatus) {
    const profile = await this.db.profile.findUnique({ where: { user_id: userId } });
    if (!profile) throw new NotFoundException('Shop / hồ sơ không tồn tại.');
    return this.db.profile.update({
      where: { user_id: userId },
      data: { trust_status: trust },
      select: { id: true, store_name: true, trust_status: true },
    });
  }

  // ─── Product moderation ──────────────────────────────────────────────────
  async listProducts(opts: { page?: string; limit?: string; search?: string; status?: string }) {
    const page = num(opts.page, 1);
    const limit = Math.min(num(opts.limit, 20), 100);
    const search = opts.search?.trim();

    const where: Prisma.ProductWhereInput = {
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      ...(opts.status && opts.status in ProductStatus ? { status: opts.status as ProductStatus } : {}),
    };

    const [items, total] = await Promise.all([
      this.db.product.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          name: true,
          reference_price: true,
          stock_quantity: true,
          unit: true,
          status: true,
          is_active: true,
          created_at: true,
          seller: { select: { id: true, full_name: true, email: true } },
          category: { select: { id: true, name: true } },
        },
      }),
      this.db.product.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async moderateProduct(id: string, status: 'ACTIVE' | 'INACTIVE', _reason?: string) {
    const product = await this.db.product.findUnique({ where: { id }, select: { id: true } });
    if (!product) throw new NotFoundException('Sản phẩm không tồn tại.');
    // is_active luôn đồng bộ với status (ACTIVE → true, còn lại → false) như quy ước schema.
    // Lưu ý: schema chưa có cột lưu lý do kiểm duyệt nên `reason` chỉ dùng phía client (MVP).
    return this.db.product.update({
      where: { id },
      data: { status: status as ProductStatus, is_active: status === 'ACTIVE' },
      select: { id: true, name: true, status: true, is_active: true },
    });
  }

  // ─── 360° user details (hiệu năng cao: count/aggregate/groupBy, không nạp mảng vô hạn) ─
  async userDetails(id: string) {
    const user = await this.db.user.findUnique({
      where: { id },
      // CHỈ trả field an toàn — KHÔNG bao giờ password_hash / refresh_token_hash.
      select: {
        id: true,
        email: true,
        full_name: true,
        phone_number: true,
        verified_email: true,
        is_active: true,
        is_admin: true,
        is_buyer: true,
        is_seller: true,
        created_at: true,
      },
    });
    if (!user) throw new NotFoundException('Người dùng không tồn tại.');

    const ORDER_STATUSES: OrderStatus[] = [
      OrderStatus.PENDING,
      OrderStatus.CONFIRMED,
      OrderStatus.SHIPPING,
      OrderStatus.COMPLETED,
      OrderStatus.CANCELLED,
      OrderStatus.ISSUE_REPORTED,
      OrderStatus.FAILED,
      OrderStatus.RETURNED,
      OrderStatus.REFUND_PENDING,
      OrderStatus.REFUNDED,
    ];
    const PRODUCT_STATUSES: ProductStatus[] = [
      ProductStatus.ACTIVE,
      ProductStatus.OUT_OF_STOCK,
      ProductStatus.INACTIVE,
      ProductStatus.DELETED,
    ];

    type OrderGroup = { status: OrderStatus; _count: { _all: number } };
    type ProductGroup = { status: ProductStatus; _count: { _all: number } };
    const orderMap = (rows: OrderGroup[]) => {
      const m = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<OrderStatus, number>;
      rows.forEach((r) => (m[r.status] = r._count._all));
      return m;
    };
    const productMap = (rows: ProductGroup[]) => {
      const m = Object.fromEntries(PRODUCT_STATUSES.map((s) => [s, 0])) as Record<ProductStatus, number>;
      rows.forEach((r) => (m[r.status] = r._count._all));
      return m;
    };

    const [
      buyerTotalOrders,
      buyerSpentAgg,
      buyerGrouped,
      recentOrders,
      reviewsWrittenCount,
      sellerTotalProducts,
      productGrouped,
      sellerTotalOrders,
      sellerRevenueAgg,
      sellerOrderGrouped,
      recentProducts,
      recentSales,
    ] = await Promise.all([
      this.db.order.count({ where: { buyer_id: id } }),
      this.db.order.aggregate({ _sum: { final_total_price: true }, where: { buyer_id: id, status: OrderStatus.COMPLETED } }),
      this.db.order.groupBy({ by: ['status'], where: { buyer_id: id }, _count: { _all: true } }),
      this.db.order.findMany({
        where: { buyer_id: id },
        orderBy: { created_at: 'desc' },
        take: 5,
        select: {
          id: true,
          status: true,
          final_total_price: true,
          created_at: true,
          seller: { select: { id: true, full_name: true } },
        },
      }),
      this.db.review.count({ where: { reviewer_id: id } }),
      this.db.product.count({ where: { seller_id: id } }),
      this.db.product.groupBy({ by: ['status'], where: { seller_id: id }, _count: { _all: true } }),
      this.db.order.count({ where: { seller_id: id } }),
      this.db.order.aggregate({ _sum: { final_total_price: true }, where: { seller_id: id, status: OrderStatus.COMPLETED } }),
      this.db.order.groupBy({ by: ['status'], where: { seller_id: id }, _count: { _all: true } }),
      this.db.product.findMany({
        where: { seller_id: id },
        orderBy: { created_at: 'desc' },
        take: 5,
        select: { id: true, name: true, reference_price: true, stock_quantity: true, unit: true, status: true, created_at: true },
      }),
      this.db.order.findMany({
        where: { seller_id: id },
        orderBy: { created_at: 'desc' },
        take: 5,
        select: {
          id: true,
          status: true,
          final_total_price: true,
          created_at: true,
          buyer: { select: { id: true, full_name: true } },
        },
      }),
    ]);

    return {
      user,
      buyerSummary: {
        totalOrders: buyerTotalOrders,
        totalSpent: Number(buyerSpentAgg._sum.final_total_price ?? 0),
        ordersByStatus: orderMap(buyerGrouped),
        recentOrders,
        reviewsWrittenCount,
      },
      sellerSummary: {
        totalProducts: sellerTotalProducts,
        productsByStatus: productMap(productGrouped),
        totalSoldOrders: sellerTotalOrders,
        totalRevenue: Number(sellerRevenueAgg._sum.final_total_price ?? 0),
        ordersByStatus: orderMap(sellerOrderGrouped),
        recentProducts,
        recentSales,
      },
    };
  }

  // ─── 360° product details (ảnh, shop, tồn kho, đơn giá, thống kê bán) ─────
  async productDetails(id: string) {
    const product = await this.db.product.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        description: true,
        reference_price: true,
        stock_quantity: true,
        unit: true,
        location: true,
        certification: true,
        min_negotiation_qty: true,
        status: true,
        is_active: true,
        created_at: true,
        updated_at: true,
        seller: {
          select: {
            id: true,
            full_name: true,
            email: true,
            profile: { select: { store_name: true, address: true, is_verified: true } },
          },
        },
        category: { select: { id: true, name: true } },
      },
    });
    if (!product) throw new NotFoundException('Sản phẩm không tồn tại.');

    const [images, soldAgg, timesOrdered] = await Promise.all([
      this.db.attachment.findMany({
        where: { target_id: id, target_type: 'PRODUCT' },
        select: { url: true },
        orderBy: { created_at: 'asc' },
      }),
      this.db.orderItem.aggregate({
        _sum: { quantity: true },
        _count: { _all: true },
        where: { product_id: id, order: { status: OrderStatus.COMPLETED } },
      }),
      this.db.orderItem.count({ where: { product_id: id } }),
    ]);

    return {
      product,
      images: images.map((a) => a.url),
      stats: {
        soldQuantity: Number(soldAgg._sum.quantity ?? 0),
        completedOrderItems: soldAgg._count._all,
        timesOrdered,
      },
    };
  }
}
