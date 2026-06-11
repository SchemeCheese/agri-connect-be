import { Controller, Get, Param, Query } from '@nestjs/common';
import { ShopsService } from './shops.service';

@Controller('shops')
export class ShopsController {
  constructor(private readonly shopsService: ShopsService) {}

  /**
   * GET /shops/top?limit=4&sort=score|sales|rating|reviews
   * Mặc định `score`: điểm tổng hợp có trọng số (doanh thu/đơn/rating/dispute/chat).
   * sales|rating|reviews giữ lại để tương thích FE cũ.
   */
  @Get('top')
  async getTopShops(
    @Query('limit') limit = '4',
    @Query('sort') sort: 'score' | 'sales' | 'rating' | 'reviews' = 'score',
  ) {
    const validSorts = ['score', 'sales', 'rating', 'reviews'];
    const safeSort = validSorts.includes(sort) ? sort : 'score';
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 4, 1), 20);

    return this.shopsService.getTopShops(
      safeLimit,
      safeSort as 'score' | 'sales' | 'rating' | 'reviews',
    );
  }

  /**
   * GET /shops/:id — Chi tiết shop (public)
   */
  @Get(':id')
  async getShopById(@Param('id') id: string) {
    return this.shopsService.getShopById(id);
  }
}
