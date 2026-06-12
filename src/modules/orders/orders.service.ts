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
import { ChatGateway } from '../chat/chat.gateway';
import { CreateOrderDto } from './dtos/create-order.dto';
import { CheckoutQuoteDto } from './dtos/checkout-quote.dto';
import { OrderStatus, PaymentStatus, PaymentMethod, PaymentType, QuoteStatus, MessageType, ProductStatus, DisputeStatus } from '@prisma/client';
import { QUOTE_EXPIRY_MS, QUOTE_EXPIRED_MESSAGE } from '../chat/negotiation.service';

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
    /** Gross — giữ tên cũ để FE/mobile bản cũ không gãy (= grossRevenue). */
    totalRevenue: number;
    /** Tổng doanh thu đơn COMPLETED (chưa trừ hoàn tiền). */
    grossRevenue: number;
    /** Tổng tiền đã hoàn cho buyer (Payment REFUND/REFUNDED). */
    refundedAmount: number;
    /** Thực nhận = grossRevenue − refundedAmount. */
    netRevenue: number;
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
        private readonly chatGateway: ChatGateway,
    ) { }

    async checkoutQuote(buyerId: string, dto: CheckoutQuoteDto) {
        const quote = await this.databaseService.chatMessage.findUnique({
            where: { id: dto.quoteId },
            include: {
                conversation: true,
                sender: { select: { id: true, full_name: true } },
                context_product: {
                    select: { id: true, name: true, unit: true, reference_price: true },
                },
            },
        });

        if (!quote) throw new NotFoundException('Báo giá không tồn tại.');
        if (quote.message_type !== MessageType.NEGOTIATION_QUOTE) {
            throw new BadRequestException('Tin nhắn này không phải báo giá.');
        }
        if (quote.quote_status !== QuoteStatus.PENDING) {
            throw new BadRequestException('Báo giá này đã được xử lý rồi.');
        }
        // Báo giá quá 24h → chặn checkout. Đây là đường accept THẬT của FE
        // (NegotiationQuoteCard gọi /orders/checkout-quote, không qua respondToQuote)
        // nên thiếu check ở đây thì expiry chỉ là hình thức.
        if (Date.now() - quote.created_at.getTime() > QUOTE_EXPIRY_MS) {
            throw new BadRequestException(QUOTE_EXPIRED_MESSAGE);
        }

        const conversation = quote.conversation;
        if (conversation.user1_id !== buyerId && conversation.user2_id !== buyerId) {
            throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này.');
        }
        if (quote.sender_id === buyerId) {
            throw new BadRequestException('Người mua không thể tự chấp nhận báo giá của mình.');
        }

        const buyer = await this.databaseService.user.findUnique({
            where: { id: buyerId },
            select: {
                full_name: true,
                phone_number: true,
                profile: { select: { address: true } },
            },
        });

        const shippingAddressBase = buyer?.profile?.address?.trim();
        const phoneNumberBase = buyer?.phone_number?.trim();
        const shippingAddress = shippingAddressBase || dto.shippingAddress?.trim();
        const phoneNumber = phoneNumberBase || dto.phoneNumber?.trim();

        if (!shippingAddress) {
            throw new BadRequestException('MISSING_SHIPPING_ADDRESS');
        }
        if (!phoneNumber) {
            throw new BadRequestException('MISSING_SHIPPING_ADDRESS');
        }

        const quantity = Number(quote.quote_quantity ?? 0);
        const negotiatedPrice = Number(quote.quote_price ?? 0);
        if (quantity <= 0 || negotiatedPrice <= 0) {
            throw new BadRequestException('Báo giá không hợp lệ.');
        }

        const productId = quote.quote_product_id;
        if (!productId) {
            throw new BadRequestException('Báo giá không có sản phẩm.');
        }

        const product = await this.databaseService.product.findUnique({
            where: { id: productId },
            select: { id: true, is_active: true, seller_id: true, name: true, unit: true, stock_quantity: true },
        });
        if (!product || !product.is_active) {
            throw new NotFoundException('Sản phẩm trong báo giá không còn khả dụng.');
        }

        // P0_24 — chốt báo giá phải còn đủ hàng. Chặn accept khi tồn kho < số lượng
        // báo giá (tránh tạo đơn cho sản phẩm đã hết hàng).
        if (Number(product.stock_quantity) < quantity) {
            throw new BadRequestException('Sản phẩm đã hết hàng, không thể chốt báo giá');
        }

        const totalAmount = Math.round(quantity * negotiatedPrice);

        const created = await this.databaseService.$transaction(async (prisma) => {
            const quoteUpdated = await prisma.chatMessage.updateMany({
                where: {
                    id: quote.id,
                    message_type: MessageType.NEGOTIATION_QUOTE,
                    quote_status: QuoteStatus.PENDING,
                },
                data: { quote_status: QuoteStatus.ACCEPTED },
            });

            if (quoteUpdated.count === 0) {
                throw new BadRequestException('Báo giá này đã được xử lý rồi.');
            }

                        if ((!shippingAddressBase && dto.shippingAddress) || (!phoneNumberBase && dto.phoneNumber)) {
                            await prisma.user.update({
                                where: { id: buyerId },
                                data: {
                                    ...(dto.phoneNumber && !phoneNumberBase ? { phone_number: dto.phoneNumber.trim() } : {}),
                                    ...(dto.shippingAddress && !shippingAddressBase
                                        ? {
                                                profile: {
                                                    upsert: {
                                                        create: { address: dto.shippingAddress.trim() },
                                                        update: { address: dto.shippingAddress.trim() },
                                                    },
                                                },
                                            }
                                        : {}),
                                },
                            });
                        }

            const session = await prisma.checkoutSession.create({
                data: {
                    buyer_id: buyerId,
                    total_amount: totalAmount,
                },
            });

            const order = await prisma.order.create({
                data: {
                    buyer_id: buyerId,
                    seller_id: quote.sender_id,
                    checkout_session_id: session.id,
                    negotiation_quote_id: quote.id,
                    shipping_address: shippingAddress,
                    payment_method: dto.paymentMethod,
                        note: dto.note?.trim() || undefined,
                    final_total_price: totalAmount,
                    status: OrderStatus.PENDING,
                    order_items: {
                        create: [{
                            product_id: product.id,
                            quantity,
                            negotiated_price: negotiatedPrice,
                        }],
                    },
                },
            });

            await this.paymentsService.createInitialPayment(prisma, {
                orderId: order.id,
                payerId: buyerId,
                amount: totalAmount,
                method: dto.paymentMethod,
            });

            return { sessionId: session.id, orderId: order.id };
        }, {
            timeout: 5_000,
            maxWait: 2_000,
        });

        this.chatGateway.server.to(conversation.id).emit('quoteUpdated', {
            messageId: quote.id,
            status: QuoteStatus.ACCEPTED,
        });

        this.chatGateway.server.to(conversation.id).emit('quoteAccepted', {
            quoteMessageId: quote.id,
            conversationId: conversation.id,
            orderId: created.orderId,
            orderStatus: OrderStatus.PENDING,
            paymentStatus: PaymentStatus.UNPAID,
            paymentMethod: dto.paymentMethod,
            checkoutSessionId: created.sessionId,
            totalAmount,
        });

        if (dto.paymentMethod === PaymentMethod.MOMO) {
            const momo = await this.paymentsService.createMomoPayment(buyerId, created.sessionId);
                    if (!momo?.payUrl) {
                        throw new InternalServerErrorException('MoMo chưa trả về payUrl.');
                    }
            return {
                quoteId: quote.id,
                orderId: created.orderId,
                checkoutSessionId: created.sessionId,
                totalAmount,
                paymentMethod: dto.paymentMethod,
                payUrl: momo.payUrl,
                deeplink: momo.deeplink,
                qrCodeUrl: momo.qrCodeUrl,
            };
        }

        return {
            quoteId: quote.id,
            orderId: created.orderId,
            checkoutSessionId: created.sessionId,
            totalAmount,
            paymentMethod: dto.paymentMethod,
        };
    }

    async checkout(buyerId: string, dto: CreateOrderDto) {
        if (!dto.seller_orders || dto.seller_orders.length === 0) {
            throw new BadRequestException('Giỏ hàng của bạn đang trống.');
        }

        // ── Pre-validate: kiểm tra tất cả sản phẩm tồn tại và đúng shop ────────────
        const allProductIds = dto.seller_orders.flatMap((so) => so.items.map((i) => i.product_id));
        const dbProducts = await this.databaseService.product.findMany({
            where: { id: { in: allProductIds } },
            select: { id: true, seller_id: true, is_active: true, reference_price: true, stock_quantity: true },
        });

        if (dbProducts.length !== allProductIds.length) {
            throw new NotFoundException('Một hoặc nhiều sản phẩm không tồn tại.');
        }

        const productMap = new Map(dbProducts.map((p) => [p.id, p]));

        // ── Suy ra seller từ QUAN HỆ SẢN PHẨM, KHÔNG tin seller_id của client ──────
        // FE có thể gửi seller_id rỗng/'unknown'/sai (vd: thêm vào giỏ từ trang shop
        // mà thiếu quan hệ seller). Backend là nguồn quyền lực: với mỗi nhóm đơn, lấy
        // seller_id thật từ product rồi GHI ĐÈ. Một nhóm trộn nhiều seller là dữ liệu
        // hỏng → chặn rõ ràng thay vì tạo đơn sai.
        for (const sellerOrder of dto.seller_orders) {
            const derived = new Set(
                sellerOrder.items
                    .map((i) => productMap.get(i.product_id)?.seller_id)
                    .filter((id): id is string => Boolean(id)),
            );
            if (derived.size === 0) {
                throw new BadRequestException(
                    'Không xác định được người bán cho sản phẩm trong giỏ hàng.',
                );
            }
            if (derived.size > 1) {
                throw new BadRequestException(
                    'Một nhóm đơn chứa sản phẩm từ nhiều người bán khác nhau.',
                );
            }
            sellerOrder.seller_id = [...derived][0];
        }

        // Gom tổng số lượng yêu cầu theo product_id — cùng 1 sản phẩm có thể xuất hiện
        // nhiều dòng (giỏ tách dòng); phải cộng dồn rồi mới so với tồn kho.
        const requestedQtyByProduct = new Map<string, number>();
        for (const sellerOrder of dto.seller_orders) {
            for (const item of sellerOrder.items) {
                requestedQtyByProduct.set(
                    item.product_id,
                    (requestedQtyByProduct.get(item.product_id) ?? 0) + Number(item.quantity),
                );
            }
        }

        // Xác nhận sản phẩm thuộc đúng seller, đang active, số lượng hợp lệ và đủ tồn kho.
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
                // Chặn 0 / số âm ngay ở tầng nghiệp vụ (lớp phòng thủ thứ 2 sau DTO @Min(1)).
                if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) < 1) {
                    throw new BadRequestException('Số lượng sản phẩm không hợp lệ.');
                }
            }
        }

        // ── Pre-check tồn kho (Vietnamese, rõ ràng) ───────────────────────────────
        // Backend là nguồn quyền lực cuối cùng: nếu TỔNG số lượng yêu cầu của bất kỳ
        // sản phẩm nào > tồn kho hiện tại → chặn ngay với thông báo tiếng Việt, TRƯỚC
        // khi vào transaction. Việc trừ kho atomic phía dưới vẫn giữ để chống race.
        for (const [productId, requestedQty] of requestedQtyByProduct) {
            const p = productMap.get(productId)!;
            if (requestedQty > Number(p.stock_quantity)) {
                throw new BadRequestException('Số lượng sản phẩm không đủ trong kho');
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

                    // Tính subtotal — KHÔNG tin item.price từ client; dùng reference_price
                    // lấy từ DB (productMap) để chống thao túng giá phía client.
                    const subtotal = items.reduce((sum, item) => {
                        const p = productMap.get(item.product_id)!;
                        return sum + Number(p.reference_price) * Number(item.quantity);
                    }, 0);

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

                    // ── Atomic stock decrement check ──────────────────────────────
                    // Trừ tồn kho có điều kiện NGAY trong $transaction, TRƯỚC khi tạo
                    // Order. updateMany với where(stock_quantity >= quantity) dịch ra
                    // `UPDATE ... WHERE stock_quantity >= n` — Postgres row-lock đảm bảo
                    // hai checkout song song không thể oversell. count===0 ⇒ không đủ
                    // hàng ⇒ throw → transaction rollback (hoàn lại các decrement trước đó).
                    for (const item of items) {
                        const stockUpdate = await prisma.product.updateMany({
                            where: {
                                id: item.product_id,
                                stock_quantity: { gte: item.quantity },
                            },
                            data: {
                                stock_quantity: { decrement: item.quantity },
                            },
                        });
                        if (stockUpdate.count === 0) {
                            // Race: tồn kho vừa bị checkout song song lấy mất sau pre-check.
                            throw new BadRequestException('Số lượng sản phẩm không đủ trong kho');
                        }
                    }

                    // Sản phẩm vừa hết kho (stock về 0) → tự đánh dấu OUT_OF_STOCK để ẩn khỏi listing.
                    await prisma.product.updateMany({
                        where: {
                            id: { in: items.map((i) => i.product_id) },
                            stock_quantity: { lte: 0 },
                            status: ProductStatus.ACTIVE,
                        },
                        data: { status: ProductStatus.OUT_OF_STOCK, is_active: false },
                    });

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
                                // negotiated_price cũng lấy từ DB reference_price (không tin client)
                                create: items.map((item) => ({
                                    product_id: item.product_id,
                                    quantity: item.quantity,
                                    negotiated_price: Number(productMap.get(item.product_id)!.reference_price),
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
                // Railway proxy có latency ~100-300ms/query. Giữ timeout chặt 5s + maxWait 2s
                // để fail-fast khi row-lock bị giữ quá lâu thay vì treo request.
                timeout: 5_000,
                maxWait: 2_000,
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

        const productIds = orders.flatMap((o) =>
            o.order_items.map((item) => item.product_id),
        );

        const attachments = await this.databaseService.attachment.findMany({
            where: {
                target_type: 'PRODUCT',
                target_id: { in: productIds },
            },
        });

        const imageMap = attachments.reduce(
            (acc, att) => {
                if (!acc[att.target_id]) acc[att.target_id] = [];
                acc[att.target_id].push(att.url);
                return acc;
            },
            {} as Record<string, string[]>,
        );

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

    async getOrderById(userId: string, orderId: string) {
        const order = await this.databaseService.order.findFirst({
            where: {
                id: orderId,
                buyer_id: userId,
            },
            include: {
                buyer: {
                    select: {
                        id: true,
                        full_name: true,
                        email: true,
                        phone_number: true,
                        profile: {
                            select: {
                                address: true,
                                store_name: true,
                            },
                        },
                    },
                },
                seller: {
                    select: {
                        id: true,
                        full_name: true,
                        email: true,
                        phone_number: true,
                        profile: {
                            select: {
                                store_name: true,
                                address: true,
                            },
                        },
                    },
                },
                voucher: {
                    select: {
                        id: true,
                        code: true,
                        discount_type: true,
                        discount_value: true,
                        max_discount_amount: true,
                        min_order_value: true,
                    },
                },
                payments: {
                    select: {
                        id: true,
                        amount: true,
                        payment_method: true,
                        status: true,
                        transaction_ref: true,
                        created_at: true,
                        updated_at: true,
                    },
                    orderBy: { created_at: 'desc' },
                },
                order_items: {
                    include: {
                        product: true,
                    },
                },
                checkout_session: {
                    select: {
                        id: true,
                        total_amount: true,
                        status: true,
                        momo_trans_id: true,
                        created_at: true,
                        updated_at: true,
                    },
                },
            },
        });

        if (!order) {
            throw new NotFoundException(`Đơn hàng #${orderId} không tồn tại.`);
        }

        const productIds = order.order_items.map((item) => item.product_id);
        const attachments = await this.databaseService.attachment.findMany({
            where: {
                target_type: 'PRODUCT',
                target_id: { in: productIds },
            },
        });

        const imageMap = attachments.reduce((acc, att) => {
            if (!acc[att.target_id]) acc[att.target_id] = [];
            acc[att.target_id].push(att.url);
            return acc;
        }, {} as Record<string, string[]>);

        return {
            ...order,
            shipping_address: order.shipping_address,
            items: order.order_items.map((item) => ({
                ...item,
                product: {
                    ...item.product,
                    images: imageMap[item.product_id] ?? [],
                },
            })),
        };
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
                dispute: {
                    select: {
                        id: true,
                        status: true,
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

        const payment = await this.databaseService.payment.findFirst({
            where: { order_id: orderId },
        });

        if (payment?.payment_method === PaymentMethod.MOMO && payment.status !== PaymentStatus.PAID) {
            throw new BadRequestException('Cannot process unpaid online orders');
        }

        const updated = await this.databaseService.order.update({
            where: { id: orderId },
            data: { status: OrderStatus.CONFIRMED },
        });

        await this.emitOrderStatusUpdate(orderId, sellerId, OrderStatus.CONFIRMED);

        return updated;
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

        const payment = await this.databaseService.payment.findFirst({
            where: { order_id: orderId },
        });

        if (payment?.payment_method === PaymentMethod.MOMO && payment.status !== PaymentStatus.PAID) {
            throw new BadRequestException('Cannot process unpaid online orders');
        }

        const updated = await this.databaseService.order.update({
            where: { id: orderId },
            data: {
                status: OrderStatus.SHIPPING,
                shipped_at: new Date(),
            },
        });

        await this.emitOrderStatusUpdate(orderId, sellerId, OrderStatus.SHIPPING);

        return updated;
    }

    // =====================================================
    // BUYER: SHIPPING → COMPLETED
    // Xác nhận nhận hàng ⇒ chữ ký điện tử, đồng thời SET PAID (COD only)
    // =====================================================
    async completeOrder(buyerId: string, orderId: string) {
        const order = await this.findOrderOrFail(orderId);

        if (order.buyer_id !== buyerId)
            throw new ForbiddenException('Bạn không có quyền xác nhận nhận hàng.');

        if (order.status !== OrderStatus.SHIPPING)
            throw new BadRequestException(
                `Chỉ đơn ở trạng thái SHIPPING mới có thể hoàn thành. Trạng thái hiện tại: ${order.status}`,
            );

        // Atomic: đồng thời cập nhật Order=COMPLETED và Payment=PAID (nếu COD)
        // COD: xác nhận đã trả tiền khi nhận hàng
        // Online: tiền đã trả từ trước, payment should be PAID
        await this.databaseService.$transaction(async (tx) => {
            await tx.order.update({
                where: { id: orderId },
                data: { status: OrderStatus.COMPLETED },
            });

            if (order.payment_method === PaymentMethod.COD) {
                await this.paymentsService.markPaid(tx, orderId);
            }
        });

        await this.emitOrderStatusUpdate(orderId, buyerId, OrderStatus.COMPLETED);

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

        // Mở Dispute để Admin phân xử (KHÔNG tự refund). Idempotent: đã có thì bỏ qua.
        await this.ensureDisputeForOrder(order, issueNote);

        await this.emitOrderStatusUpdate(
            orderId,
            buyerId,
            OrderStatus.ISSUE_REPORTED,
            '⚠️ Người mua đã báo cáo sự cố chưa nhận được hàng.',
        );

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

        // ── ADMIN-ONLY RESOLUTION ──────────────────────────────────────────
        // KHÔNG tự refund / không tự đóng đơn. Mở Dispute (OPEN) + đưa đơn về
        // ISSUE_REPORTED. Người bán giải trình (PATCH /disputes/:id/respond),
        // sau đó ADMIN phán quyết hoàn tiền hay không (POST /admin/disputes/:id/adjudicate).
        await this.databaseService.$transaction(async (tx) => {
            await tx.order.update({
                where: { id: orderId },
                data: { status: OrderStatus.ISSUE_REPORTED, note: issueNote },
            });
        });
        await this.ensureDisputeForOrder(order, issueNote);

        return {
            message:
                'Đã mở khiếu nại. Người bán sẽ giải trình và Admin sẽ phán quyết hoàn tiền (nếu có). ' +
                'Hệ thống không tự hoàn tiền.',
        };
    }

    // =====================================================
    // SELLER: ISSUE_REPORTED → FAILED (xác nhận hàng thất lạc)
    // Refund only for paid MOMO; API failure leaves order as ISSUE_REPORTED
    // =====================================================
    async confirmLost(sellerId: string, orderId: string) {
        const order = await this.databaseService.order.findUnique({
            where: { id: orderId },
            include: {
                buyer: { select: { id: true, full_name: true, email: true } },
                seller: { select: { id: true, full_name: true } },
                payments: { select: { id: true, status: true, payment_method: true } },
            },
        });

        if (!order) throw new NotFoundException(`Đơn hàng #${orderId} không tồn tại.`);

        if (order.seller_id !== sellerId)
            throw new ForbiddenException('Bạn không có quyền xử lý đơn hàng này.');

        if (order.status !== OrderStatus.ISSUE_REPORTED)
            throw new BadRequestException(
                `Chỉ đơn ở trạng thái ISSUE_REPORTED mới có thể xác nhận thất lạc. Hiện tại: ${order.status}`,
            );

        const payment = order.payments?.[0];

        // ── ADMIN-ONLY: người bán KHÔNG được tự refund / tự đóng đơn ──────────
        // "Xác nhận thất lạc" giờ = ESCALATE cho Admin: đảm bảo có Dispute và đưa
        // sang UNDER_ADMIN_REVIEW kèm giải trình của người bán. Admin là người
        // DUY NHẤT phán quyết hoàn tiền (POST /admin/disputes/:id/adjudicate).
        // TUYỆT ĐỐI KHÔNG gọi refund / không set FAILED tại đây.
        const dispute = await this.ensureDisputeForOrder(
            order,
            order.note ?? 'Người mua báo chưa nhận được hàng.',
        );
        await this.databaseService.dispute.update({
            where: { id: dispute.id },
            data: {
                seller_explanation: 'Người bán xác nhận hàng đã thất lạc trong quá trình vận chuyển.',
                status: DisputeStatus.UNDER_ADMIN_REVIEW,
            },
        });

        await this.emitOrderStatusUpdate(
            orderId,
            sellerId,
            OrderStatus.ISSUE_REPORTED,
            'Người bán đã xác nhận thất lạc — chuyển Admin phân xử.',
        );

        return {
            message:
                'Đã chuyển khiếu nại cho Admin phân xử. Hệ thống KHÔNG tự hoàn tiền — Admin sẽ quyết định dựa trên bằng chứng.',
            payment_status: payment?.status ?? PaymentStatus.UNPAID,
        };
    }

    // =====================================================
    // Hoàn tồn kho cho 1 đơn — gọi khi đơn HỦY/THẤT BẠI (tồn kho đã bị trừ lúc
    // checkout). Cộng lại stock theo từng order_item; nếu sản phẩm đang
    // OUT_OF_STOCK mà được cộng kho > 0 → bật lại ACTIVE. Mỗi transition hủy/thất
    // bại đều guard status nên hàm này chỉ chạy 1 lần / đơn (không hoàn kho 2 lần).
    // =====================================================
    // Tạo Dispute (nếu chưa có) khi buyer báo sự cố — KHÔNG refund ở đây. Admin là
    // người duy nhất phán quyết hoàn tiền (xem DisputeService.adjudicate).
    private async ensureDisputeForOrder(
        order: { id: string; buyer_id: string; seller_id: string },
        reason: string,
    ) {
        const existing = await this.databaseService.dispute.findUnique({ where: { order_id: order.id } });
        if (existing) return existing;
        return this.databaseService.dispute.create({
            data: {
                order_id: order.id,
                buyer_id: order.buyer_id,
                seller_id: order.seller_id,
                buyer_reason: reason,
                status: DisputeStatus.PENDING_SELLER_RESPONSE,
            },
        });
    }

    private async restoreStockForOrder(orderId: string) {
        const items = await this.databaseService.orderItem.findMany({
            where: { order_id: orderId },
            select: { product_id: true, quantity: true },
        });
        if (items.length === 0) return;

        await this.databaseService.$transaction(
            items.map((it) =>
                this.databaseService.product.update({
                    where: { id: it.product_id },
                    data: { stock_quantity: { increment: it.quantity } },
                }),
            ),
        );

        await this.databaseService.product.updateMany({
            where: {
                id: { in: items.map((it) => it.product_id) },
                status: ProductStatus.OUT_OF_STOCK,
                stock_quantity: { gt: 0 },
            },
            data: { status: ProductStatus.ACTIVE, is_active: true },
        });
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

        // Đơn bị hủy → hoàn lại tồn kho đã trừ lúc checkout.
        await this.restoreStockForOrder(orderId);

        await this.emitOrderStatusUpdate(orderId, sellerId, OrderStatus.CANCELLED);

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

        const updated = await this.databaseService.order.update({
            where: { id: orderId },
            data: { status: OrderStatus.CANCELLED },
        });

        // Đơn bị hủy → hoàn lại tồn kho đã trừ lúc checkout.
        await this.restoreStockForOrder(orderId);

        await this.emitOrderStatusUpdate(orderId, buyerId, OrderStatus.CANCELLED);

        return updated;
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

        // Hoàn lại tồn kho cho các đơn vừa bị auto-hủy.
        for (const id of ids) {
            await this.restoreStockForOrder(id);
        }

        this.logger.log(`[cron] Auto-cancelled ${ids.length} unpaid MoMo orders older than ${UNPAID_MOMO_ORDER_TIMEOUT_HOURS}h: ${ids.join(', ')}`);
    }

    // =====================================================
    // SELLER: Summary tổng quan (revenue + orderCount)
    //
    // Push toàn bộ aggregation xuống Postgres: COUNT cho tổng đơn,
    // SUM(final_total_price) cho doanh thu — thay vì tải toàn bộ rows
    // về Node rồi reduce. Khi seller có hàng nghìn đơn, đây là khác biệt
    // lớn nhất về performance.
    //
    // Net revenue = gross (đơn COMPLETED) − tổng tiền ĐÃ hoàn cho buyer.
    // Refund đếm qua bản ghi Payment (payment_type=REFUND, status=REFUNDED)
    // thay vì Order.status — chính xác cả khi hoàn một phần / nhiều lần,
    // và là "tiền ra" thực tế đã đối soát với MoMo.
    // =====================================================
    async getSellerStats(sellerId: string): Promise<{
        revenue: number;
        grossRevenue: number;
        refundedAmount: number;
        netRevenue: number;
        orderCount: number;
    }> {
        const [orderCount, revenueAgg, refundAgg] = await Promise.all([
            this.databaseService.order.count({
                where: { seller_id: sellerId },
            }),
            this.databaseService.order.aggregate({
                where: { seller_id: sellerId, status: OrderStatus.COMPLETED },
                _sum: { final_total_price: true },
            }),
            this.databaseService.payment.aggregate({
                where: {
                    payment_type: PaymentType.REFUND,
                    status: PaymentStatus.REFUNDED,
                    order: { seller_id: sellerId },
                },
                _sum: { amount: true },
            }),
        ]);

        const grossRevenue = Number(revenueAgg._sum.final_total_price ?? 0);
        const refundedAmount = Number(refundAgg._sum.amount ?? 0);

        return {
            revenue: grossRevenue, // alias cũ — caller hiện hữu không phải đổi
            grossRevenue,
            refundedAmount,
            netRevenue: grossRevenue - refundedAmount,
            orderCount,
        };
    }

    // =====================================================
    // Helper: Emit order status update to chat + create SYSTEM message
    // =====================================================
    private async emitOrderStatusUpdate(
        orderId: string,
        actionUserId: string,
        newStatus: OrderStatus,
        // Nội dung SYSTEM message tuỳ chỉnh cho từng hành động (vd reportIssue).
        // Bỏ trống → fallback về nhãn mặc định "📦 <statusLabel>".
        customContent?: string,
    ) {
        this.logger.debug(`[emitOrderStatusUpdate] START: orderId=${orderId}, actionUserId=${actionUserId}, newStatus=${newStatus}`);

        try {
            this.logger.debug(`[emitOrderStatusUpdate] Fetching order...`);
            const order = await this.databaseService.order.findUnique({
                where: { id: orderId },
                select: {
                    negotiation_quote_id: true,
                    payment_method: true,
                    checkout_session_id: true,
                    payments: {
                        take: 1,
                        select: { status: true },
                    },
                },
            });

            this.logger.debug(`[emitOrderStatusUpdate] Order found: ${JSON.stringify(order)}`);

            if (!order?.negotiation_quote_id) {
                this.logger.warn(
                    `[emitOrderStatusUpdate] ⚠️ Order ${orderId} has NO negotiation_quote_id. This order may not be from a quote. Skipping chat emit.`,
                );
                return;
            }

            this.logger.debug(`[emitOrderStatusUpdate] Fetching quote message by ID: ${order.negotiation_quote_id}`);
            const quoteMessage = await this.databaseService.chatMessage.findUnique({
                where: { id: order.negotiation_quote_id },
                select: { conversation_id: true },
            });

            this.logger.debug(`[emitOrderStatusUpdate] Quote message found: ${JSON.stringify(quoteMessage)}`);

            if (!quoteMessage?.conversation_id) {
                this.logger.warn(
                    `[emitOrderStatusUpdate] ⚠️ Quote message ${order.negotiation_quote_id} has NO conversation_id. Skipping socket emit.`,
                );
                return;
            }

            const conversationId = quoteMessage.conversation_id;
            this.logger.debug(`[emitOrderStatusUpdate] Conversation ID resolved: ${conversationId}`);

            this.logger.debug(`[emitOrderStatusUpdate] Emitting orderStatusUpdated event to room: ${conversationId}`);
            this.chatGateway.server.to(conversationId).emit('orderStatusUpdated', {
                orderId,
                newStatus,
                orderStatus: newStatus,
                paymentStatus: order.payments[0]?.status ?? null,
                paymentMethod: order.payment_method,
                checkoutSessionId: order.checkout_session_id,
                timestamp: new Date(),
            });
            this.logger.debug(`[emitOrderStatusUpdate] ✅ Event emitted successfully`);

            const statusLabel = this.getStatusLabel(newStatus);
            const messageContent = customContent ?? `📦 ${statusLabel}`;
            this.logger.debug(`[emitOrderStatusUpdate] Creating SYSTEM message: "${messageContent}"`);

            const systemMessage = await this.databaseService.chatMessage.create({
                data: {
                    conversation_id: conversationId,
                    sender_id: actionUserId,
                    message_type: MessageType.SYSTEM,
                    message_content: messageContent,
                },
                include: { sender: { select: { id: true, full_name: true } } },
            });

            // Phát SYSTEM message NGAY tới phòng chat. KHÔNG có bước này thì FE chỉ
            // thấy tin nhắn sau khi F5 (DB đã lưu nhưng socket chưa báo). Shape khớp
            // getMessages + emit('newMessage') ở ChatGateway để BuyerChatWidgetPanel /
            // SellerChat render đồng nhất (cần `conversationId` camelCase + `sender`).
            this.chatGateway.server.to(conversationId).emit('newMessage', {
                id: systemMessage.id,
                conversationId,
                sender: systemMessage.sender,
                message_content: systemMessage.message_content,
                message_type: systemMessage.message_type,
                image_url: null,
                context_product: null,
                proposed_quantity: null,
                proposed_price: null,
                quote: null,
                orderInfo: null,
                created_at: systemMessage.created_at,
            });

            this.logger.log(
                `[emitOrderStatusUpdate] ✅ SUCCESS: Order ${orderId} → ${newStatus}. Emitted orderStatusUpdated + newMessage to conversation ${conversationId}, SYSTEM message created: ${systemMessage.id}`,
            );
        } catch (error) {
            this.logger.error(
                `[emitOrderStatusUpdate] ❌ FAILED: Order ${orderId}. Error: ${(error as Error).message}`,
                (error as Error).stack,
            );
        }
    }

    private getStatusLabel(status: OrderStatus): string {
        const labels: Record<OrderStatus, string> = {
            [OrderStatus.PENDING]: 'Đơn hàng chờ xác nhận',
            [OrderStatus.CONFIRMED]: 'Người bán đã xác nhận đơn hàng',
            [OrderStatus.SHIPPING]: 'Đơn hàng đang được giao',
            [OrderStatus.COMPLETED]: 'Đơn hàng đã hoàn thành',
            [OrderStatus.CANCELLED]: 'Đơn hàng đã bị hủy',
            [OrderStatus.ISSUE_REPORTED]: 'Người mua báo không nhận được hàng',
            [OrderStatus.RETURNED]: 'Đơn hàng đã được trả lại',
            [OrderStatus.REFUND_PENDING]: 'Đợi xử lý hoàn tiền',
            [OrderStatus.FAILED]: 'Đơn hàng thất bại',
            [OrderStatus.REFUNDED]: 'Đã hoàn tiền thành công',
        };
        return labels[status] || `Trạng thái: ${status}`;
    }

    // =====================================================
    // SELLER: Dashboard tổng quan
    //
    // Query plan:
    //   1) Cache lookup (60s TTL) — short-circuit khi seller F5 liên tục.
    //   2) Promise.all 4 query song parallel:
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
            totalRevenue: stats.grossRevenue,
            grossRevenue: stats.grossRevenue,
            refundedAmount: stats.refundedAmount,
            netRevenue: stats.netRevenue,
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
