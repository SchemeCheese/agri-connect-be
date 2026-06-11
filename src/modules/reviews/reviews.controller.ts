import {
  Controller, Post, Get, Patch, Body, Param, Query, UseGuards, Request,
  UseInterceptors, UploadedFile, BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dtos/create-review.dto';
import { ReplyReviewDto } from './dtos/reply-review.dto';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/decorators/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/decorators/roles.decorator';

// Ảnh review lưu vào public/uploads/reviews/ (main.ts serve tĩnh `public/`).
const REVIEW_UPLOAD_DIR = join(__dirname, '..', '..', '..', 'public', 'uploads', 'reviews');
fs.mkdirSync(REVIEW_UPLOAD_DIR, { recursive: true });

// Chỉ chấp nhận JPEG/PNG/WEBP theo yêu cầu. KHÔNG nhận gif/heic...
const REVIEW_IMAGE_ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const REVIEW_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const reviewImageMulter = {
  storage: diskStorage({
    destination: REVIEW_UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${unique}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: REVIEW_IMAGE_MAX_BYTES, files: 1 },
  fileFilter: (
    _req: unknown,
    file: { mimetype: string },
    cb: (err: Error | null, accept: boolean) => void,
  ) => {
    if (REVIEW_IMAGE_ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new BadRequestException('Chỉ chấp nhận ảnh JPEG, PNG hoặc WEBP.'), false);
  },
};

@ApiTags('Reviews')
@ApiBearerAuth('access-token')
@Controller('reviews')
@UseGuards(JwtAuthGuard)
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  // POST /reviews/upload — upload 1 ảnh review (multipart field `file`). Trả { url }.
  // Auth required (JwtAuthGuard ở controller). Chỉ JPEG/PNG/WEBP ≤ 5MB. KHÔNG lộ path
  // local — chỉ trả URL public /uploads/reviews/<filename>. FE upload trước rồi gửi
  // mảng URL vào POST /reviews. Đặt TRƯỚC @Post() để khỏi nhầm với route gốc.
  @ApiOperation({ summary: 'Upload ảnh đánh giá', description: 'Multipart field `file`. JPEG/PNG/WEBP ≤ 5MB. Trả { url }.' })
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', reviewImageMulter))
  async uploadReviewImage(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Thiếu file ảnh.');
    // Double-check sau fileFilter (đề phòng cấu hình lệch).
    if (!REVIEW_IMAGE_ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException('Chỉ chấp nhận ảnh JPEG, PNG hoặc WEBP.');
    }
    if (file.size > REVIEW_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Ảnh vượt quá 5MB.');
    }
    return { url: `/uploads/reviews/${file.filename}`, size: file.size, mime: file.mimetype };
  }

  // POST /reviews — Buyer tạo đánh giá (chỉ sau khi đơn COMPLETED). 3 req/phút/IP.
  @ApiOperation({ summary: 'Tạo đánh giá', description: 'BUYER đánh giá đơn COMPLETED. Trùng → 400. Rate-limit 3/phút.' })
  @Throttle({ default: { limit: 3, ttl: 60000 } })
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

