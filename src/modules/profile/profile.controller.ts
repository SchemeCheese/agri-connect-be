import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
  Request,
  Post,
  Delete,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { ProfileService } from './profile.service';
import { UpdateProfileDto } from './dtos/update-profile.dto';
import { RemoveBannerDto } from './dtos/remove-banner.dto';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';

// Cấu hình lưu file vào thư mục public/uploads/avatars/
const avatarStorage = diskStorage({
  destination: join(process.cwd(), 'public', 'uploads', 'avatars'),
  filename: (_req, file, cb) => {
    const uniqueName = `${randomUUID()}${extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const imageFileFilter = (_req: any, file: Express.Multer.File, cb: any) => {
  if (!file.mimetype.match(/\/(jpg|jpeg|png|gif|webp)$/)) {
    return cb(new BadRequestException('Chỉ chấp nhận file ảnh (jpg, jpeg, png, gif, webp).'), false);
  }
  cb(null, true);
};

@Controller('profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  // GET /profile/me — Lấy thông tin cá nhân + avatar
  @Get('me')
  async getProfile(@Request() req) {
    return this.profileService.getMyProfile(req.user.sub);
  }

  // PATCH /profile/me — Cập nhật thông tin cá nhân (text fields)
  @Patch('me')
  async updateProfile(@Request() req, @Body() dto: UpdateProfileDto) {
    return this.profileService.updateProfile(req.user.sub, dto);
  }

  // POST /profile/me/avatar — Upload ảnh đại diện (multipart/form-data, field: "file")
  @Post('me/avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: avatarStorage,
      fileFilter: imageFileFilter,
      limits: { fileSize: 5 * 1024 * 1024 }, // Tối đa 5MB
    }),
  )
  async uploadAvatar(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Không có file được gửi lên.');

    // URL truy cập công khai (vì public/ đã được serve static trong main.ts)
    const fileUrl = `/uploads/avatars/${file.filename}`;
    return this.profileService.updateAvatar(req.user.sub, fileUrl);
  }

  /**
   * PATCH /profile/update — Cập nhật tổng hợp: text fields + avatar tuỳ chọn
   * Content-Type: multipart/form-data
   * Fields: full_name, phone_number, store_name, address (hoặc store_address),
   *         description (hoặc store_description)
   * File field (optional): "avatar"
   *
   * Đây là endpoint FE nên dùng để cập nhật profile (không cần gọi 2 request riêng).
   */
  @Patch('update')
  @UseInterceptors(
    FileInterceptor('avatar', {
      storage: avatarStorage,
      fileFilter: imageFileFilter,
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async updateFull(
    @Request() req,
    @Body() dto: UpdateProfileDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const updatedProfile = await this.profileService.updateProfile(req.user.sub, dto);

    if (file) {
      const fileUrl = `/uploads/avatars/${file.filename}`;
      await this.profileService.updateAvatar(req.user.sub, fileUrl);
      return { ...updatedProfile, avatar: fileUrl };
    }

    return updatedProfile;
  }

  /**
   * POST /profile/me/banner — Upload ảnh bìa shop (seller)
   * Content-Type: multipart/form-data, field: "file"
   */
  @Post('me/banner')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: avatarStorage,
      fileFilter: imageFileFilter,
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async uploadBanner(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Không có file được gửi lên.');
    const fileUrl = `/uploads/avatars/${file.filename}`;
    return this.profileService.updateCover(req.user.sub, fileUrl);
  }

  /**
   * POST /profile/me/banners — Append one banner image (max 3 active).
   * Content-Type: multipart/form-data, field: "file"
   * Returns { banners: string[] } — the full ordered list after append.
   */
  @Post('me/banners')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: avatarStorage,
      fileFilter: imageFileFilter,
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async addShopBanner(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Không có file được gửi lên.');
    const fileUrl = `/uploads/avatars/${file.filename}`;
    return this.profileService.addBanner(req.user.sub, fileUrl);
  }

  /**
   * DELETE /profile/me/banners — Remove one banner by URL from banners1[].
   * Body: { url: string } — must be the stored relative path (e.g. /uploads/avatars/xxx.png)
   */
  @Delete('me/banners')
  async deleteShopBanner(
    @Request() req,
    @Body() body: RemoveBannerDto,
  ) {
    return this.profileService.removeBanner(req.user.sub, body.url);
  }
}
