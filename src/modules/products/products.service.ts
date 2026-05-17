import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CreateProductDto } from './dtos/create-product.dto';
import { TargetType, ProductStatus } from '@prisma/client';

/**
 * Stock-driven part of the lifecycle:
 *   stock > 0 → ACTIVE,  stock = 0 → OUT_OF_STOCK
 * Manual terminal states (INACTIVE, DELETED) are sticky — restock/setStatus
 * are the only ways to leave them. is_active mirrors status === ACTIVE so
 * existing buyer queries (`where: { is_active: true }`) keep working.
 */
function deriveStockStatus(stock: number, current?: ProductStatus): ProductStatus {
  if (current === ProductStatus.DELETED || current === ProductStatus.INACTIVE) return current;
  return stock > 0 ? ProductStatus.ACTIVE : ProductStatus.OUT_OF_STOCK;
}

type NormalizedProductPayload = {
  name: string;
  description?: string | null;
  reference_price: number;
  stock_quantity: number;
  unit: string;
  location?: string | null;
  certification?: string | null;
  category_id: number;
  min_negotiation_qty?: number | null;
  is_active: boolean;
  image_urls: string[];
};

@Injectable()
export class ProductsService {
  constructor(private readonly db: DatabaseService) {}

  // 1) Normalize incoming payload (supports FE aliases: price, stock, category slug,...)
  private async normalizePayload(dto: CreateProductDto): Promise<NormalizedProductPayload> {
    const referencePrice = dto.reference_price ?? dto.price;
    const stockQuantity = dto.stock_quantity ?? dto.stock;

    if (referencePrice === undefined || stockQuantity === undefined) {
      throw new BadRequestException('Giá và số lượng tồn kho là bắt buộc.');
    }

    const categoryId = await this.resolveCategoryId(dto.category_id ?? dto.category);

    const minNegotiation = dto.min_negotiation_qty === 0
      ? null
      : dto.min_negotiation_qty ?? null;

    const imageUrls = this.normalizeImageUrls(dto.image_urls);

    const stockNumber = Number(stockQuantity);

    return {
      name: dto.name,
      description: dto.description ?? null,
      reference_price: Number(referencePrice),
      stock_quantity: stockNumber,
      unit: dto.unit ?? 'kg',
      location: dto.location ?? dto.origin ?? null,
      certification: dto.certification ?? null,
      category_id: categoryId,
      min_negotiation_qty: minNegotiation,
      is_active: stockNumber > 0,
      image_urls: imageUrls,
    };
  }

  private normalizeImageUrls(urls?: string[] | string): string[] {
    if (!urls) return [];
    if (Array.isArray(urls)) return urls.filter(Boolean);
    return [urls].filter(Boolean);
  }

  private async resolveCategoryId(categoryInput?: number | string): Promise<number> {
    if (categoryInput === undefined || categoryInput === null) {
      throw new BadRequestException('Danh mục là bắt buộc.');
    }

    // Numeric id
    const numeric = Number(categoryInput);
    if (!Number.isNaN(numeric) && numeric > 0) {
      return numeric;
    }

    const slugToName: Record<string, string> = {
      'trai-cay': 'Trái cây',
      'rau-cu': 'Rau củ',
      'ngu-coc': 'Ngũ cốc',
      'gia-vi': 'Gia vị',
      khac: 'Khác',
    };

    const categoryStr = String(categoryInput).trim();
    const categoryName = slugToName[categoryStr] ?? categoryStr;

    const category = await this.db.category.findFirst({
      where: { name: { equals: categoryName, mode: 'insensitive' } },
    });

    if (!category) {
      throw new BadRequestException('Danh mục không hợp lệ.');
    }

    return category.id;
  }

  private mapAttachmentsByTarget(attachments: { target_id: string; url: string }[]) {
    return attachments.reduce((acc, a) => {
      if (!acc[a.target_id]) acc[a.target_id] = [];
      acc[a.target_id].push(a.url);
      return acc;
    }, {} as Record<string, string[]>);
  }

  // 2) Tạo sản phẩm
  async create(sellerId: string, dto: CreateProductDto, files: Express.Multer.File[] = []) {
    const payload = await this.normalizePayload(dto);

    const initialStatus = deriveStockStatus(payload.stock_quantity);
    const product = await this.db.product.create({
      data: {
        name: payload.name,
        description: payload.description,
        reference_price: payload.reference_price,
        stock_quantity: payload.stock_quantity,
        unit: payload.unit,
        location: payload.location,
        certification: payload.certification,
        seller_id: sellerId,
        category_id: payload.category_id,
        min_negotiation_qty: payload.min_negotiation_qty,
        is_active: initialStatus === ProductStatus.ACTIVE,
        status: initialStatus,
      },
    });

    const uploadedUrls = files.map((file) => `/uploads/products/${file.filename}`);
    const allUrls = [...payload.image_urls, ...uploadedUrls];

    if (allUrls.length > 0) {
      await this.db.attachment.createMany({
        data: allUrls.map((url) => ({
          url,
          file_type: 'IMAGE',
          target_id: product.id,
          target_type: TargetType.PRODUCT,
        })),
      });
    }

    return product;
  }

  // 3) Lấy sản phẩm của Shop
  async findAllBySeller(sellerId: string) {
    const products = await this.db.product.findMany({
      where: { seller_id: sellerId },
      orderBy: { created_at: 'desc' },
      include: {
        category: true,
        order_items: { include: { order: true } },
      },
    });

    if (products.length === 0) return [];

    const productIds = products.map((p) => p.id);
    const attachments = await this.db.attachment.findMany({
      where: { target_id: { in: productIds }, target_type: TargetType.PRODUCT },
      select: { target_id: true, url: true },
    });
    const imageMap = this.mapAttachmentsByTarget(attachments);

    // Sync status + is_active with current stock_quantity. Sticky terminal states
    // (DELETED, INACTIVE) are preserved by deriveStockStatus.
    const activationUpdates = products
      .map((p) => {
        const stock = Number(p.stock_quantity);
        const nextStatus = deriveStockStatus(stock, p.status);
        const nextActive = nextStatus === ProductStatus.ACTIVE;
        return nextStatus !== p.status || nextActive !== p.is_active
          ? { id: p.id, status: nextStatus, is_active: nextActive }
          : null;
      })
      .filter(Boolean) as { id: string; status: ProductStatus; is_active: boolean }[];

    if (activationUpdates.length > 0) {
      await Promise.all(
        activationUpdates.map((u) =>
          this.db.product.update({
            where: { id: u.id },
            data: { is_active: u.is_active, status: u.status },
          }),
        ),
      );
      for (const u of activationUpdates) {
        const p = products.find((x) => x.id === u.id);
        if (p) { p.is_active = u.is_active; p.status = u.status; }
      }
    }

    return products.map((p) => {
      const sold = p.order_items
        .filter((item) => item.order.status === 'COMPLETED')
        .reduce((sum, item) => sum + Number(item.quantity), 0);

      const stock = Number(p.stock_quantity);
      const isActive = stock > 0 && p.is_active;

      return {
        id: p.id,
        name: p.name,
        price: Number(p.reference_price),
        stock,
        description: p.description ?? '',
        images: imageMap[p.id] ?? [],
        category: p.category?.name ?? '',
        unit: p.unit,
        origin: p.location ?? '',
        rating: 5,
        sold,
        is_active: isActive,
        status: p.status,
        created_at: p.created_at,
        min_negotiation_qty: p.min_negotiation_qty
          ? Number(p.min_negotiation_qty)
          : null,
      };
    });
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

    return products.map((p) => {
      const stock = Number(p.stock_quantity);
      const isActive = stock > 0 && p.is_active;

      return {
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
        stock,
        is_active: isActive,
        seller_id: p.seller_id,
        shopName: p.seller?.profile?.store_name || p.seller.full_name,
        shop: {
          id: p.seller_id,
          store_name: p.seller?.profile?.store_name || p.seller.full_name,
          avatar_url: avatarMap[p.seller_id] ?? null,
        },
        rating: 5,
        reviewCount: 0,
        sold: 0,
        min_negotiation_qty: p.min_negotiation_qty ? Number(p.min_negotiation_qty) : null,
      };
    });
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

    // Cho phép xem cả khi sản phẩm đã ngừng bán để hiển thị trạng thái hết hàng
    if (!p) {
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

    const stock = Number(p.stock_quantity);
    const isActive = p.is_active && stock > 0;

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
      unit: p.unit,
      seller_id: p.seller_id,
      stock,
      is_active: isActive,
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
  async updateProduct(
    sellerId: string,
    productId: string,
    dto: Partial<CreateProductDto>,
    files: Express.Multer.File[] = [],
  ) {
    const product = await this.db.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Sản phẩm không tồn tại.');
    if (product.seller_id !== sellerId)
      throw new ForbiddenException('Bạn không có quyền chỉnh sửa sản phẩm này.');

    const categoryId = dto.category_id ?? dto.category
      ? await this.resolveCategoryId(dto.category_id ?? dto.category)
      : undefined;

    const stockValue = dto.stock_quantity ?? dto.stock;
    const nextStock = stockValue !== undefined ? Number(stockValue) : Number(product.stock_quantity);

    const minNegotiation = dto.min_negotiation_qty === undefined
      ? undefined
      : dto.min_negotiation_qty === 0
        ? null
        : dto.min_negotiation_qty;

    const nextStatus = deriveStockStatus(nextStock, product.status);
    const updated = await this.db.product.update({
      where: { id: productId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.reference_price !== undefined || dto.price !== undefined
          ? { reference_price: Number(dto.reference_price ?? dto.price) }
          : {}),
        ...(stockValue !== undefined ? { stock_quantity: nextStock } : {}),
        ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
        ...(dto.location !== undefined || dto.origin !== undefined
          ? { location: dto.location ?? dto.origin ?? null }
          : {}),
        ...(dto.certification !== undefined ? { certification: dto.certification } : {}),
        ...(categoryId !== undefined ? { category_id: categoryId } : {}),
        ...(minNegotiation !== undefined ? { min_negotiation_qty: minNegotiation } : {}),
        status: nextStatus,
        is_active: nextStatus === ProductStatus.ACTIVE,
      },
    });

    const appendedUrls = [
      ...this.normalizeImageUrls(dto.image_urls as any),
      ...files.map((file) => `/uploads/products/${file.filename}`),
    ];

    if (appendedUrls.length > 0) {
      await this.db.attachment.createMany({
        data: appendedUrls.map((url) => ({
          url,
          file_type: 'IMAGE',
          target_id: productId,
          target_type: TargetType.PRODUCT,
        })),
      });
    }

    return updated;
  }

  // ─── DELETE /products/:id — Soft delete (preserves row + order history) ─
  async deleteProduct(sellerId: string, productId: string) {
    const product = await this.db.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Sản phẩm không tồn tại.');
    if (product.seller_id !== sellerId)
      throw new ForbiddenException('Bạn không có quyền xóa sản phẩm này.');

    const updated = await this.db.product.update({
      where: { id: productId },
      data: { status: ProductStatus.DELETED, is_active: false },
    });
    return { message: 'Sản phẩm đã được ẩn khỏi danh sách bán.', data: updated };
  }

  // ─── PATCH /seller/products/:id/status — Manual lifecycle switch ─────────
  // Allowed transitions:
  //   ACTIVE     → INACTIVE | DELETED
  //   INACTIVE   → ACTIVE   (if stock>0; else OUT_OF_STOCK) | DELETED
  //   OUT_OF_STOCK → INACTIVE | DELETED   (ACTIVE requires real stock — use /restock)
  //   DELETED    → INACTIVE | (ACTIVE/OUT_OF_STOCK via stock derivation)
  async setStatus(sellerId: string, productId: string, requested: ProductStatus) {
    const product = await this.db.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Sản phẩm không tồn tại.');
    if (product.seller_id !== sellerId)
      throw new ForbiddenException('Bạn không có quyền đổi trạng thái sản phẩm này.');

    const stock = Number(product.stock_quantity);
    let target = requested;
    if (requested === ProductStatus.ACTIVE && stock <= 0) {
      // Can't go ACTIVE without stock — auto-correct to OUT_OF_STOCK
      target = ProductStatus.OUT_OF_STOCK;
    }
    if (requested === ProductStatus.OUT_OF_STOCK && stock > 0) {
      throw new BadRequestException(
        'Sản phẩm còn hàng — không thể đặt OUT_OF_STOCK. Dùng INACTIVE nếu muốn tạm ẩn.',
      );
    }

    const updated = await this.db.product.update({
      where: { id: productId },
      data: { status: target, is_active: target === ProductStatus.ACTIVE },
    });
    return { message: 'Đã cập nhật trạng thái sản phẩm.', data: updated };
  }

  // ─── PATCH /seller/products/:id/restock — Top up stock + auto-reactivate ─
  // Accepts either { stock } (absolute) or { add } (delta). After update,
  // status becomes ACTIVE if stock>0 (lifts INACTIVE/DELETED/OUT_OF_STOCK).
  async restockProduct(
    sellerId: string,
    productId: string,
    body: { stock?: number; add?: number },
  ) {
    const product = await this.db.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Sản phẩm không tồn tại.');
    if (product.seller_id !== sellerId)
      throw new ForbiddenException('Bạn không có quyền restock sản phẩm này.');

    const currentStock = Number(product.stock_quantity);
    let nextStock: number;
    if (body.stock !== undefined && body.stock !== null) {
      nextStock = Number(body.stock);
    } else if (body.add !== undefined && body.add !== null) {
      nextStock = currentStock + Number(body.add);
    } else {
      throw new BadRequestException('Cần truyền stock hoặc add.');
    }
    if (!Number.isFinite(nextStock) || nextStock < 0) {
      throw new BadRequestException('Số lượng tồn kho không hợp lệ.');
    }

    // Restock explicitly lifts terminal states — pass `undefined` so derive
    // computes purely from stock instead of preserving DELETED/INACTIVE.
    const nextStatus = nextStock > 0 ? ProductStatus.ACTIVE : ProductStatus.OUT_OF_STOCK;
    const updated = await this.db.product.update({
      where: { id: productId },
      data: {
        stock_quantity: nextStock,
        status: nextStatus,
        is_active: nextStatus === ProductStatus.ACTIVE,
      },
    });
    return { message: 'Đã cập nhật tồn kho sản phẩm.', data: updated };
  }

  // ─── GET /sellers/:id — Trang chi tiết người bán ────────────────────────
  async findSellerById(sellerId: string) {
    const seller = await this.db.user.findUnique({
      where: { id: sellerId, is_seller: true },
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

    // Shop location — build a public-safe Google Maps open URL on the BE so
    // the buyer FE can render a single href without redoing the fallback logic.
    const lat  = seller.profile?.shop_latitude  != null ? Number(seller.profile.shop_latitude)  : null;
    const lng  = seller.profile?.shop_longitude != null ? Number(seller.profile.shop_longitude) : null;
    const rawMapsUrl = seller.profile?.shop_google_maps_url || null;
    const address    = seller.profile?.address || null;
    const mapsOpenUrl = rawMapsUrl
      ? rawMapsUrl
      : (lat != null && lng != null)
        ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
        : (address && address.trim())
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address.trim())}`
          : null;

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
        // Public-safe shop location surface — never leaks private user data.
        shop_location_name:   seller.profile?.shop_location_name ?? null,
        shop_google_maps_url: rawMapsUrl,
        shop_latitude:        lat,
        shop_longitude:       lng,
        shop_maps_open_url:   mapsOpenUrl,
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