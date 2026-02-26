import { Controller, Post, Get, Body, Request, UseGuards, Param } from '@nestjs/common';
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

  // API lấy chi tiết 1 sản phẩm
  @Get(':id')
  async getProductById(@Param('id') id: string) {
    return this.productsService.findOnePublic(id);
  }
}