import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service'; 

@Injectable()
export class VerificationService {
  constructor(private readonly databaseService: DatabaseService) {}

  // 1. Sinh mã OTP 6 số ngẫu nhiên
  private generateOTP(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  // 2. Lưu OTP vào Database
  async createVerification(userId: string) {
    const code = this.generateOTP();
    const expires_at = new Date(Date.now() + 5 * 60 * 1000); // 5 phút

    // Xóa các mã cũ của user này (nếu có) để tránh spam
    await this.databaseService.verification.deleteMany({
      where: { userId },
    });

    // Tạo mã mới
    return this.databaseService.verification.create({
      data: {
        code,
        userId,
        expires_at,
        type: 'EMAIL'
      },
    });
  }

  // 3. Kiểm tra OTP
  async verifyCode(userId: string, code: string) {
    const verification = await this.databaseService.verification.findFirst({
      where: {
        userId,
        code,
        expires_at: {
          gt: new Date(), // Phải còn hạn (lớn hơn thời gian hiện tại)
        },
      },
    });

    if (!verification) {
      throw new HttpException('Mã OTP không hợp lệ hoặc đã hết hạn', HttpStatus.BAD_REQUEST);
    }

    // Nếu đúng, xóa mã OTP đi để không dùng lại được nữa
    await this.databaseService.verification.delete({
      where: { id: verification.id },
    });

    return true;
  }
}