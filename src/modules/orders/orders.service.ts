import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CreateOrderDto } from './dtos/create-order.dto';

@Injectable()
export class OrdersService {
    constructor(private readonly databaseService: DatabaseService) { }

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
}