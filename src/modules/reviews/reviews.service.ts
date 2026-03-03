import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { EmailService } from '../../communication/email/email.service';
import { CreateReviewDto } from './dtos/create-review.dto';
import { ReplyReviewDto } from './dtos/reply-review.dto';
import { OrderStatus, TargetType } from '@prisma/client';

export type ShopReviewFilter = 'all' | 'replied' | 'unreplied';

@Injectable()
export class ReviewsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly emailService: EmailService,
  ) {}

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

    // 3. Tạo review + lưu ảnh đính kèm trong 1 transaction
    const review = await this.db.$transaction(async (tx) => {
      const created = await tx.review.create({
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

      // Lưu ảnh review (FE upload trước → gửi URL vào image_urls[])
      if (dto.image_urls && dto.image_urls.length > 0) {
        await tx.attachment.createMany({
          data: dto.image_urls.map((url) => ({
            url,
            file_type: 'image',
            target_id: created.id,
            target_type: TargetType.REVIEW,
          })),
        });
      }

      return created;
    });

    // 4. Lấy lại ảnh đã lưu để trả về
    const reviewImages = await this.db.attachment.findMany({
      where: { target_id: review.id, target_type: TargetType.REVIEW },
      select: { url: true },
    });

    // 5. Lấy ảnh sản phẩm trong đơn
    const productIds = review.order.order_items.map((i) => i.product_id);
    const productAttachments = await this.db.attachment.findMany({
      where: { target_type: 'PRODUCT', target_id: { in: productIds } },
    });
    const productImageMap = productAttachments.reduce(
      (acc, a) => {
        if (!acc[a.target_id]) acc[a.target_id] = [];
        acc[a.target_id].push(a.url);
        return acc;
      },
      {} as Record<string, string[]>,
    );

    return {
      message: 'Đánh giá thành công! Cảm ơn bạn đã chia sẻ.',
      data: {
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        created_at: review.created_at,
        review_images: reviewImages.map((i) => i.url),
        products: review.order.order_items.map((item) => ({
          id: item.product?.id ?? null,
          name: item.product?.name ?? '',
          images: productImageMap[item.product_id]?.slice(0, 1) ?? [],
        })),
      },
    };
  }

  // ─── GET /reviews/shop-reviews?filter=all|replied|unreplied ─────────────
  // Seller xem tất cả đánh giá nhận được (có phân loại theo trạng thái reply)
  async getShopReviews(sellerId: string, filter: ShopReviewFilter = 'all') {
    const replyFilter =
      filter === 'replied'
        ? { seller_reply: { not: null } }
        : filter === 'unreplied'
          ? { seller_reply: null }
          : {};

    const reviews = await this.db.review.findMany({
      where: { order: { seller_id: sellerId }, ...replyFilter },
      orderBy: { created_at: 'desc' },
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

    // Avatar người đánh giá
    const reviewerIds = [...new Set(reviews.map((r) => r.reviewer_id))];
    const avatars = await this.db.attachment.findMany({
      where: { target_type: 'AVATAR', target_id: { in: reviewerIds } },
    });
    const avatarMap = avatars.reduce(
      (acc, a) => ({ ...acc, [a.target_id]: a.url }),
      {} as Record<string, string>,
    );

    // Ảnh review do buyer đăng tải
    const reviewIds = reviews.map((r) => r.id);
    const reviewAttachments = await this.db.attachment.findMany({
      where: { target_type: 'REVIEW', target_id: { in: reviewIds } },
    });
    const reviewImageMap = reviewAttachments.reduce(
      (acc, a) => {
        if (!acc[a.target_id]) acc[a.target_id] = [];
        acc[a.target_id].push(a.url);
        return acc;
      },
      {} as Record<string, string[]>,
    );

    // Ảnh sản phẩm trong đơn
    const productIds = [
      ...new Set(
        reviews.flatMap((r) => r.order.order_items.map((i) => i.product_id)),
      ),
    ];
    const productAttachments = await this.db.attachment.findMany({
      where: { target_type: 'PRODUCT', target_id: { in: productIds } },
    });
    const productImageMap = productAttachments.reduce(
      (acc, a) => {
        if (!acc[a.target_id]) acc[a.target_id] = [];
        acc[a.target_id].push(a.url);
        return acc;
      },
      {} as Record<string, string[]>,
    );

    // Đếm số review từng tab để FE hiển thị badge
    const total = await this.db.review.count({
      where: { order: { seller_id: sellerId } },
    });
    const repliedCount = await this.db.review.count({
      where: { order: { seller_id: sellerId }, seller_reply: { not: null } },
    });

    return {
      counts: { all: total, replied: repliedCount, unreplied: total - repliedCount },
      reviews: reviews.map((r) => ({
        id: r.id,
        order_id: r.order_id,
        rating: r.rating,
        comment: r.comment,
        created_at: r.created_at,
        review_images: reviewImageMap[r.id] ?? [],
        seller_reply: r.seller_reply ?? null,
        seller_replied_at: r.seller_replied_at ?? null,
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
      })),
    };
  }

  // ─── GET /reviews/my-reviews — Buyer xem lại các đánh giá của mình ──────
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

    // Ảnh review do buyer đăng tải
    const reviewIds = reviews.map((r) => r.id);
    const reviewAttachments = await this.db.attachment.findMany({
      where: { target_type: 'REVIEW', target_id: { in: reviewIds } },
    });
    const reviewImageMap = reviewAttachments.reduce(
      (acc, a) => {
        if (!acc[a.target_id]) acc[a.target_id] = [];
        acc[a.target_id].push(a.url);
        return acc;
      },
      {} as Record<string, string[]>,
    );

    // Ảnh sản phẩm trong các đơn hàng đã review
    const productIds = reviews.flatMap((r) =>
      r.order.order_items.map((i) => i.product_id),
    );
    const productAttachments = await this.db.attachment.findMany({
      where: { target_type: 'PRODUCT', target_id: { in: productIds } },
    });
    const productImageMap = productAttachments.reduce(
      (acc, a) => {
        if (!acc[a.target_id]) acc[a.target_id] = [];
        acc[a.target_id].push(a.url);
        return acc;
      },
      {} as Record<string, string[]>,
    );

    return reviews.map((r) => ({
      id: r.id,
      order_id: r.order_id,
      rating: r.rating,
      comment: r.comment,
      created_at: r.created_at,
      // Ảnh buyer đăng tải khi review
      review_images: reviewImageMap[r.id] ?? [],
      // Phản hồi của người bán
      seller_reply: r.seller_reply ?? null,
      seller_replied_at: r.seller_replied_at ?? null,
      shop: {
        id: r.order.seller.id,
        name: r.order.seller.profile?.store_name || r.order.seller.full_name,
      },
      products: r.order.order_items.map((item) => ({
        id: item.product.id,
        name: item.product.name,
        images: productImageMap[item.product_id]?.slice(0, 1) ?? [],
      })),
    }));
  }

  // ─── PATCH /reviews/:id/reply — Seller phản hồi đánh giá ─────────────────
  async replyToReview(sellerId: string, reviewId: string, dto: ReplyReviewDto) {
    const review = await this.db.review.findUnique({
      where: { id: reviewId },
      include: {
        order: {
          include: {
            seller: {
              select: {
                id: true,
                full_name: true,
                profile: { select: { store_name: true } },
              },
            },
            buyer: { select: { id: true, full_name: true, email: true } },
          },
        },
      },
    });

    if (!review) throw new NotFoundException('Đánh giá không tồn tại.');

    if (review.order.seller_id !== sellerId)
      throw new ForbiddenException('Bạn không có quyền phản hồi đánh giá này.');

    // Chỉ được reply 1 lần để đảm bảo tính minh bạch
    if (review.seller_reply)
      throw new ConflictException('Bạn đã phản hồi đánh giá này rồi.');

    const updated = await this.db.review.update({
      where: { id: reviewId },
      data: {
        seller_reply: dto.reply,
        seller_replied_at: new Date(),
      },
    });

    // Gửi email thông báo cho buyer
    const buyer = review.order.buyer;
    const sellerName =
      review.order.seller.profile?.store_name || review.order.seller.full_name;

    await this.emailService.sendSellerReplyEmail(
      buyer.email,
      buyer.full_name,
      sellerName,
      review.order_id,
      dto.reply,
    );

    return {
      message: 'Đã gửi phản hồi thành công.',
      data: {
        review_id: updated.id,
        seller_reply: updated.seller_reply,
        seller_replied_at: updated.seller_replied_at,
      },
    };
  }
}
