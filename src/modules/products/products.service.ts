import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CreateProductDto } from './dtos/create-product.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly db: DatabaseService) {}

  // 1. Tạo sản phẩm mới (Cần ID người bán)
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
        seller_id: sellerId, // Liên kết với người bán đang đăng nhập
        category_id: dto.category_id,
      },
    });
  }

  // 2. Lấy danh sách sản phẩm của người bán
  async findAllBySeller(sellerId: string) {
    const products = await this.db.product.findMany({
      where: { seller_id: sellerId },
      orderBy: { created_at: 'desc' },
      include: { 
        category: true,
        // Thêm dòng này để lấy danh sách ảnh
        // Lưu ý: Cần khai báo relation trong schema.prisma nếu dùng relation field
        // Hoặc query thủ công nếu chưa có relation
      },
    });
    
    // Cách đơn giản nhất nếu chưa setup relation Attachment trong User/Product model:
    // Lấy ảnh riêng và ghép vào (hoặc tốt nhất là thêm relation vào schema)
    
    // -- GIẢI PHÁP TỐT NHẤT: Sửa schema.prisma để thêm quan hệ --
    return products;
  }
}