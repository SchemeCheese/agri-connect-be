import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CreateReviewDto } from './dtos/create-review.dto';
import { OrderStatus } from '@prisma/client';

@Injectable()
export class ReviewsService {
  constructor(private readonly db: DatabaseService) {}

  // ─── POST /reviews — Buyer đánh giá đơn hàng đã COMPLETED ───────────────
  async createReview(buyerId: string, dto: CreateReviewDto) {
    // 1. Kiểm tra đơn hàng tồn tại và thuộc về buyer này
    const order = await this.db.order.findUnique({
      where: { id: dto.order_id },
      include: {
        order_items: {
          include: { product: true },
        },
      },
    });

    if (!order) throw new NotFoundException('Đơn hàng không tồn tại.');

    if (order.buyer_id !== buyerId)
      throw new ForbiddenException('Bạn không có quyền đánh giá đơn hàng này.');

    if (order.status !== OrderStatus.COMPLETED)
      throw new BadRequestException(
        'Chỉ có thể đánh giá đơn hàng đã hoàn thành (COMPLETED).',
      );

    // 2. Kiểm tra đã đánh giá chưa (mỗi đơn chỉ được đánh giá 1 lần)
    const existing = await this.db.review.findFirst({
      where: { order_id: dto.order_id, reviewer_id: buyerId },
    });

    if (existing) throw new ConflictException('Bạn đã đánh giá đơn hàng này rồi.');

    // 3. Tạo review
    const review = await this.db.review.create({
      data: {
        order_id: dto.order_id,
        reviewer_id: buyerId,
        rating: dto.rating,
        comment: dto.comment,
      },
      include: {
        user: { select: { id: true, full_name: true } },
        order: {
          include: {
            order_items: {
              include: { product: { select: { id: true, name: true } } },
            },
          },
        },
      },
    });

    return {
      message: 'Đánh giá thành công! Cảm ơn bạn đã chia sẻ.',
      data: review,
    };
  }

  // ─── GET /reviews/shop-reviews — Seller xem tất cả đánh giá nhận được ───
  async getShopReviews(sellerId: string) {
    const reviews = await this.db.review.findMany({
      where: { order: { seller_id: sellerId } },
      orderBy: { created_at: 'desc' },
      include: {
        user: { select: { id: true, full_name: true } },
        order: {
          include: {
            order_items: {
              include: {
                product: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    // Lấy avatar của người đánh giá
    const reviewerIds = reviews.map((r) => r.reviewer_id);
    const avatars = await this.db.attachment.findMany({
      where: { target_type: 'AVATAR', target_id: { in: reviewerIds } },
    });
    const avatarMap = avatars.reduce((acc, a) => ({ ...acc, [a.target_id]: a.url }), {} as Record<string, string>);

    // Lấy ảnh sản phẩm trong các đơn được review
    const productIds = reviews.flatMap((r) =>
      r.order.order_items.map((i) => i.product_id),
    );
    const productAttachments = await this.db.attachment.findMany({
      where: { target_type: 'PRODUCT', target_id: { in: productIds } },
    });
    const productImageMap = productAttachments.reduce((acc, a) => {
      if (!acc[a.target_id]) acc[a.target_id] = [];
      acc[a.target_id].push(a.url);
      return acc;
    }, {} as Record<string, string[]>);

    return reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      created_at: r.created_at,
      // Đặt đúng tên field mà FE đọc: buyer.full_name
      buyer: {
        id: r.user?.id ?? null,
        full_name: r.user?.full_name ?? 'Khách hàng',
        avatar: avatarMap[r.reviewer_id] ?? null,
      },
      products: r.order.order_items.map((item) => ({
        id: item.product?.id ?? null,
        name: item.product?.name ?? '',
        images: productImageMap[item.product_id]?.slice(0, 1) ?? [],
      })),
    }));
  }

  // ─── GET /reviews/my-reviews — Xem lại tất cả đánh giá của buyer ────────
  async getMyReviews(buyerId: string) {
    const reviews = await this.db.review.findMany({
      where: { reviewer_id: buyerId },
      orderBy: { created_at: 'desc' },
      include: {
        order: {
          include: {
            order_items: {
              include: {
                product: {
                  select: { id: true, name: true, reference_price: true },
                },
              },
            },
            seller: {
              select: {
                id: true,
                full_name: true,
                profile: { select: { store_name: true } },
              },
            },
          },
        },
      },
    });

    // Lấy ảnh sản phẩm trong các đơn hàng đã review
    const productIds = reviews.flatMap((r) =>
      r.order.order_items.map((i) => i.product_id),
    );

    const attachments = await this.db.attachment.findMany({
      where: { target_type: 'PRODUCT', target_id: { in: productIds } },
    });

    const imageMap = attachments.reduce(
      (acc, att) => {
        if (!acc[att.target_id]) acc[att.target_id] = [];
        acc[att.target_id].push(att.url);
        return acc;
      },
      {} as Record<string, string[]>,
    );

    return reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      created_at: r.created_at,
      order_id: r.order_id,
      shop: {
        id: r.order.seller.id,
        name: r.order.seller.profile?.store_name || r.order.seller.full_name,
      },
      products: r.order.order_items.map((item) => ({
        id: item.product.id,
        name: item.product.name,
        images: imageMap[item.product_id]?.slice(0, 1) ?? [],
      })),
    }));
  }
}
