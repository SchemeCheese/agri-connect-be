import { Controller, Post, Get, Body, UseGuards, Request } from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dtos/create-review.dto';
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

  // GET /reviews/shop-reviews — Seller xem tất cả đánh giá nhận được
  @UseGuards(RolesGuard)
  @Roles(UserRole.SELLER)
  @Get('shop-reviews')
  async getShopReviews(@Request() req) {
    return this.reviewsService.getShopReviews(req.user.sub);
  }
}
