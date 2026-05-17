import { IsEnum, IsNotEmpty } from 'class-validator';
import { ProductStatus } from '@prisma/client';

export class SetStatusDto {
  // Seller can only flip between ACTIVE and INACTIVE manually.
  // OUT_OF_STOCK is derived from stock_quantity; DELETED is set by DELETE endpoint.
  @IsNotEmpty()
  @IsEnum(ProductStatus, { message: 'status phải là ACTIVE | OUT_OF_STOCK | INACTIVE | DELETED' })
  status: ProductStatus;
}
