import { Controller, Get, Param, Query } from '@nestjs/common';
import { ShopsService } from './shops.service';

@Controller('shops')
export class ShopsController {
  constructor(private readonly shopsService: ShopsService) {}

  /**
   * GET /shops/top?limit=4&sort=sales|rating|reviews
   * Trả về danh sách top shop được sắp xếp theo tiêu chí
   */
  @Get('top')
  async getTopShops(
    @Query('limit') limit = '4',
    @Query('sort') sort: 'sales' | 'rating' | 'reviews' = 'sales',
  ) {
    const validSorts = ['sales', 'rating', 'reviews'];
    const safeSort = validSorts.includes(sort) ? sort : 'sales';
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 4, 1), 20);

    return this.shopsService.getTopShops(safeLimit, safeSort as 'sales' | 'rating' | 'reviews');
  }

  /**
   * GET /shops/:id — Chi tiết shop (public)
   */
  @Get(':id')
  async getShopById(@Param('id') id: string) {
    return this.shopsService.getShopById(id);
  }
}
