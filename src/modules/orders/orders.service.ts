import {
    Injectable,
    BadRequestException,
    NotFoundException,
    ForbiddenException,
    HttpException,
    InternalServerErrorException,
    Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../../database/database.service';
import { EmailService } from '../../communication/email/email.service';
import { PaymentsService } from '../payments/payments.service';
import { CreateOrderDto } from './dtos/create-order.dto';
import { OrderStatus, PaymentStatus, PaymentMethod } from '@prisma/client';

// Số ngày sau khi giao hàng buyer mới được phép báo sự cố (SHIPPING overdue window)
const REPORT_ISSUE_DELAY_DAYS = 3;
// Cửa sổ tranh chấp 3 ngày sau khi đơn được xác nhận DELIVERED (COMPLETED).
const POST_DELIVERY_DISPUTE_WINDOW_DAYS = 3;
// Đơn MoMo chờ thanh toán quá ngưỡng này sẽ bị cron tự cancel.
const UNPAID_MOMO_ORDER_TIMEOUT_HOURS = 24;
// Cache TTL cho seller dashboard — đủ ngắn để số liệu vẫn "gần real-time",
// đủ dài để tránh re-aggregate khi seller F5 dashboard liên tục.
const SELLER_DASHBOARD_CACHE_TTL_MS = 60_000;

type SellerProductStatRow = {
    id: string;
    name: string;
    sold: number;
    avg_rating: number | null;
    review_count: number;
};

type SellerMonthlyRevenueRow = {
    month: string;
    revenue: number | string | null;
};

type SellerDashboardSnapshot = {
    totalRevenue: number;
    totalOrders: number;
    activeProducts: number;
    revenueByMonth: { month: string; revenue: number }[];
    top3BestSelling: { id: string; name: string; sold: number; avgRating: number | null; reviewCount: number }[];
    top3NeedImprovement: { id: string; name: string; sold: number; avgRating: number | null; reviewCount: number }[];
};

@Injectable()
export class OrdersService {
    private readonly logger = new Logger(OrdersService.name);

    // In-memory snapshot cache per seller. Map vì số seller hữu hạn, không cần
    // Redis cho stage hiện tại; eviction phụ thuộc TTL chứ không có size cap —
    // chấp nhận được vì payload mỗi entry chỉ ~vài KB.
    private readonly dashboardCache = new Map<string, { value: SellerDashboardSnapshot; expiresAt: number }>();

    constructor(
        private readonly databaseService: DatabaseService,
        private readonly emailService: EmailService,
        private readonly paymentsService: PaymentsService,
    ) { }

    async checkout(buyerId: string, dto: CreateOrderDto) {
        if (!dto.seller_orders || dto.seller_orders.length === 0) {
            throw new BadRequestException('Giỏ hàng của bạn đang trống.');
        }

        // ── Pre-validate: kiểm tra tất cả sản phẩm tồn tại và đúng shop ────────────
        const allProductIds = dto.seller_orders.flatMap((so) => so.items.map((i) => i.product_id));
        const dbProducts = await this.databaseService.product.findMany({
            where: { id: { in: allProductIds } },
            select: { id: true, seller_id: true, is_active: true },
        });

        if (dbProducts.length !== allProductIds.length) {
            throw new NotFoundException('Một hoặc nhiều sản phẩm không tồn tại.');
        }

        const productMap = new Map(dbProducts.map((p) => [p.id, p]));

        // Xác nhận sản phẩm thuộc đúng seller và đang active
        for (const sellerOrder of dto.seller_orders) {
            for (const item of sellerOrder.items) {
                const p = productMap.get(item.product_id)!;
                if (!p.is_active) {
                    throw new BadRequestException(`Sản phẩm ${item.product_id} đã ngừng bán.`);
                }
                if (p.seller_id !== sellerOrder.seller_id) {
                    throw new BadRequestException(
                        `Sản phẩm ${item.product_id} không thuộc shop ${sellerOrder.seller_id}.`
                    );
                }
            }
        }

        // Batched seller validation — 1 round-trip thay vì N. Trước đây mỗi shop
        // gọi user.findUnique() bên trong $transaction, với proxy DB chậm (Railway)
        // 5 shop dễ vượt timeout 5s mặc định → "Transaction already closed".
        const sellerIds = [...new Set(dto.seller_orders.map((so) => so.seller_id))];
        const sellers = await this.databaseService.user.findMany({
            where: { id: { in: sellerIds } },
            select: { id: true, is_seller: true },
        });
        const sellerMap = new Map(sellers.map((s) => [s.id, s]));
        for (const so of dto.seller_orders) {
            const s = sellerMap.get(so.seller_id);
            if (!s) throw new NotFoundException(`Người bán (ID: ${so.seller_id}) không tồn tại.`);
            if (!s.is_seller) throw new BadRequestException(`ID ${so.seller_id} không phải SELLER.`);
        }

        try {
            const { sessionId, results: createdOrders } = await this.databaseService.$transaction(async (prisma) => {
                const results: {
                    seller_id: string;
                    order_id: string;
                    subtotal: number;
                    discount: number;
                    final: number;
                }[] = [];

                // Tạo CheckoutSession trước để mỗi Order FK tới nó. total_amount=0
                // placeholder, cập nhật lại sau khi cộng đủ các shop (single-shop =
                // session 1 đơn, vẫn dùng chung path).
                const session = await prisma.checkoutSession.create({
                    data: { buyer_id: buyerId, total_amount: 0 },
                });

                for (const sellerOrder of dto.seller_orders) {
                    const { seller_id: sellerId, items, voucher_code } = sellerOrder;
                    // Seller đã được validate batched bên ngoài $transaction (xem sellerMap ở trên).

                    // Tính subtotal
                    const subtotal = items.reduce(
                        (sum, item) => sum + Number(item.price) * Number(item.quantity),
                        0,
                    );

                    // ── Validate + áp dụng voucher riêng của shop này ─────────────────
                    let voucherId: string | null = null;
                    let discountAmount = 0;
                    let finalPrice = subtotal;

                    if (voucher_code) {
                        const now = new Date();
                        const voucher = await prisma.voucher.findUnique({
                            where: {
                                seller_id_code: { seller_id: sellerId, code: voucher_code.toUpperCase() },
                            },
                        });

                        const isStructurallyValid =
                            voucher &&
                            voucher.is_active &&
                            now >= voucher.valid_from &&
                            now <= voucher.valid_to &&
                            subtotal >= Number(voucher.min_order_value);

                        if (!voucher || !isStructurallyValid) {
                            // Mã có nhưng không hợp lệ — throw lỗi rõ ràng cho FE
                            throw new BadRequestException(
                                `Mã giảm giá "${voucher_code}" không hợp lệ hoặc không thể áp dụng cho đơn này.`
                            );
                        }

                        // Race-safe: tăng used_count atomically tại DB.
                        // updateMany với where(used_count < usage_limit) dịch ra SQL
                        // `UPDATE ... WHERE used_count < N` — Postgres row-lock đảm bảo
                        // hai checkout song song không thể cùng vượt usage_limit.
                        const incrementResult = await prisma.voucher.updateMany({
                            where: {
                                id: voucher.id,
                                used_count: { lt: voucher.usage_limit },
                                is_active: true,
                                valid_from: { lte: now },
                                valid_to: { gte: now },
                            },
                            data: { used_count: { increment: 1 } },
                        });

                        if (incrementResult.count === 0) {
                            throw new BadRequestException(
                                `Mã giảm giá "${voucher_code}" đã hết lượt sử dụng.`
                            );
                        }

                        if (voucher.discount_type === 'PERCENT') {
                            discountAmount = (subtotal * Number(voucher.discount_value)) / 100;
                            discountAmount = Math.min(discountAmount, Number(voucher.max_discount_amount));
                        } else {
                            discountAmount = Number(voucher.discount_value);
                        }
                        discountAmount = Math.floor(Math.min(discountAmount, subtotal));
                        finalPrice = subtotal - discountAmount;
                        voucherId = voucher.id;
                    }

                    // Tạo Order
                    const newOrder = await prisma.order.create({
                        data: {
                            buyer_id: buyerId,
                            seller_id: sellerId,
                            checkout_session_id: session.id,
                            shipping_address: dto.shipping_address,
                            payment_method: dto.payment_method,
                            note: dto.note,
                            final_total_price: finalPrice,
                            voucher_id: voucherId,
                            discount_amount: discountAmount,
                            status: 'PENDING',
                            order_items: {
                                create: items.map((item) => ({
                                    product_id: item.product_id,
                                    quantity: item.quantity,
                                    negotiated_price: item.price,
                                })),
                            },
                        },
                    });

                    // Tạo Payment — ownership thuộc PaymentsService, OrdersService chỉ
                    // hand off tx hiện hành để vẫn nằm trong cùng atomic transaction.
                    await this.paymentsService.createInitialPayment(prisma, {
                        orderId: newOrder.id,
                        payerId: buyerId,
                        amount: finalPrice,
                        method: dto.payment_method,
                    });

                    results.push({
                        seller_id: sellerId,
                        order_id: newOrder.id,
                        subtotal,
                        discount: discountAmount,
                        final: finalPrice,
                    });
                }

                // Cập nhật total_amount thật sau khi đã cộng đủ các shop.
                const grandTotal = results.reduce((sum, o) => sum + o.final, 0);
                await prisma.checkoutSession.update({
                    where: { id: session.id },
                    data: { total_amount: grandTotal },
                });

                return { sessionId: session.id, results };
            }, {
                // Railway proxy có latency ~100-300ms/query; checkout nhiều shop dễ vượt
                // default 5s. 15s đủ rộng cho giỏ ~10 shop mà không che giấu deadlock thật.
                timeout: 15_000,
                maxWait: 5_000,
            });

            const totalPaid = createdOrders.reduce((sum, o) => sum + o.final, 0);

            return {
                message: 'Đặt hàng thành công!',
                checkout_session_id: sessionId,
                order_ids: createdOrders.map((o) => o.order_id),
                total_paid: totalPaid,
                seller_orders: createdOrders,
            };

        } catch (error) {
            // Preserve any HttpException (BadRequest, NotFound, voucher-exhausted, ...) — bubble up
            // với status code và message gốc để FE hiển thị đúng nguyên nhân.
            if (error instanceof HttpException) {
                throw error;
            }
            // Lỗi không xác định (DB deadlock, connection lost, runtime bug...) → log stack trace
            // và trả về 500 thay vì che giấu thành 400.
            this.logger.error(
                'Checkout failed with an unexpected error',
                (error as Error)?.stack ?? String(error),
            );
            throw new InternalServerErrorException(
                'Đã có lỗi hệ thống xảy ra khi đặt hàng. Vui lòng thử lại sau.',
            );
        }
    }

    async getUserOrders(userId: string) {
        const orders = await this.databaseService.order.findMany({
            where: { buyer_id: userId },
            include: {
                order_items: {
                    include: {
                        product: true,
                    },
                },
                seller: {
                    select: {
                        full_name: true,
                        profile: {
                            select: { store_name: true },
                        },
                    },
                },
                payments: {
                    select: {
                        id: true,
                        amount: true,
                        payment_method: true,
                        status: true,
                        created_at: true,
                    },
                },
                reviews: {
                    select: {
                        id: true,
                        rating: true,
                        comment: true,
                        reviewer_id: true,
                        created_at: true,
                    },
                },
            },
            orderBy: {
                created_at: 'desc',
            },
        });

        // Lấy tất cả product_id từ các đơn hàng
        const productIds = orders.flatMap((o) =>
            o.order_items.map((item) => item.product_id),
        );

        // Fetch ảnh sản phẩm từ bảng Attachment (polymorphic)
        const attachments = await this.databaseService.attachment.findMany({
            where: {
                target_type: 'PRODUCT',
                target_id: { in: productIds },
            },
        });

        // Map: product_id -> danh sách url ảnh
        const imageMap = attachments.reduce(
            (acc, att) => {
                if (!acc[att.target_id]) acc[att.target_id] = [];
                acc[att.target_id].push(att.url);
                return acc;
            },
            {} as Record<string, string[]>,
        );

        // Gắn images vào từng product trong order_items
        return orders.map((order) => ({
            ...order,
            order_items: order.order_items.map((item) => ({
                ...item,
                product: {
                    ...item.product,
                    images: imageMap[item.product_id] ?? [],
                },
            })),
        }));
    }

    // =====================================================
    // SELLER: Lấy danh sách đơn hàng đã nhận (theo shop)
    // =====================================================
    async getSellerOrders(sellerId: string) {
        const orders = await this.databaseService.order.findMany({
            where: { seller_id: sellerId },
            include: {
                order_items: {
                    include: { product: true },
                },
                buyer: {
                    select: {
                        id: true,
                        full_name: true,
                        email: true,
                        phone_number: true,
                    },
                },
            },
            orderBy: { created_at: 'desc' },
        });

        const productIds = orders.flatMap((o) => o.order_items.map((i) => i.product_id));
        const attachments = await this.databaseService.attachment.findMany({
            where: { target_type: 'PRODUCT', target_id: { in: productIds } },
        });
        const imageMap = attachments.reduce((acc, att) => {
            if (!acc[att.target_id]) acc[att.target_id] = [];
            acc[att.target_id].push(att.url);
            return acc;
        }, {} as Record<string, string[]>);

        return orders.map((order) => ({
            ...order,
            order_items: order.order_items.map((item) => ({
                ...item,
                product: { ...item.product, images: imageMap[item.product_id] ?? [] },
            })),
        }));
    }

    // =====================================================
    // Helper: lấy đơn hàng và kiểm tra trạng thái hợp lệ
    // =====================================================
    private async findOrderOrFail(orderId: string) {
        const order = await this.databaseService.order.findUnique({
            where: { id: orderId },
            include: {
                buyer: { select: { id: true, full_name: true, email: true } },
            },
        });
        if (!order) throw new NotFoundException(`Đơn hàng #${orderId} không tồn tại.`);
        return order;
    }

    // =====================================================
    // SELLER: PENDING → CONFIRMED (xác nhận đơn)
    // =====================================================
    async confirmOrder(sellerId: string, orderId: string) {
        const order = await this.findOrderOrFail(orderId);

        if (order.seller_id !== sellerId)
            throw new ForbiddenException('Bạn không có quyền xác nhận đơn hàng này.');

        if (order.status !== OrderStatus.PENDING)
            throw new BadRequestException(
                `Chỉ đơn ở trạng thái PENDING mới có thể xác nhận. Trạng thái hiện tại: ${order.status}`,
            );

        return this.databaseService.order.update({
            where: { id: orderId },
            data: { status: OrderStatus.CONFIRMED },
        });
    }

    // =====================================================
    // SELLER: CONFIRMED → SHIPPING (gửi đơn hàng)
    // =====================================================
    async shipOrder(sellerId: string, orderId: string) {
        const order = await this.findOrderOrFail(orderId);

        if (order.seller_id !== sellerId)
            throw new ForbiddenException('Bạn không có quyền cập nhật đơn hàng này.');

        if (order.status !== OrderStatus.CONFIRMED)
            throw new BadRequestException(
                `Chỉ đơn ở trạng thái CONFIRMED mới có thể gửi. Trạng thái hiện tại: ${order.status}`,
            );

        // Ghi shipped_at — dùng để tính timer cho nút "Chưa nhận hàng" ở FE
        return this.databaseService.order.update({
            where: { id: orderId },
            data: {
                status: OrderStatus.SHIPPING,
                shipped_at: new Date(),
            },
        });
    }

    // =====================================================
    // BUYER: SHIPPING → COMPLETED
    // Xác nhận nhận hàng ⇒ chữ ký điện tử, đồng thời SET PAID
    // =====================================================
    async completeOrder(buyerId: string, orderId: string) {
        const order = await this.findOrderOrFail(orderId);

        if (order.buyer_id !== buyerId)
            throw new ForbiddenException('Bạn không có quyền xác nhận nhận hàng.');

        if (order.status !== OrderStatus.SHIPPING)
            throw new BadRequestException(
                `Chỉ đơn ở trạng thái SHIPPING mới có thể hoàn thành. Trạng thái hiện tại: ${order.status}`,
            );

        // Atomic: đồng thời cập nhật Order=COMPLETED và Payment=PAID
        // Với COD: đây là xác nhận đã trả tiền khi nhận hàng
        // Với Online: xác nhận đã nhận hàng (tiền đã trả từ trước)
        await this.databaseService.$transaction(async (tx) => {
            await tx.order.update({
                where: { id: orderId },
                data: { status: OrderStatus.COMPLETED },
            });
            await this.paymentsService.markPaid(tx, orderId);
        });

        return { message: 'Đã xác nhận nhận hàng và thanh toán thành công.' };
    }

    // =====================================================
    // BUYER: SHIPPING → ISSUE_REPORTED (báo chưa nhận hàng)
    // Chỉ được phép sau REPORT_ISSUE_DELAY_DAYS ngày kể từ khi giao
    // =====================================================
    async reportIssue(buyerId: string, orderId: string, note?: string) {
        const order = await this.databaseService.order.findUnique({
            where: { id: orderId },
            include: {
                buyer: { select: { id: true, full_name: true, email: true } },
                seller: { select: { id: true, full_name: true, email: true } },
            },
        });

        if (!order) throw new NotFoundException(`Đơn hàng #${orderId} không tồn tại.`);

        if (order.buyer_id !== buyerId)
            throw new ForbiddenException('Bạn không có quyền báo sự cố đơn hàng này.');

        if (order.status !== OrderStatus.SHIPPING)
            throw new BadRequestException(
                `Chỉ đơn ở trạng thái SHIPPING mới có thể báo sự cố. Hiện tại: ${order.status}`,
            );

        // Kiểm tra timer: phải đợi đủ REPORT_ISSUE_DELAY_DAYS ngày sau khi giao
        // Nếu shipped_at null (đơn cũ), fallback về updated_at (thời điểm chuyển SHIPPING)
        const referenceTime = order.shipped_at ?? order.updated_at;

        const now = new Date();
        const diffMs = now.getTime() - referenceTime.getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);

        if (diffDays < REPORT_ISSUE_DELAY_DAYS) {
            const remainingHours = Math.ceil(
                (REPORT_ISSUE_DELAY_DAYS * 24) - (diffMs / (1000 * 60 * 60))
            );
            throw new BadRequestException(
                `Bạn chỉ có thể báo sự cố sau ${REPORT_ISSUE_DELAY_DAYS} ngày kể từ khi đơn hàng được giao. ` +
                `Còn khoảng ${remainingHours} giờ nữa.`,
            );
        }

        const issueNote = note ?? 'Người mua báo chưa nhận được hàng.';

        const updated = await this.databaseService.order.update({
            where: { id: orderId },
            data: {
                status: OrderStatus.ISSUE_REPORTED,
                note: issueNote,
            },
        });

        try {
            // Gửi email xác nhận cho BUYER
            if (order.buyer?.email) {
                await this.emailService.sendIssueReportedToBuyerEmail(
                    order.buyer.email,
                    order.buyer.full_name,
                    order.seller?.full_name ?? 'Người bán',
                    orderId,
                    issueNote,
                );
            } else {
                console.warn(`[WARN] Buyer email not found for order #${orderId}`);
            }

            // Gửi email cảnh báo cho SELLER — yêu cầu đối soát với bên vận chuyển
            if (order.seller?.email) {
                await this.emailService.sendIssueReportedToSellerEmail(
                    order.seller.email,
                    order.seller.full_name,
                    order.buyer?.full_name ?? 'Người mua',
                    orderId,
                    order.payment_method,
                    issueNote,
                );
            } else {
                console.warn(`[WARN] Seller email not found for order #${orderId}`);
            }
        } catch (error) {
            this.logger.error('Lỗi gửi email:', error);
        }

        return {
            message: 'Đã báo sự cố thành công. Người bán sẽ được thông báo để xác nhận.',
            data: updated,
        };
    }

    // =====================================================
    // BUYER: "Tôi chưa nhận được hàng" — refund/dispute flow
    //
    // Rule 1 (COD):       Order → RETURNED. Payment giữ UNPAID (no money to refund).
    // Rule 2 (validation): SHIPPING quá REPORT_ISSUE_DELAY_DAYS từ shipped_at, HOẶC
    //                      COMPLETED trong POST_DELIVERY_DISPUTE_WINDOW_DAYS từ updated_at.
    //                      Mọi trạng thái khác → 400.
    // Rule 3 (MoMo paid): Order → REFUND_PENDING, Payment → REFUNDING.
    //                      Đợi admin gọi /orders/:id/refund (Rule 4) hoặc auto-refund.
    // Rule 4 (refund exec): xem PaymentsService.refundMomoTransaction.
    //
    // Tất cả update Order + Payment đều nằm trong cùng $transaction.
    // =====================================================
    async reportItemNotReceived(buyerId: string, orderId: string, note?: string) {
        const order = await this.databaseService.order.findUnique({
            where: { id: orderId },
            include: {
                buyer: { select: { id: true, full_name: true, email: true } },
                seller: { select: { id: true, full_name: true, email: true } },
                payments: true,
            },
        });
        if (!order) throw new NotFoundException(`Đơn hàng #${orderId} không tồn tại.`);
        if (order.buyer_id !== buyerId) {
            throw new ForbiddenException('Bạn không có quyền báo sự cố đơn hàng này.');
        }

        // ── Rule 2: validation ─────────────────────────────────────────────
        const now = Date.now();
        const dayMs = 1000 * 60 * 60 * 24;
        let allowed = false;
        if (order.status === OrderStatus.SHIPPING) {
            const ref = (order.shipped_at ?? order.updated_at).getTime();
            if ((now - ref) / dayMs >= REPORT_ISSUE_DELAY_DAYS) allowed = true;
        } else if (order.status === OrderStatus.COMPLETED) {
            const ref = order.updated_at.getTime();
            if ((now - ref) / dayMs <= POST_DELIVERY_DISPUTE_WINDOW_DAYS) allowed = true;
        }
        if (!allowed) {
            throw new BadRequestException(
                `Không thể báo "chưa nhận hàng" cho đơn ở trạng thái ${order.status}. ` +
                `Chỉ áp dụng khi SHIPPING quá ${REPORT_ISSUE_DELAY_DAYS} ngày, ` +
                `hoặc COMPLETED trong vòng ${POST_DELIVERY_DISPUTE_WINDOW_DAYS} ngày.`,
            );
        }

        const issueNote = note ?? 'Người mua báo chưa nhận được hàng.';
        const isCod = order.payment_method === PaymentMethod.COD;
        const isMomo = order.payment_method === PaymentMethod.MOMO;
        const payment = order.payments?.[0];
        const paymentAlreadyPaid = payment?.status === PaymentStatus.PAID;

        // ── Rule 1 (COD): no money moved, just mark RETURNED ───────────────
        if (isCod) {
            await this.databaseService.$transaction(async (tx) => {
                await tx.order.update({
                    where: { id: orderId },
                    data: { status: OrderStatus.RETURNED, note: issueNote },
                });
                await this.paymentsService.markFailed(tx, orderId);
            });
            return { message: 'Đơn COD đã được đánh dấu RETURNED. Không phát sinh hoàn tiền.' };
        }

        // ── Rule 3 (MoMo prepaid): queue + auto-refund ngay ─────────────────
        // Bước 1 (tx): Order=REFUND_PENDING + Payment=REFUNDING.
        // Bước 2: gọi MoMo refund API — refundMomoTransaction chấp nhận
        //   Payment.status REFUNDING, idempotent với REFUNDED, và khi thành công
        //   sẽ tự flip Order=REFUNDED + Payment=REFUNDED trong transaction nội bộ.
        // Nếu MoMo từ chối: giữ nguyên REFUND_PENDING/REFUNDING để admin retry,
        //   không throw lên buyer (họ đã hoàn tất report).
        if (isMomo && paymentAlreadyPaid) {
            await this.databaseService.$transaction(async (tx) => {
                await tx.order.update({
                    where: { id: orderId },
                    data: { status: OrderStatus.REFUND_PENDING, note: issueNote },
                });
                await this.paymentsService.markRefunding(tx, orderId);
            });

            try {
                this.logger.log(
                    `Refund MoMo order ${orderId} (session=${order.checkout_session_id ?? 'legacy'}) amount=${order.final_total_price}`,
                );
                // Đơn mới thuộc CheckoutSession → partial refund theo session; đơn cũ → legacy.
                if (order.checkout_session_id) {
                    await this.paymentsService.refundPayment(
                        order.checkout_session_id,
                        Number(order.final_total_price),
                        { orderId, reason: issueNote },
                    );
                } else {
                    await this.paymentsService.refundMomoTransaction(
                        orderId,
                        Number(order.final_total_price),
                        issueNote,
                    );
                }
                return {
                    message: 'Đã hoàn tiền MoMo thành công. Đơn chuyển sang REFUNDED.',
                    refunded: true,
                };
            } catch (err) {
                this.logger.error(
                    `Auto-refund MoMo failed for order ${orderId}: ${(err as Error).message}. ` +
                    `Đơn giữ ở REFUND_PENDING để admin xử lý lại.`,
                );
                return {
                    message: 'Đã ghi nhận tranh chấp MoMo. Hệ thống sẽ hoàn tiền sau khi admin xác nhận.',
                    refunded: false,
                };
            }
        }

        // ── Other prepaid (QR_CODE/ZALOPAY) or MoMo-but-not-paid ───────────
        // Fallback to legacy ISSUE_REPORTED + REFUNDING flow.
        await this.databaseService.$transaction(async (tx) => {
            await tx.order.update({
                where: { id: orderId },
                data: { status: OrderStatus.ISSUE_REPORTED, note: issueNote },
            });
            if (paymentAlreadyPaid) {
                await this.paymentsService.markRefunding(tx, orderId);
            }
        });
        return { message: 'Đã ghi nhận sự cố, đang chờ xử lý.' };
    }

    // =====================================================
    // SELLER: ISSUE_REPORTED → FAILED (xác nhận hàng thất lạc)
    // Nếu đã thanh toán trước (non-COD) ⇒ set REFUNDING + gửi email
    // =====================================================
    async confirmLost(sellerId: string, orderId: string) {
        const order = await this.databaseService.order.findUnique({
            where: { id: orderId },
            include: {
                buyer: { select: { id: true, full_name: true, email: true } },
                seller: { select: { id: true, full_name: true } },
            },
        });

        if (!order) throw new NotFoundException(`Đơn hàng #${orderId} không tồn tại.`);

        if (order.seller_id !== sellerId)
            throw new ForbiddenException('Bạn không có quyền xử lý đơn hàng này.');

        if (order.status !== OrderStatus.ISSUE_REPORTED)
            throw new BadRequestException(
                `Chỉ đơn ở trạng thái ISSUE_REPORTED mới có thể xác nhận thất lạc. Hiện tại: ${order.status}`,
            );

        const isPrepaid = order.payment_method !== PaymentMethod.COD;
        const newPaymentStatus = isPrepaid ? PaymentStatus.REFUNDING : PaymentStatus.FAILED;
        const sellerName = order.seller?.full_name ?? 'Người bán';

        // Atomic: Order=FAILED + cập nhật Payment theo loại
        await this.databaseService.$transaction(async (tx) => {
            await tx.order.update({
                where: { id: orderId },
                data: { status: OrderStatus.FAILED },
            });
            if (isPrepaid) {
                await this.paymentsService.markRefunding(tx, orderId);
            } else {
                await this.paymentsService.markFailed(tx, orderId);
            }
        });

        try {
            if (order.buyer?.email) {
                if (isPrepaid) {
                    // Non-COD: đã trả tiền trước ⇒ gửi email thông báo hoàn tiền
                    await this.emailService.sendRefundNotificationEmail(
                        order.buyer.email,
                        order.buyer.full_name,
                        orderId,
                        order.final_total_price.toString(),
                        order.payment_method,
                    );
                } else {
                    // COD: chưa trả tiền ⇒ gửi email báo giao thất bại, không mất tiền
                    await this.emailService.sendOrderFailedCodEmail(
                        order.buyer.email,
                        order.buyer.full_name,
                        sellerName,
                        orderId,
                    );
                }
            } else {
                console.warn(`[WARN] Buyer email not found for order #${orderId}`);
            }
        } catch (error) {
            this.logger.error('Lỗi gửi email:', error);
        }

        // Hoàn tiền thật qua MoMo nếu đã trả trước bằng MoMo
        if (isPrepaid && order.payment_method === PaymentMethod.MOMO) {
            try {
                this.logger.log(
                    `Refund MoMo order ${orderId} (session=${order.checkout_session_id ?? 'legacy'}) — seller confirmed lost`,
                );
                // Đơn mới thuộc CheckoutSession → partial refund theo session; đơn cũ → legacy.
                if (order.checkout_session_id) {
                    await this.paymentsService.refundPayment(
                        order.checkout_session_id,
                        Number(order.final_total_price),
                        { orderId, reason: 'Người bán xác nhận thất lạc hàng' },
                    );
                } else {
                    await this.paymentsService.refundMomoTransaction(
                        orderId,
                        Number(order.final_total_price),
                        'Người bán xác nhận thất lạc hàng',
                    );
                    // Legacy: safety mirror nếu status còn REFUNDING.
                    await this.paymentsService.markRefunded(this.databaseService, orderId);
                }
            } catch (error) {
                this.logger.error(
                    `Lỗi hoàn tiền MoMo cho đơn ${orderId}: ${(error as Error).message}. Payment giữ ở REFUNDING để admin xử lý lại.`,
                );
            }
        }

        return {
            message: isPrepaid
                ? 'Xác nhận thất lạc. Hệ thống đang tiến hành hoàn tiền cho người mua.'
                : 'Xác nhận giao thất bại. Đơn hàng đã được đóng và người mua đã được thông báo.',
            payment_status: newPaymentStatus,
        };
    }

    // =====================================================
    // SELLER: (PENDING | CONFIRMED) → CANCELLED + gửi email
    // =====================================================
    async cancelOrderBySeller(sellerId: string, orderId: string, reason: string) {
        const order = await this.findOrderOrFail(orderId);

        if (order.seller_id !== sellerId)
            throw new ForbiddenException('Bạn không có quyền hủy đơn hàng này.');

        const cancellableStatuses: OrderStatus[] = [OrderStatus.PENDING, OrderStatus.CONFIRMED];
        if (!cancellableStatuses.includes(order.status as OrderStatus))
            throw new BadRequestException(
                `Không thể hủy đơn ở trạng thái ${order.status}. Chỉ hủy được khi PENDING hoặc CONFIRMED.`,
            );

        const updated = await this.databaseService.order.update({
            where: { id: orderId },
            data: { status: OrderStatus.CANCELLED },
        });

        // Gửi email thông báo hủy cho người mua
        try {
            if (order.buyer?.email) {
                await this.emailService.sendCancelOrderEmail(
                    order.buyer.email,
                    order.buyer.full_name,
                    orderId,
                    reason,
                );
            }
        } catch (error) {
            this.logger.error('Lỗi gửi email:', error);
        }

        return { ...updated, cancel_reason: reason };
    }

    // =====================================================
    // BUYER: PENDING → CANCELLED (tự hủy khi chờ xác nhận)
    // =====================================================
    async cancelOrderByBuyer(buyerId: string, orderId: string) {
        const order = await this.findOrderOrFail(orderId);

        if (order.buyer_id !== buyerId)
            throw new ForbiddenException('Bạn không có quyền hủy đơn hàng này.');

        if (order.status !== OrderStatus.PENDING)
            throw new BadRequestException(
                `Chỉ có thể hủy đơn khi đang ở trạng thái PENDING. Trạng thái hiện tại: ${order.status}`,
            );

        return this.databaseService.order.update({
            where: { id: orderId },
            data: { status: OrderStatus.CANCELLED },
        });
    }

    // =====================================================
    // BUYER: Đổi phương thức thanh toán cho đơn còn UNPAID
    //
    // Use case: buyer chọn MoMo lúc checkout nhưng không thanh toán → muốn chuyển
    // sang COD để đơn được xử lý ngay thay vì bị cron tự huỷ sau 24h.
    // Constraints:
    //   - Order.status phải là PENDING (chưa seller-confirm).
    //   - Payment.status phải là UNPAID (chưa từng PAID — không refund halfway).
    //   - Chỉ cho phép chuyển TỚI COD (đơn giản hoá; mở rộng sau nếu cần).
    // Cả 2 update nằm trong cùng $transaction để Order.payment_method và
    // Payment.payment_method không lệch nhau.
    // =====================================================
    async changePaymentMethod(
        buyerId: string,
        orderId: string,
        newMethod: PaymentMethod,
    ) {
        const order = await this.databaseService.order.findUnique({
            where: { id: orderId },
            include: { payments: true },
        });
        if (!order) throw new NotFoundException(`Đơn hàng #${orderId} không tồn tại.`);
        if (order.buyer_id !== buyerId) {
            throw new ForbiddenException('Bạn không có quyền sửa đơn này.');
        }
        if (order.status !== OrderStatus.PENDING) {
            throw new BadRequestException(
                `Chỉ đổi được phương thức khi đơn ở trạng thái PENDING. Hiện tại: ${order.status}`,
            );
        }
        const payment = order.payments?.[0];
        if (payment && payment.status !== PaymentStatus.UNPAID) {
            throw new BadRequestException(
                `Đơn đã có giao dịch ở trạng thái ${payment.status} — không thể đổi phương thức.`,
            );
        }
        if (newMethod !== PaymentMethod.COD) {
            throw new BadRequestException(
                'Hiện chỉ hỗ trợ đổi sang COD. Để thanh toán online, vui lòng huỷ và đặt lại đơn.',
            );
        }
        if (order.payment_method === newMethod) {
            return { message: 'Phương thức đã là COD, không thay đổi gì.', orderId };
        }

        await this.databaseService.$transaction(async (tx) => {
            await tx.order.update({
                where: { id: orderId },
                data: { payment_method: newMethod },
            });
            await this.paymentsService.changeMethod(tx, orderId, newMethod);
        });

        return {
            message: 'Đã chuyển sang thanh toán khi nhận hàng (COD). Người bán sẽ xác nhận đơn.',
            orderId,
            payment_method: newMethod,
        };
    }

    // =====================================================
    // CRON: tự huỷ đơn MoMo chưa thanh toán quá 24h
    //
    // Chạy mỗi giờ. Tìm Order(status=PENDING, payment_method=MOMO,
    // created_at < now - 24h) có Payment(status=UNPAID) → flip
    // Order=CANCELLED + Payment=FAILED trong $transaction.
    // =====================================================
    @Cron(CronExpression.EVERY_HOUR)
    async cancelStaleUnpaidMomoOrders() {
        const cutoff = new Date(Date.now() - UNPAID_MOMO_ORDER_TIMEOUT_HOURS * 60 * 60 * 1000);

        const stale = await this.databaseService.order.findMany({
            where: {
                status: OrderStatus.PENDING,
                payment_method: PaymentMethod.MOMO,
                created_at: { lt: cutoff },
                payments: { some: { status: PaymentStatus.UNPAID } },
            },
            select: { id: true },
        });

        if (stale.length === 0) {
            this.logger.debug(`[cron] No stale unpaid MoMo orders.`);
            return;
        }

        const ids = stale.map((o) => o.id);
        await this.databaseService.$transaction(async (tx) => {
            await tx.order.updateMany({
                where: { id: { in: ids } },
                data: { status: OrderStatus.CANCELLED },
            });
            await this.paymentsService.batchFailUnpaid(tx, ids);
        });

        this.logger.log(`[cron] Auto-cancelled ${ids.length} unpaid MoMo orders older than ${UNPAID_MOMO_ORDER_TIMEOUT_HOURS}h: ${ids.join(', ')}`);
    }

    // =====================================================
    // SELLER: Summary tổng quan (revenue + orderCount)
    //
    // Push toàn bộ aggregation xuống Postgres: COUNT cho tổng đơn,
    // SUM(final_total_price) cho doanh thu — thay vì tải toàn bộ rows
    // về Node rồi reduce. Khi seller có hàng nghìn đơn, đây là khác biệt
    // lớn nhất về performance.
    // =====================================================
    async getSellerStats(sellerId: string): Promise<{ revenue: number; orderCount: number }> {
        const [orderCount, revenueAgg] = await Promise.all([
            this.databaseService.order.count({
                where: { seller_id: sellerId },
            }),
            this.databaseService.order.aggregate({
                where: { seller_id: sellerId, status: OrderStatus.COMPLETED },
                _sum: { final_total_price: true },
            }),
        ]);

        return {
            revenue: Number(revenueAgg._sum.final_total_price ?? 0),
            orderCount,
        };
    }

    // =====================================================
    // SELLER: Dashboard tổng quan
    //
    // Query plan:
    //   1) Cache lookup (60s TTL) — short-circuit khi seller F5 liên tục.
    //   2) Promise.all 4 query song song:
    //        - getSellerStats        → count + SUM(final_total_price)
    //        - product.count          → activeProducts
    //        - $queryRaw DATE_TRUNC   → revenue theo tháng (gom group tại DB)
    //        - $queryRaw CTE          → sold + avg_rating + review_count theo product_id
    //   3) JS chỉ làm: pad missing months + sort top3 (≤ |products| rows).
    //
    // Trước đây: 4 sequential queries kéo về toàn bộ orders/orderItems/reviews
    // (mỗi review include nested order + order_items) rồi reduce trong Node.
    // Với seller có lịch sử bán dài, query này là điểm nóng N+1/over-fetch.
    // =====================================================
    async getSellerDashboard(sellerId: string): Promise<SellerDashboardSnapshot> {
        const cached = this.dashboardCache.get(sellerId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.value;
        }

        // Lower bound = đầu tháng của (now - 11 tháng). Tạo bằng Date constructor
        // local-time để khớp với label `YYYY-MM` mà FE đang dùng.
        const now = new Date();
        const monthlyLowerBound = new Date(now.getFullYear(), now.getMonth() - 11, 1);

        const [stats, activeProducts, monthlyRevenueRows, productStatRows] = await Promise.all([
            this.getSellerStats(sellerId),
            this.databaseService.product.count({
                where: { seller_id: sellerId, is_active: true },
            }),
            // DATE_TRUNC tại múi giờ VN để tháng khớp lịch người dùng,
            // không bị lệch khi server chạy ở UTC (Railway).
            this.databaseService.$queryRaw<SellerMonthlyRevenueRow[]>`
                SELECT
                    TO_CHAR(
                        DATE_TRUNC('month', "created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh'),
                        'YYYY-MM'
                    ) AS month,
                    SUM("final_total_price")::float AS revenue
                FROM "Order"
                WHERE "seller_id" = ${sellerId}
                    AND "status" = 'COMPLETED'
                    AND "created_at" >= ${monthlyLowerBound}
                GROUP BY 1
            `,
            // CTE 1 (sold_stats): chỉ tính qua đơn COMPLETED → khớp định nghĩa "đã bán".
            // CTE 2 (rating_stats): mỗi review nhân với số product_id của order
            //   (giữ semantics cũ: rating của order áp lên TỪNG product trong order đó).
            // Outer LEFT JOIN: product chưa có đơn / chưa có review vẫn xuất hiện
            //   với sold=0, avg_rating=NULL — cần thiết cho nhóm "need improvement
            //   without rating".
            this.databaseService.$queryRaw<SellerProductStatRow[]>`
                WITH sold_stats AS (
                    SELECT oi."product_id", SUM(oi."quantity")::float AS sold
                    FROM "OrderItem" oi
                    JOIN "Order" o ON o."id" = oi."order_id"
                    WHERE o."seller_id" = ${sellerId}
                        AND o."status" = 'COMPLETED'
                    GROUP BY oi."product_id"
                ),
                rating_stats AS (
                    SELECT oi."product_id",
                           AVG(r."rating")::float AS avg_rating,
                           COUNT(r."id")::int AS review_count
                    FROM "Review" r
                    JOIN "Order" o ON o."id" = r."order_id"
                    JOIN "OrderItem" oi ON oi."order_id" = o."id"
                    WHERE o."seller_id" = ${sellerId}
                    GROUP BY oi."product_id"
                )
                SELECT p."id",
                       p."name",
                       COALESCE(s.sold, 0)::float AS sold,
                       rs.avg_rating,
                       COALESCE(rs.review_count, 0)::int AS review_count
                FROM "Product" p
                LEFT JOIN sold_stats s ON s."product_id" = p."id"
                LEFT JOIN rating_stats rs ON rs."product_id" = p."id"
                WHERE p."seller_id" = ${sellerId}
            `,
        ]);

        // Pad: SQL chỉ trả các tháng có dữ liệu. Reconstruct đủ 12 tháng (oldest → newest)
        // để FE vẽ biểu đồ liên tục, không bị "đứt" trục thời gian.
        const monthlyMap = new Map(
            monthlyRevenueRows.map((r) => [r.month, Number(r.revenue ?? 0)]),
        );
        const revenueByMonth: { month: string; revenue: number }[] = [];
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            revenueByMonth.push({ month: label, revenue: monthlyMap.get(label) ?? 0 });
        }

        const productStats = productStatRows.map((row) => ({
            id: row.id,
            name: row.name,
            sold: Number(row.sold),
            avgRating:
                row.avg_rating !== null
                    ? Number(Number(row.avg_rating).toFixed(1))
                    : null,
            reviewCount: Number(row.review_count),
        }));

        const top3BestSelling = [...productStats]
            .sort((a, b) => b.sold - a.sold)
            .slice(0, 3);

        // "Need improvement": ưu tiên có-đánh-giá-rating-thấp;
        // nếu thiếu, lấp bằng chưa-có-đánh-giá-bán-ít-nhất.
        // Khớp đúng logic cũ trước refactor để FE không cần đổi.
        const withRating = productStats.filter((p) => p.avgRating !== null);
        const withoutRating = productStats.filter((p) => p.avgRating === null);
        const top3NeedImprovement = [
            ...withRating.sort((a, b) => (a.avgRating ?? 5) - (b.avgRating ?? 5)),
            ...withoutRating.sort((a, b) => a.sold - b.sold),
        ].slice(0, 3);

        const snapshot: SellerDashboardSnapshot = {
            totalRevenue: stats.revenue,
            totalOrders: stats.orderCount,
            activeProducts,
            revenueByMonth,
            top3BestSelling,
            top3NeedImprovement,
        };

        this.dashboardCache.set(sellerId, {
            value: snapshot,
            expiresAt: Date.now() + SELLER_DASHBOARD_CACHE_TTL_MS,
        });

        return snapshot;
    }
}