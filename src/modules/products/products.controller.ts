import { Controller, Post, Get, Body, Request, UseGuards } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dtos/create-product.dto';
import { AuthGuard } from '@nestjs/passport'; // Hoặc guard bạn đã tạo từ module Auth

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  // API: POST /products (Tạo sản phẩm)
  @UseGuards(AuthGuard('jwt')) 
  @Post()
  create(@Request() req, @Body() dto: CreateProductDto) {
    // req.user được lấy từ JWT Token (đã làm ở bài trước)
    return this.productsService.create(req.user.sub, dto);
  }

  // API: GET /products/my-products 
  @UseGuards(AuthGuard('jwt'))
  @Get('my-products')
  findAllMyProducts(@Request() req) {
    return this.productsService.findAllBySeller(req.user.sub);
  }
}