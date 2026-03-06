import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CreateProductDto } from './dtos/create-product.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly db: DatabaseService) {}

  // 1. Tạo sản phẩm (Giữ nguyên)
  async create(sellerId: string, dto: CreateProductDto) {
    return this.db.product.create({
      data: {
        name: dto.name,
        description: dto.description,
        reference_price: dto.reference_price,
        stock_quantity: dto.stock_quantity,
        unit: dto.unit,
        location: dto.location,
        certification: dto.certification,
        seller_id: sellerId,
        category_id: dto.category_id,
        min_negotiation_qty: dto.min_negotiation_qty ?? null,
      },
    });
  }

  // 2. Lấy sản phẩm của Shop (Giữ nguyên)
  async findAllBySeller(sellerId: string) {
    const products = await this.db.product.findMany({
      where: { seller_id: sellerId },
      orderBy: { created_at: 'desc' },
      include: { category: true },
    });
    
    // Lấy thêm ảnh nếu cần (để đơn giản ở bước này ta trả về luôn)
    return products;
  }

  // --- 3. Lấy tất cả sản phẩm cho Trang chủ (Public) ---
  async findAllPublic() {
    const products = await this.db.product.findMany({
      where: { is_active: true },
      orderBy: { created_at: 'desc' },
      include: {
        category: { select: { name: true } },
        seller: {
          select: {
            id: true,
            full_name: true,
            profile: { select: { store_name: true } },
          },
        },
      },
    });

    if (products.length === 0) return [];

    // Batch load ảnh sản phẩm (1 query thay vì N queries)
    const productIds = products.map((p) => p.id);
    const sellerIds = [...new Set(products.map((p) => p.seller_id))];

    const [allImages, sellerAvatars] = await Promise.all([
      this.db.attachment.findMany({
        where: { target_id: { in: productIds }, target_type: 'PRODUCT' },
        select: { target_id: true, url: true },
      }),
      this.db.attachment.findMany({
        where: { target_id: { in: sellerIds }, target_type: 'AVATAR' },
        select: { target_id: true, url: true },
      }),
    ]);

    // Build maps
    const imageMap = allImages.reduce((acc, a) => {
      if (!acc[a.target_id]) acc[a.target_id] = [];
      acc[a.target_id].push(a.url);
      return acc;
    }, {} as Record<string, string[]>);

    const avatarMap = sellerAvatars.reduce(
      (acc, a) => ({ ...acc, [a.target_id]: a.url }),
      {} as Record<string, string>,
    );

    return products.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.id,
      price: Number(p.reference_price),
      originalPrice: Number(p.reference_price) * 1.2,
      unit: p.unit,
      category: p.category.name,
      origin: p.location || 'Việt Nam',
      images: imageMap[p.id]?.length ? imageMap[p.id] : ['https://via.placeholder.com/300'],
      description: p.description,
      stock: Number(p.stock_quantity),
      // Top-level seller_id — FE có thể dùng làm fallback
      seller_id: p.seller_id,
      // Backward-compat
      shopName: p.seller?.profile?.store_name || p.seller.full_name,
      // Structured shop object — FE dùng để group giỏ hàng
      shop: {
        id: p.seller_id,
        store_name: p.seller?.profile?.store_name || p.seller.full_name,
        avatar_url: avatarMap[p.seller_id] ?? null,
      },
      rating: 5,
      reviewCount: 0,
      sold: 0,
      min_negotiation_qty: p.min_negotiation_qty ? Number(p.min_negotiation_qty) : null,
    }));
  }
  async findOnePublic(id: string) {
    const p = await this.db.product.findUnique({
      where: { id: id },
      include: { 
        category: true,
        seller: {
          include: { profile: true }
        },
        order_items: {
          include: { order: true }
        }
      },
    });

    if (!p || !p.is_active) {
      throw new NotFoundException('Sản phẩm không tồn tại hoặc đã ngừng bán');
    }

    // Lấy ảnh
    const images = await this.db.attachment.findMany({
      where: { target_id: p.id, target_type: 'PRODUCT' },
      select: { url: true }
    });

    // Lấy Avatar shop
    const shopAvatar = await this.db.attachment.findFirst({
      where: { target_id: p.seller_id, target_type: 'AVATAR' }
    });

    // Lấy Đánh giá (Reviews) có kèm tên người đánh giá
    const reviewsData = await this.db.review.findMany({
      where: { order: { order_items: { some: { product_id: p.id } } } },
      include: { user: { select: { id: true, full_name: true } } },
      orderBy: { created_at: 'desc' }
    });

    // Lấy ảnh review và avatar của người đánh giá
    const reviewIds = reviewsData.map((r) => r.id);
    const reviewerIds = [...new Set(reviewsData.map((r) => r.reviewer_id))];

    const [reviewAttachments, reviewerAvatars] = await Promise.all([
      this.db.attachment.findMany({
        where: { target_type: 'REVIEW', target_id: { in: reviewIds } },
      }),
      this.db.attachment.findMany({
        where: { target_type: 'AVATAR', target_id: { in: reviewerIds } },
      }),
    ]);

    const reviewImageMap = reviewAttachments.reduce((acc, a) => {
      if (!acc[a.target_id]) acc[a.target_id] = [];
      acc[a.target_id].push(a.url);
      return acc;
    }, {} as Record<string, string[]>);

    const avatarMap = reviewerAvatars.reduce(
      (acc, a) => ({ ...acc, [a.target_id]: a.url }),
      {} as Record<string, string>,
    );

    // Tính toán số sao và lượt bán
    const reviewCount = reviewsData.length;
    const averageRating = reviewCount > 0 
      ? reviewsData.reduce((acc, rev) => acc + rev.rating, 0) / reviewCount 
      : 5;

    const soldQuantity = p.order_items
      .filter(item => item.order.status === 'COMPLETED')
      .reduce((acc, item) => acc + Number(item.quantity), 0);

    // Format danh sách đánh giá cho FE
    const formattedReviews = reviewsData.map(r => ({
      id: r.id,
      userName: r.user.full_name,
      avatar: avatarMap[r.reviewer_id] ?? '/images/default-avatar.png',
      rating: r.rating,
      comment: r.comment,
      date: r.created_at,
      // Ảnh do buyer đăng tải khi review
      review_images: reviewImageMap[r.id] ?? [],
      // Phản hồi của người bán
      seller_reply: r.seller_reply ?? null,
      seller_replied_at: r.seller_replied_at ?? null,
    }));

    return { 
      id: p.id,
      name: p.name,
      slug: p.id,
      price: Number(p.reference_price),
      originalPrice: Number(p.reference_price) * 1.2,
      category: p.category.name,
      origin: p.location || 'khac',
      images: images.length > 0 ? images.map(img => img.url) : ['/images/placeholder.jpg'],
      description: p.description,
      rating: Number(averageRating.toFixed(1)),
      reviewCount: reviewCount,
      sold: soldQuantity,
      stock: Number(p.stock_quantity),
      brand: p.seller?.profile?.store_name || 'Nông sản Việt',
      shop: {
        id: p.seller.id,
        store_name: p.seller?.profile?.store_name || p.seller.full_name,
        avatar_url: shopAvatar?.url || null,
        location: p.seller?.profile?.address || null,
        rating: 4.8,
        responseRate: '98%',
        followers: 120,
        joinDate: '1 năm trước',
        totalProducts: 10
      },
      reviews: formattedReviews,
      createdAt: p.created_at,
      min_negotiation_qty: p.min_negotiation_qty ? Number(p.min_negotiation_qty) : null,
    };
  }

  // ─── PATCH /products/:id — Cập nhật sản phẩm (SELLER) ──────────────────
  async updateProduct(sellerId: string, productId: string, dto: Partial<CreateProductDto>) {
    const product = await this.db.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Sản phẩm không tồn tại.');
    if (product.seller_id !== sellerId)
      throw new ForbiddenException('Bạn không có quyền chỉnh sửa sản phẩm này.');

    return this.db.product.update({
      where: { id: productId },
      data: {
        name: dto.name,
        description: dto.description,
        reference_price: dto.reference_price,
        stock_quantity: dto.stock_quantity,
        unit: dto.unit,
        location: dto.location,
        certification: dto.certification,
        category_id: dto.category_id,
        ...(dto.min_negotiation_qty !== undefined && {
          min_negotiation_qty: dto.min_negotiation_qty === 0 ? null : dto.min_negotiation_qty,
        }),
      },
    });
  }

  // ─── DELETE /products/:id — Xóa/ẩn sản phẩm (SELLER) ──────────────────
  async deleteProduct(sellerId: string, productId: string) {
    const product = await this.db.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Sản phẩm không tồn tại.');
    if (product.seller_id !== sellerId)
      throw new ForbiddenException('Bạn không có quyền xóa sản phẩm này.');

    // Ẩn sản phẩm thay vì xóa cứng để bảo toàn dữ liệu lịch sử
    await this.db.product.update({
      where: { id: productId },
      data: { is_active: false },
    });
    return { message: 'Sản phẩm đã được ẩn khỏi danh sách bán.' };
  }

  // ─── GET /sellers/:id — Trang chi tiết người bán ────────────────────────
  async findSellerById(sellerId: string) {
    const seller = await this.db.user.findUnique({
      where: { id: sellerId, role: 'SELLER' },
      include: { profile: true },
    });

    if (!seller) throw new NotFoundException('Người bán không tồn tại.');

    // Avatar shop
    const avatarAttachment = await this.db.attachment.findFirst({
      where: { target_id: sellerId, target_type: 'AVATAR' },
      select: { url: true },
    });

    // Tất cả sản phẩm đang bán
    const products = await this.db.product.findMany({
      where: { seller_id: sellerId, is_active: true },
      orderBy: { created_at: 'desc' },
      include: { category: true },
    });

    const productIds = products.map((p) => p.id);

    // Ảnh các sản phẩm
    const attachments = await this.db.attachment.findMany({
      where: { target_type: 'PRODUCT', target_id: { in: productIds } },
    });
    const imageMap = attachments.reduce((acc, att) => {
      if (!acc[att.target_id]) acc[att.target_id] = [];
      acc[att.target_id].push(att.url);
      return acc;
    }, {} as Record<string, string[]>);

    // Tổng lượt bán + rating trung bình của shop
    const completedOrderItems = await this.db.orderItem.findMany({
      where: {
        product_id: { in: productIds },
        order: { status: 'COMPLETED', seller_id: sellerId },
      },
    });
    const totalSold = completedOrderItems.reduce(
      (sum, i) => sum + Number(i.quantity),
      0,
    );

    const reviews = await this.db.review.findMany({
      where: { order: { seller_id: sellerId } },
      select: { rating: true },
    });
    const avgRating =
      reviews.length > 0
        ? Number(
            (
              reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
            ).toFixed(1),
          )
        : 5;

    return {
      // Đặt flat fields để FE có thể dùng trực tiếp
      id: seller.id,
      full_name: seller.full_name,
      averageRating: avgRating,
      totalSold,
      // Nest toàn bộ thông tin shop vào object 'shop' theo đúng cấu trúc FE dùng
      shop: {
        name: seller.profile?.store_name || seller.full_name,
        store_name: seller.profile?.store_name || seller.full_name,
        avatar: avatarAttachment?.url ?? null,
        avatar_url: avatarAttachment?.url ?? null,
        location: seller.profile?.address ?? 'Chưa cập nhật',
        store_address: seller.profile?.address ?? 'Chưa cập nhật',
        address: seller.profile?.address ?? 'Chưa cập nhật',
        description: seller.profile?.description ?? '',
        store_description: seller.profile?.description ?? '',
        isVerified: seller.profile?.is_verified ?? false,
        rating: avgRating,
        reviewCount: reviews.length,
        totalSold,
        totalProducts: products.length,
        joinDate: seller.created_at,
      },
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        price: Number(p.reference_price),
        originalPrice: Number(p.reference_price) * 1.2,
        category: p.category.name,
        origin: p.location || 'Việt Nam',
        images: imageMap[p.id] ?? [],
        stock: Number(p.stock_quantity),
        rating: avgRating,
      })),
    };
  }
}