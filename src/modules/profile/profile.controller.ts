import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
  Request,
  Post,
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
}
