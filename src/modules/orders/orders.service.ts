import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
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

@Injectable()
export class OrdersService {
    private readonly logger = new Logger(OrdersService.name);

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

        try {
            const createdOrders = await this.databaseService.$transaction(async (prisma) => {
                const results: {
                    seller_id: string;
                    order_id: string;
                    subtotal: number;
                    discount: number;
                    final: number;
                }[] = [];

                for (const sellerOrder of dto.seller_orders) {
                    const { seller_id: sellerId, items, voucher_code } = sellerOrder;

                    // Xác thực seller tồn tại
                    const seller = await prisma.user.findUnique({
                        where: { id: sellerId },
                        select: { id: true, is_seller: true },
                    });
                    if (!seller) {
                        throw new NotFoundException(`Người bán (ID: ${sellerId}) không tồn tại.`);
                    }
                    if (!seller.is_seller) {
                        throw new BadRequestException(`ID ${sellerId} không phải SELLER.`);
                    }

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

                    // Tạo Payment
                    await prisma.payment.create({
                        data: {
                            order_id: newOrder.id,
                            payer_id: buyerId,
                            amount: finalPrice,
                            payment_method: dto.payment_method,
                            status: PaymentStatus.UNPAID,
                        },
                    });

                    results.push({
                        seller_id: sellerId,
                        order_id: newOrder.id,
                        subtotal,
                        discount: discountAmount,
                        final: finalPrice,
                    });
                }

                return results;
            });

            const totalPaid = createdOrders.reduce((sum, o) => sum + o.final, 0);

            return {
                message: 'Đặt hàng thành công!',
                order_ids: createdOrders.map((o) => o.order_id),
                total_paid: totalPaid,
                seller_orders: createdOrders,
            };

        } catch (error) {
            if (error instanceof NotFoundException || error instanceof BadRequestException) {
                throw error;
            }
            console.error('[ORDER_ERROR]:', error);
            throw new BadRequestException(
                'Có lỗi xảy ra trong quá trình tạo đơn hàng. Vui lòng làm mới giỏ hàng và thử lại.',
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
        await this.databaseService.$transaction([
            this.databaseService.order.update({
                where: { id: orderId },
                data: { status: OrderStatus.COMPLETED },
            }),
            this.databaseService.payment.updateMany({
                where: { order_id: orderId },
                data: { status: PaymentStatus.PAID },
            }),
        ]);

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
                await tx.payment.updateMany({
                    where: { order_id: orderId },
                    data: { status: PaymentStatus.FAILED },
                });
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
                await tx.payment.updateMany({
                    where: { order_id: orderId },
                    data: { status: PaymentStatus.REFUNDING },
                });
            });

            try {
                await this.paymentsService.refundMomoTransaction(
                    orderId,
                    Number(order.final_total_price),
                    issueNote,
                );
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
                await tx.payment.updateMany({
                    where: { order_id: orderId },
                    data: { status: PaymentStatus.REFUNDING },
                });
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
        await this.databaseService.$transaction([
            this.databaseService.order.update({
                where: { id: orderId },
                data: { status: OrderStatus.FAILED },
            }),
            this.databaseService.payment.updateMany({
                where: { order_id: orderId },
                data: { status: newPaymentStatus },
            }),
        ]);

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
                await this.paymentsService.refundMomoTransaction(
                    orderId,
                    Number(order.final_total_price),
                    'Người bán xác nhận thất lạc hàng',
                );
                await this.databaseService.payment.updateMany({
                    where: { order_id: orderId },
                    data: { status: PaymentStatus.REFUNDED },
                });
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

        await this.databaseService.$transaction([
            this.databaseService.order.update({
                where: { id: orderId },
                data: { payment_method: newMethod },
            }),
            this.databaseService.payment.updateMany({
                where: { order_id: orderId },
                data: { payment_method: newMethod },
            }),
        ]);

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
        await this.databaseService.$transaction([
            this.databaseService.order.updateMany({
                where: { id: { in: ids } },
                data: { status: OrderStatus.CANCELLED },
            }),
            this.databaseService.payment.updateMany({
                where: { order_id: { in: ids }, status: PaymentStatus.UNPAID },
                data: { status: PaymentStatus.FAILED },
            }),
        ]);

        this.logger.log(`[cron] Auto-cancelled ${ids.length} unpaid MoMo orders older than ${UNPAID_MOMO_ORDER_TIMEOUT_HOURS}h: ${ids.join(', ')}`);
    }

    // =====================================================
    // SELLER: Dashboard tổng quan
    // =====================================================
    async getSellerDashboard(sellerId: string) {
        // 1. Tổng đơn hàng
        const totalOrders = await this.databaseService.order.count({
            where: { seller_id: sellerId },
        });

        // 2. Tổng doanh thu (chỉ đơn COMPLETED)
        const completedOrders = await this.databaseService.order.findMany({
            where: { seller_id: sellerId, status: OrderStatus.COMPLETED },
            select: { final_total_price: true, created_at: true },
        });
        const totalRevenue = completedOrders.reduce(
            (sum, o) => sum + Number(o.final_total_price),
            0,
        );

        // 3. Sản phẩm đang bán (is_active = true)
        const activeProducts = await this.databaseService.product.count({
            where: { seller_id: sellerId, is_active: true },
        });

        // 4. Doanh thu theo tháng (12 tháng gần nhất)
        const now = new Date();
        const revenueByMonth: { month: string; revenue: number }[] = [];
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const start = new Date(d.getFullYear(), d.getMonth(), 1);
            const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
            const monthLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            const monthRevenue = completedOrders
                .filter((o) => o.created_at >= start && o.created_at < end)
                .reduce((sum, o) => sum + Number(o.final_total_price), 0);
            revenueByMonth.push({ month: monthLabel, revenue: monthRevenue });
        }

        // 5. Top 3 bán chạy nhất & top 3 cần cải thiện
        const orderItems = await this.databaseService.orderItem.findMany({
            where: {
                order: { seller_id: sellerId, status: OrderStatus.COMPLETED },
            },
            select: { product_id: true, quantity: true },
        });

        // Tổng số lượng bán theo product_id
        const soldMap: Record<string, number> = {};
        for (const item of orderItems) {
            soldMap[item.product_id] = (soldMap[item.product_id] ?? 0) + Number(item.quantity);
        }

        // Rating trung bình theo product_id
        const reviewsRaw = await this.databaseService.review.findMany({
            where: {
                order: { seller_id: sellerId },
            },
            include: {
                order: {
                    include: { order_items: { select: { product_id: true } } },
                },
            },
        });
        const ratingMap: Record<string, number[]> = {};
        for (const r of reviewsRaw) {
            for (const item of r.order.order_items) {
                if (!ratingMap[item.product_id]) ratingMap[item.product_id] = [];
                ratingMap[item.product_id].push(r.rating);
            }
        }

        // Lấy tất cả sản phẩm của seller
        const allProducts = await this.databaseService.product.findMany({
            where: { seller_id: sellerId },
            select: { id: true, name: true, reference_price: true, is_active: true },
        });

        const productStats = allProducts.map((p) => {
            const sold = soldMap[p.id] ?? 0;
            const ratings = ratingMap[p.id] ?? [];
            const avgRating =
                ratings.length > 0
                    ? Number((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1))
                    : null;
            return { id: p.id, name: p.name, sold, avgRating, reviewCount: ratings.length };
        });

        // Top 3 bán chạy
        const top3BestSelling = [...productStats]
            .sort((a, b) => b.sold - a.sold)
            .slice(0, 3);

        // Top 3 cần cải thiện: có đánh giá thì ưu tiên rating thấp, không có đánh giá thì ít bán nhất
        const withRating = productStats.filter((p) => p.avgRating !== null);
        const withoutRating = productStats.filter((p) => p.avgRating === null);
        const top3NeedImprovement = [
            ...withRating.sort((a, b) => (a.avgRating ?? 5) - (b.avgRating ?? 5)),
            ...withoutRating.sort((a, b) => a.sold - b.sold),
        ].slice(0, 3);

        return {
            totalRevenue,
            totalOrders,
            activeProducts,
            revenueByMonth,
            top3BestSelling,
            top3NeedImprovement,
        };
    }
}