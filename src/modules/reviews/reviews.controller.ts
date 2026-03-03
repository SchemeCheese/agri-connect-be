import { Controller, Post, Get, Patch, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dtos/create-review.dto';
import { ReplyReviewDto } from './dtos/reply-review.dto';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/decorators/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@Controller('reviews')
@UseGuards(JwtAuthGuard)
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  // POST /reviews — Buyer tạo đánh giá (chỉ sau khi đơn COMPLETED)
  @UseGuards(RolesGuard)
  @Roles(UserRole.BUYER)
  @Post()
  async createReview(@Request() req, @Body() dto: CreateReviewDto) {
    return this.reviewsService.createReview(req.user.sub, dto);
  }

  // GET /reviews/my-reviews — Buyer xem lại danh sách đã đánh giá
  @UseGuards(RolesGuard)
  @Roles(UserRole.BUYER)
  @Get('my-reviews')
  async getMyReviews(@Request() req) {
    return this.reviewsService.getMyReviews(req.user.sub);
  }

  // GET /reviews/shop-reviews?filter=all|replied|unreplied — Seller xem đánh giá (phân tab)
  @UseGuards(RolesGuard)
  @Roles(UserRole.SELLER)
  @Get('shop-reviews')
  async getShopReviews(
    @Request() req,
    @Query('filter') filter: string = 'all',
  ) {
    const validFilter = ['all', 'replied', 'unreplied'].includes(filter)
      ? (filter as 'all' | 'replied' | 'unreplied')
      : 'all';
    return this.reviewsService.getShopReviews(req.user.sub, validFilter);
  }

  // PATCH /reviews/:id/reply — Seller phản hồi đánh giá
  @UseGuards(RolesGuard)
  @Roles(UserRole.SELLER)
  @Patch(':id/reply')
  async replyToReview(
    @Request() req,
    @Param('id') reviewId: string,
    @Body() dto: ReplyReviewDto,
  ) {
    return this.reviewsService.replyToReview(req.user.sub, reviewId, dto);
  }
}

