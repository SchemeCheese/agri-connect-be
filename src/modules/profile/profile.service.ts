import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { UpdateProfileDto } from './dtos/update-profile.dto';
import { TargetType } from '@prisma/client';

@Injectable()
export class ProfileService {
  constructor(private readonly db: DatabaseService) {}

  // ─── GET /profile/me ─────────────────────────────────────────────────────
  async getMyProfile(userId: string) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        full_name: true,
        phone_number: true,
        role: true,
        verified_email: true,
        created_at: true,
        profile: true,
      },
    });

    if (!user) throw new NotFoundException('Người dùng không tồn tại.');

    // Lấy avatar từ bảng Attachment
    const avatarAttachment = await this.db.attachment.findFirst({
      where: { target_id: userId, target_type: TargetType.AVATAR },
      orderBy: { created_at: 'desc' },
      select: { id: true, url: true },
    });

    return {
      ...user,
      avatar: avatarAttachment?.url ?? null,
    };
  }

  // ─── PATCH /profile/me — Cập nhật thông tin (không kèm ảnh) ─────────────
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    // Cập nhật bảng User (full_name, phone_number)
    const userUpdateData: Record<string, any> = {};
    if (dto.full_name !== undefined) userUpdateData.full_name = dto.full_name;
    if (dto.phone_number !== undefined) userUpdateData.phone_number = dto.phone_number;

    if (Object.keys(userUpdateData).length > 0) {
      await this.db.user.update({
        where: { id: userId },
        data: userUpdateData,
      });
    }

    // Cập nhật hoặc tạo bảng Profile (store_name, address, description)
    const profileUpdateData: Record<string, any> = {};
    if (dto.store_name !== undefined) profileUpdateData.store_name = dto.store_name;
    if (dto.address !== undefined) profileUpdateData.address = dto.address;
    if (dto.description !== undefined) profileUpdateData.description = dto.description;

    if (Object.keys(profileUpdateData).length > 0) {
      await this.db.profile.upsert({
        where: { user_id: userId },
        update: profileUpdateData,
        create: { user_id: userId, ...profileUpdateData },
      });
    }

    return this.getMyProfile(userId);
  }

  // ─── PATCH /profile/me/avatar — Upload / cập nhật avatar ─────────────────
  // Nhận file từ Multer (đã lưu vào disk), lưu URL vào bảng Attachment
  async updateAvatar(userId: string, fileUrl: string) {
    // Xóa avatar cũ nếu có (giữ DB gọn)
    await this.db.attachment.deleteMany({
      where: { target_id: userId, target_type: TargetType.AVATAR },
    });

    // Tạo record mới
    await this.db.attachment.create({
      data: {
        url: fileUrl,
        file_type: 'IMAGE',
        target_id: userId,
        target_type: TargetType.AVATAR,
      },
    });

    return { avatar: fileUrl };
  }
}
