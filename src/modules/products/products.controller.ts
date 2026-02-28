import { Controller, Post, Get, Patch, Delete, Body, Request, UseGuards, Param, Query } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dtos/create-product.dto';
import { AuthGuard } from '@nestjs/passport'; 
import { RolesGuard } from '../auth/decorators/guards/roles.guard'; // (Nhớ check đường dẫn file roles.guard của bạn)
import { Roles } from '../auth/decorators/roles.decorator'; 
import { UserRole } from '@prisma/client';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @UseGuards(AuthGuard('jwt'), RolesGuard) 
  @Roles(UserRole.SELLER)
  @Post()
  create(@Request() req, @Body() dto: CreateProductDto) {
    return this.productsService.create(req.user.sub, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('my-products')
  findAllMyProducts(@Request() req) {
    return this.productsService.findAllBySeller(req.user.sub);
  }

  // API lấy danh sách cho trang chủ
  @Get()
  async getAllProducts() {
    return this.productsService.findAllPublic();
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
  async updateProduct(@Request() req, @Param('id') id: string, @Body() dto: Partial<import('./dtos/create-product.dto').CreateProductDto>) {
    return this.productsService.updateProduct(req.user.sub, id, dto);
  }

  // DELETE /products/:id — Ẩn sản phẩm
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SELLER)
  @Delete(':id')
  async deleteProduct(@Request() req, @Param('id') id: string) {
    return this.productsService.deleteProduct(req.user.sub, id);
  }
}