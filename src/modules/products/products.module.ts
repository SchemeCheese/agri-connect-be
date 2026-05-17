import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { SellerProductsController } from './seller-products.controller';
import { ProductsService } from './products.service';

@Module({
  controllers: [ProductsController, SellerProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
