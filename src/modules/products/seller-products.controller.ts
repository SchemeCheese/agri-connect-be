import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Request,
  UseGuards,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';

import { ProductsService } from './products.service';
import { CreateProductDto } from './dtos/create-product.dto';
import { SetStatusDto } from './dtos/set-status.dto';
import { RestockDto } from './dtos/restock.dto';
import { RolesGuard } from '../auth/decorators/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';

// Same upload destination as ProductsController — keep one place per asset type
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

/**
 * Seller-scoped product surface.
 *
 *   GET    /seller/products           — list current seller's products (all statuses)
 *   POST   /seller/products           — create
 *   PATCH  /seller/products/:id       — edit fields / images
 *   PATCH  /seller/products/:id/status   — manual ACTIVE/INACTIVE/DELETED switch
 *   PATCH  /seller/products/:id/restock  — top up stock, auto-reactivate
 *   DELETE /seller/products/:id       — soft-delete (status = DELETED)
 *
 * All routes require SELLER role. Ownership is enforced inside ProductsService.
 */
@Controller('seller/products')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.SELLER)
export class SellerProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  list(@Request() req) {
    return this.productsService.findAllBySeller(req.user.sub);
  }

  @Post()
  @UseInterceptors(AnyFilesInterceptor(multerOptions))
  create(
    @Request() req,
    @Body() dto: CreateProductDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.productsService.create(req.user.sub, dto, files);
  }

  @Patch(':id')
  @UseInterceptors(AnyFilesInterceptor(multerOptions))
  update(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: Partial<CreateProductDto>,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.productsService.updateProduct(req.user.sub, id, dto, files);
  }

  @Patch(':id/status')
  setStatus(@Request() req, @Param('id') id: string, @Body() dto: SetStatusDto) {
    return this.productsService.setStatus(req.user.sub, id, dto.status);
  }

  @Patch(':id/restock')
  restock(@Request() req, @Param('id') id: string, @Body() dto: RestockDto) {
    return this.productsService.restockProduct(req.user.sub, id, dto);
  }

  @Delete(':id')
  remove(@Request() req, @Param('id') id: string) {
    return this.productsService.deleteProduct(req.user.sub, id);
  }
}
