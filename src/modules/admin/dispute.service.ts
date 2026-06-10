import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import {
  DisputeStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ResolutionAction,
} from '@prisma/client';
import { AdjudicateDto, CreateDisputeDto, SellerRespondDto } from './dtos/admin.dtos';

const num = (v: string | undefined, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
};

const PARTY_SELECT = { select: { id: true, full_name: true, email: true } };

@Injectable()
export class DisputeService {
  constructor(private readonly db: DatabaseService) {}

  // ─── BUYER: mở khiếu nại cho 1 đơn ───────────────────────────────────────
  async createByBuyer(buyerId: string, orderId: string, dto: CreateDisputeDto) {
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      include: { dispute: true },
    });
    if (!order) throw new NotFoundException('Đơn hàng không tồn tại.');
    if (order.buyer_id !== buyerId) throw new ForbiddenException('Bạn không sở hữu đơn hàng này.');
    if (order.dispute) throw new BadRequestException('Đơn hàng này đã có khiếu nại.');

    // Cho phép mở khiếu nại khi đơn đang giao hoặc đã báo sự cố.
    const allowedToDispute: OrderStatus[] = [OrderStatus.SHIPPING, OrderStatus.ISSUE_REPORTED];
    if (!allowedToDispute.includes(order.status)) {
      throw new BadRequestException(
        `Chỉ có thể khiếu nại đơn đang SHIPPING hoặc ISSUE_REPORTED. Hiện tại: ${order.status}`,
      );
    }

    return this.db.$transaction(async (tx) => {
      const dispute = await tx.dispute.create({
        data: {
          order_id: orderId,
          buyer_id: order.buyer_id,
          seller_id: order.seller_id,
          buyer_reason: dto.reason,
          buyer_images: dto.images ?? [],
          buyer_video: dto.video ?? null,
          status: DisputeStatus.PENDING_SELLER_RESPONSE,
        },
      });
      if (order.status !== OrderStatus.ISSUE_REPORTED) {
        await tx.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.ISSUE_REPORTED, note: dto.reason },
        });
      }
      return dispute;
    });
  }

  // ─── SELLER: gửi bằng chứng phản hồi ─────────────────────────────────────
  async respondBySeller(sellerId: string, disputeId: string, dto: SellerRespondDto) {
    const dispute = await this.db.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new NotFoundException('Khiếu nại không tồn tại.');
    if (dispute.seller_id !== sellerId) throw new ForbiddenException('Bạn không phải người bán của đơn này.');
    if (dispute.status !== DisputeStatus.PENDING_SELLER_RESPONSE) {
      throw new BadRequestException('Khiếu nại không ở trạng thái chờ người bán phản hồi.');
    }
    return this.db.dispute.update({
      where: { id: disputeId },
      data: {
        seller_explanation: dto.explanation,
        seller_images: dto.images ?? [],
        seller_video: dto.video ?? null,
        status: DisputeStatus.UNDER_ADMIN_REVIEW,
      },
    });
  }

  // ─── BUYER/SELLER: xem khiếu nại của mình ────────────────────────────────
  async listMine(userId: string) {
    return this.db.dispute.findMany({
      where: { OR: [{ buyer_id: userId }, { seller_id: userId }] },
      orderBy: { created_at: 'desc' },
      include: { order: { select: { id: true, status: true, final_total_price: true } } },
    });
  }

  // ─── ADMIN: danh sách + lọc theo trạng thái ──────────────────────────────
  async listForAdmin(opts: { status?: string; page?: string; limit?: string }) {
    const page = num(opts.page, 1);
    const limit = Math.min(num(opts.limit, 20), 100);
    const where: Prisma.DisputeWhereInput =
      opts.status && opts.status in DisputeStatus ? { status: opts.status as DisputeStatus } : {};

    const [items, total] = await Promise.all([
      this.db.dispute.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          buyer: PARTY_SELECT,
          seller: PARTY_SELECT,
          order: { select: { id: true, status: true, final_total_price: true, payment_method: true } },
        },
      }),
      this.db.dispute.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  // ─── ADMIN: chi tiết 1 ca (kèm bằng chứng 2 phía) ────────────────────────
  async getById(id: string) {
    const dispute = await this.db.dispute.findUnique({
      where: { id },
      include: {
        buyer: PARTY_SELECT,
        seller: PARTY_SELECT,
        order: {
          include: {
            order_items: { include: { product: { select: { id: true, name: true } } } },
            payments: true,
          },
        },
      },
    });
    if (!dispute) throw new NotFoundException('Khiếu nại không tồn tại.');
    return dispute;
  }

  // ─── ADMIN: phán quyết (quyền tối hậu) ───────────────────────────────────
  async adjudicate(_adminId: string, id: string, dto: AdjudicateDto) {
    const dispute = await this.db.dispute.findUnique({
      where: { id },
      include: { order: { include: { payments: true } } },
    });
    if (!dispute) throw new NotFoundException('Khiếu nại không tồn tại.');
    if (dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.CLOSED) {
      throw new BadRequestException('Khiếu nại đã được xử lý trước đó.');
    }

    // Quyết định trạng thái đơn dựa trên hành động xử lý.
    const hasOnlinePaid = dispute.order.payments.some(
      (p) => p.status === PaymentStatus.PAID && p.payment_method !== PaymentMethod.COD,
    );

    let newOrderStatus: OrderStatus | null = null;
    switch (dto.action_taken) {
      case ResolutionAction.REFUND_BUYER:
      case ResolutionAction.PARTIAL_REFUND:
        // Online đã trả trước → vào hàng đợi hoàn tiền; COD chưa có tiền → đánh dấu RETURNED.
        newOrderStatus = hasOnlinePaid ? OrderStatus.REFUND_PENDING : OrderStatus.RETURNED;
        break;
      case ResolutionAction.RELEASE_PAYMENT_TO_SELLER:
        newOrderStatus = OrderStatus.COMPLETED;
        break;
      case ResolutionAction.CLOSE_WITHOUT_ACTION:
      case ResolutionAction.NONE:
      default:
        newOrderStatus = null;
    }

    const finalStatus =
      dto.action_taken === ResolutionAction.CLOSE_WITHOUT_ACTION
        ? DisputeStatus.CLOSED
        : DisputeStatus.RESOLVED;

    const ops: Prisma.PrismaPromise<unknown>[] = [
      this.db.dispute.update({
        where: { id },
        data: {
          outcome: dto.outcome,
          action_taken: dto.action_taken,
          admin_notes: dto.admin_notes ?? null,
          status: finalStatus,
          resolved_at: new Date(),
        },
      }),
    ];
    if (newOrderStatus) {
      ops.push(this.db.order.update({ where: { id: dispute.order_id }, data: { status: newOrderStatus } }));
    }
    await this.db.$transaction(ops);

    return this.getById(id);
  }
}
