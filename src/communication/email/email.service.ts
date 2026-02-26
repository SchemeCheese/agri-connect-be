import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private mailerService: MailerService) {}

  async sendVerificationOTP(email: string, code: string, fullName: string) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: 'Xác thực tài khoản Agri Connect - Mã OTP của bạn',
        template: 'otp', // Bỏ './' đi, chỉ cần ghi 'otp' hoặc 'otp.hbs'
        context: {
          name: fullName || 'bạn',
          code: code,
          expireTime: '5 phút',
        },
      });
      
      this.logger.log(`[SUCCESS] Đã gửi OTP đến email: ${email}`);
      return true;
    } catch (error) {
      this.logger.error(`[ERROR] Lỗi gửi mail đến ${email}`, error);
      return false;
    }
  }
}