import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { EmailService } from '../../communication/email/email.service';
import { CreateOrderDto } from './dtos/create-order.dto';
import { OrderStatus, PaymentStatus, PaymentMethod } from '@prisma/client';

// Số ngày sau khi giao hàng buyer mới được phép báo sự cố
const REPORT_ISSUE_DELAY_DAYS = 3;

@Injectable()
export class OrdersService {
    constructor(
        private readonly databaseService: DatabaseService,
        private readonly emailService: EmailService,
    ) { }

    async checkout(buyerId: string, dto: CreateOrderDto) {
        if (!dto.items || dto.items.length === 0) {
            throw new BadRequestException('Giỏ hàng của bạn đang trống.');
        }

        // 1. Tra cứu seller_id của từng sản phẩm từ DB
        const productIds = dto.items.map((item) => item.product_id);
        const products = await this.databaseService.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, seller_id: true },
        });

        if (products.length !== productIds.length) {
            throw new NotFoundException('Một hoặc nhiều sản phẩm không tồn tại trong hệ thống.');
        }

        const productSellerMap = new Map(products.map((p) => [p.id, p.seller_id]));

        // 2. Nhóm các sản phẩm theo seller_id (Shop) — lấy từ DB, không từ client
        const itemsBySeller = dto.items.reduce((acc, item) => {
            const sellerId = productSellerMap.get(item.product_id)!;
            if (!acc[sellerId]) {
                acc[sellerId] = [];
            }
            acc[sellerId].push(item);
            return acc;
        }, {} as Record<string, typeof dto.items>);

        try {
            // 2. Sử dụng Prisma Transaction để đảm bảo tính toàn vẹn dữ liệu
            const createdOrders = await this.databaseService.$transaction(async (prisma) => {
                const results: any[] = [];

                for (const [sellerId, items] of Object.entries(itemsBySeller)) {
                    // KIỂM TRA QUAN TRỌNG: Xác thực Seller ID có tồn tại trong DB không
                    const seller = await prisma.user.findUnique({
                        where: { id: sellerId },
                        select: { id: true, role: true }
                    });

                    if (!seller) {
                        throw new NotFoundException(`Người bán (ID: ${sellerId}) không tồn tại trong hệ thống.`);
                    }

                    if (seller.role !== 'SELLER') {
                        throw new BadRequestException(`Người dùng (ID: ${sellerId}) không có quyền bán hàng.`);
                    }

                    // Tính tổng tiền cho đơn hàng của Shop này
                    const orderTotal = items.reduce(
                        (sum, item) => sum + Number(item.price) * Number(item.quantity),
                        0
                    );

                    // Tạo Đơn hàng và các Item chi tiết
                    const newOrder = await prisma.order.create({
                        data: {
                            buyer_id: buyerId,
                            seller_id: sellerId,
                            shipping_address: dto.shipping_address,
                            payment_method: dto.payment_method,
                            note: dto.note,
                            final_total_price: orderTotal,
                            status: 'PENDING',
                            order_items: {
                                create: items.map((item) => ({
                                    product_id: item.product_id,
                                    quantity: item.quantity,
                                    negotiated_price: item.price,
                                })),
                            },
                        },
                        include: {
                            order_items: true,
                        },
                    });

                    // Tạo bản ghi Payment khởi tạo (UNPAID)
                    await prisma.payment.create({
                        data: {
                            order_id: newOrder.id,
                            payer_id: buyerId,
                            amount: orderTotal,
                            payment_method: dto.payment_method,
                            status: PaymentStatus.UNPAID,
                        },
                    });

                    results.push(newOrder);
                }

                return results;
            });

            return {
                message: 'Đặt hàng thành công!',
                total_orders: createdOrders.length,
                data: createdOrders,
            };

        } catch (error) {
            // Trả về thông báo lỗi cụ thể thay vì log chung chung
            if (error instanceof NotFoundException || error instanceof BadRequestException) {
                throw error;
            }

            console.error("[ORDER_ERROR]:", error);
            throw new BadRequestException(
                'Có lỗi xảy ra trong quá trình tạo đơn hàng. Vui lòng làm mới giỏ hàng và thử lại.'
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

        return {
            message: 'Đã báo sự cố thành công. Người bán sẽ được thông báo để xác nhận.',
            data: updated,
        };
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

        // Nếu đã thanh toán trước ⇒ gửi email thông báo hoàn tiền
        if (isPrepaid && order.buyer?.email) {
            await this.emailService.sendRefundNotificationEmail(
                order.buyer.email,
                order.buyer.full_name,
                orderId,
                order.final_total_price.toString(),
                order.payment_method,
            );
        }

        return {
            message: isPrepaid
                ? 'Xác nhận thất lạc. Hệ thống đang tiến hành hoàn tiền cho người mua.'
                : 'Xác nhận giao thất bại. Đơn hàng đã được đóng.',
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
        if (order.buyer?.email) {
            await this.emailService.sendCancelOrderEmail(
                order.buyer.email,
                order.buyer.full_name,
                orderId,
                reason,
            );
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