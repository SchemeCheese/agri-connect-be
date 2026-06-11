import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import { ToolResult } from './types';

export interface AdminOverviewInput {
  limit?: number;
}

/**
 * Tool chatbot `get_admin_overview` — KNOWLEDGE TOOL cho ADMIN (toàn sàn).
 *
 * Bảo mật: CHỈ chạy khi caller là admin (isAdmin lấy từ DB user.is_admin, không
 * tin tham số LLM). Trả số liệu toàn hệ thống: doanh thu sàn, top seller, dispute
 * tháng này, shop trust_status=WARNING, user bị khóa. Gemini chỉ tóm tắt.
 */
@Injectable()
export class AdminOverviewTool {
  private readonly logger = new Logger(AdminOverviewTool.name);

  constructor(private readonly db: DatabaseService) {}

  async run(input: AdminOverviewInput, isAdmin: boolean): Promise<ToolResult> {
    if (!isAdmin) {
      return { success: false, error: 'Chức năng tổng quan toàn sàn chỉ dành cho quản trị viên.' };
    }
    try {
      const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const [revenueRows, topSellerRows, disputesThisMonth, disputeByStatus, warningShops, lockedUsers] =
        await Promise.all([
          // Doanh thu toàn sàn (đơn COMPLETED).
          this.db.$queryRaw<{ today: number; month: number; total: number; orders: number }[]>`
            SELECT
              COALESCE(SUM("final_total_price") FILTER (WHERE "created_at" >= ${todayStart}), 0)::float AS today,
              COALESCE(SUM("final_total_price") FILTER (WHERE "created_at" >= ${monthStart}), 0)::float AS month,
              COALESCE(SUM("final_total_price"), 0)::float AS total,
              COUNT(*)::int AS orders
            FROM "Order" WHERE "status" = 'COMPLETED'
          `,
          // Top seller toàn sàn theo doanh thu.
          this.db.order.groupBy({
            by: ['seller_id'],
            where: { status: 'COMPLETED' },
            _sum: { final_total_price: true },
            _count: { id: true },
            orderBy: { _sum: { final_total_price: 'desc' } },
            take: limit,
          }),
          this.db.dispute.count({ where: { created_at: { gte: monthStart } } }),
          this.db.dispute.groupBy({
            by: ['status'],
            where: { created_at: { gte: monthStart } },
            _count: { id: true },
          }),
          this.db.profile.findMany({
            where: { trust_status: 'WARNING' },
            select: { user_id: true, store_name: true },
            take: limit,
          }),
          this.db.user.findMany({
            where: { is_active: false },
            select: { id: true, full_name: true, email: true },
            take: limit,
          }),
        ]);

      // Đính kèm tên shop cho top seller.
      const sellerIds = topSellerRows.map((r) => r.seller_id);
      const sellerProfiles = sellerIds.length
        ? await this.db.profile.findMany({
            where: { user_id: { in: sellerIds } },
            select: { user_id: true, store_name: true },
          })
        : [];
      const nameMap = new Map(sellerProfiles.map((p) => [p.user_id, p.store_name]));

      const lockedCount = await this.db.user.count({ where: { is_active: false } });

      return {
        success: true,
        data: {
          generatedAt: now.toISOString(),
          platformRevenue: {
            today: revenueRows[0]?.today ?? 0,
            thisMonth: revenueRows[0]?.month ?? 0,
            total: revenueRows[0]?.total ?? 0,
            completedOrders: revenueRows[0]?.orders ?? 0,
          },
          topSellers: topSellerRows.map((r) => ({
            sellerId: r.seller_id,
            storeName: nameMap.get(r.seller_id) ?? null,
            revenue: Number(r._sum.final_total_price ?? 0),
            completedOrders: r._count.id,
          })),
          disputes: {
            thisMonth: disputesThisMonth,
            byStatus: disputeByStatus.map((d) => ({ status: d.status, count: d._count.id })),
          },
          warningShops: warningShops.map((s) => ({ sellerId: s.user_id, storeName: s.store_name })),
          lockedUsers: {
            count: lockedCount,
            sample: lockedUsers.map((u) => ({ id: u.id, name: u.full_name, email: u.email })),
          },
        },
      };
    } catch (err) {
      this.logger.error('AdminOverviewTool error', err);
      return { success: false, error: 'Lỗi lấy tổng quan toàn sàn' };
    }
  }
}
