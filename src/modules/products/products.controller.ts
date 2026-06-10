import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Request,
  UseGuards,
  Param,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dtos/create-product.dto';
import { AuthGuard } from '@nestjs/passport'; 
import { RolesGuard } from '../auth/decorators/guards/roles.guard'; // (Nhớ check đường dẫn file roles.guard của bạn)
import { Roles } from '../auth/decorators/roles.decorator'; 
import { UserRole } from '../auth/decorators/roles.decorator';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';

const PRODUCT_UPLOAD_DIR = join(__dirname, '..', '..', '..', 'public', 'uploads', 'products');
fs.mkdirSync(PRODUCT_UPLOAD_DIR, { recursive: true });

const multerOptions = {
  storage: diskStorage({
    destination: PRODUCT_UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${unique}${extname(file.originalname)}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 6 },
};

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @UseGuards(AuthGuard('jwt'), RolesGuard) 
  @Roles(UserRole.SELLER)
  @Post()
  @UseInterceptors(AnyFilesInterceptor(multerOptions))
  create(@Request() req, @Body() dto: CreateProductDto, @UploadedFiles() files: Express.Multer.File[]) {
    return this.productsService.create(req.user.sub, dto, files);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SELLER)
  @Get('my-products')
  findAllMyProducts(@Request() req) {
    return this.productsService.findAllBySeller(req.user.sub);
  }

  // API lấy danh sách cho trang chủ
  @Get()
  async getAllProducts() {
    return this.productsService.findAllPublic();
  }

  // Tìm kiếm sản phẩm có phân trang (PostgreSQL insensitive contains). KHÔNG đổi
  // GET / (findAllPublic) để tránh vỡ FE cũ. Phải đặt TRƯỚC :id.
  @Get('search')
  async searchProducts(
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.productsService.searchPublic(q ?? '', Number(page) || 1, Number(limit) || 12);
  }

  // Danh sách danh mục — FE dùng để render dropdown bằng id số. Phải đặt TRƯỚC :id.
  @Get('categories')
  async listCategories() {
    return this.productsService.listCategories();
  }

  // API lấy trang chi tiết người bán (public) — phải đặt TRƯỚC :id
  @Get('sellers/:id')
  async getSellerById(@Param('id') sellerId: string) {
    return this.productsService.findSellerById(sellerId);
  }

  // API lấy chi tiết 1 sản phẩm
  @Get(':id')
  async getProductById(@Param('id') id: string) {
    return this.productsService.findOnePublic(id);
  }

  // PATCH /products/:id — Cập nhật sản phẩm
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SELLER)
  @Patch(':id')
  @UseInterceptors(AnyFilesInterceptor(multerOptions))
  async updateProduct(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: Partial<import('./dtos/create-product.dto').CreateProductDto>,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.productsService.updateProduct(req.user.sub, id, dto, files);
  }

  // DELETE /products/:id — Ẩn sản phẩm
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SELLER)
  @Delete(':id')
  async deleteProduct(@Request() req, @Param('id') id: string) {
    return this.productsService.deleteProduct(req.user.sub, id);
  }
}