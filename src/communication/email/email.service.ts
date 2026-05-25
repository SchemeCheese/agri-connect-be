import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { PaymentMethod } from '@prisma/client';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private mailerService: MailerService) {}

  // Trả về false (kèm log) nếu thiếu MAIL_HOST/USER/PASS — tránh SMTP cố
  // connect tới undefined và throw từ nodemailer plugin chain (sync error
  // có thể thoát ra ngoài try-catch và sập tiến trình).
  private isSmtpConfigured(): boolean {
    return Boolean(process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS);
  }

  async sendVerificationOTP(email: string, code: string, fullName: string) {
    if (!this.isSmtpConfigured()) {
      this.logger.warn(`[SKIP] OTP cho ${email} — chưa cấu hình MAIL_HOST/MAIL_USER/MAIL_PASS trong .env`);
      throw new Error('Email service chưa được cấu hình. Liên hệ admin để bật SMTP.');
    }
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: 'Xác thực tài khoản Agri Connect - Mã OTP của bạn',
        template: 'otp', // templates/otp.hbs
        context: {
          name: fullName || 'bạn',
          code: code,
          expireTime: '5 phút',
        },
      });

      this.logger.log(`[SUCCESS] Đã gửi OTP đến email: ${email}`);
      return true;
    } catch (error) {
      // Quan trọng: OTP là luồng bắt buộc -> lỗi phải được bubble lên để API trả về đúng.
      this.logger.error(`[ERROR] Lỗi gửi OTP đến ${email}`, error);
      throw error;
    }
  }

  async sendCancelOrderEmail(
    email: string,
    buyerName: string,
    orderId: string,
    reason: string,
  ) {
    if (!this.isSmtpConfigured()) {
      this.logger.warn(`[SKIP] Email hủy đơn #${orderId} → ${email} — SMTP chưa cấu hình`);
      return false;
    }
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: `[Agri Connect] Đơn hàng #${orderId} đã bị hủy`,
        template: 'cancel-order',
        context: {
          buyerName: buyerName || 'bạn',
          orderId,
          reason,
        },
      });
      this.logger.log(`[SUCCESS] Đã gửi email hủy đơn #${orderId} đến: ${email}`);
      return true;
    } catch (error) {
      this.logger.error(`[ERROR] Lỗi gửi email hủy đơn đến ${email}`, error);
      return false;
    }
  }

  async sendRefundNotificationEmail(
    email: string,
    buyerName: string,
    orderId: string,
    amount: string,
    paymentMethod: PaymentMethod,
  ) {
    if (!this.isSmtpConfigured()) {
      this.logger.warn(`[SKIP] Email hoàn tiền #${orderId} → ${email} — SMTP chưa cấu hình`);
      return false;
    }
    const methodLabels: Record<PaymentMethod, string> = {
      COD: 'Thanh toán khi nhận hàng',
      QR_CODE: 'QR Ngân hàng',
      MOMO: 'Ví MoMo',
      ZALOPAY: 'ZaloPay',
    };

    try {
      await this.mailerService.sendMail({
        to: email,
        subject: `[Agri Connect] Hoàn tiền đơn hàng #${orderId}`,
        template: 'refund-notification',
        context: {
          buyerName: buyerName || 'bạn',
          orderId,
          amount: Number(amount).toLocaleString('vi-VN'),
          paymentMethod: methodLabels[paymentMethod] ?? paymentMethod,
        },
      });
      this.logger.log(`[SUCCESS] Đã gửi email hoàn tiền đơn #${orderId} đến: ${email}`);
      return true;
    } catch (error) {
      this.logger.error(`[ERROR] Lỗi gửi email hoàn tiền đến ${email}`, error);
      return false;
    }
  }

  async sendOrderFailedCodEmail(
    buyerEmail: string,
    buyerName: string,
    sellerName: string,
    orderId: string,
  ) {
    if (!this.isSmtpConfigured()) {
      this.logger.warn(`[SKIP] Email COD fail #${orderId} → ${buyerEmail} — SMTP chưa cấu hình`);
      return false;
    }
    try {
      await this.mailerService.sendMail({
        to: buyerEmail,
        subject: `[Agri Connect] Đơn hàng #${orderId} giao thất bại`,
        template: 'order-failed-cod',
        context: {
          buyerName: buyerName || 'bạn',
          sellerName,
          orderId,
        },
      });
      this.logger.log(`[SUCCESS] Đã gửi email giao thất bại (COD) đơn #${orderId} đến buyer: ${buyerEmail}`);
      return true;
    } catch (error) {
      this.logger.error(`[ERROR] Lỗi gửi email giao thất bại đến ${buyerEmail}`, error);
      return false;
    }
  }

  async sendIssueReportedToBuyerEmail(
    buyerEmail: string,
    buyerName: string,
    sellerName: string,
    orderId: string,
    note: string,
  ) {
    if (!this.isSmtpConfigured()) {
      this.logger.warn(`[SKIP] Email báo sự cố (buyer) #${orderId} → ${buyerEmail} — SMTP chưa cấu hình`);
      return false;
    }
    try {
      await this.mailerService.sendMail({
        to: buyerEmail,
        subject: `[Agri Connect] Đã ghi nhận báo cáo sự cố đơn hàng #${orderId}`,
        template: 'issue-reported-buyer',
        context: {
          buyerName: buyerName || 'bạn',
          orderId,
          sellerName,
          note,
        },
      });
      this.logger.log(`[SUCCESS] Đã gửi email xác nhận sự cố đơn #${orderId} đến buyer: ${buyerEmail}`);
      return true;
    } catch (error) {
      this.logger.error(`[ERROR] Lỗi gửi email xác nhận sự cố đến ${buyerEmail}`, error);
      return false;
    }
  }

  async sendIssueReportedToSellerEmail(
    sellerEmail: string,
    sellerName: string,
    buyerName: string,
    orderId: string,
    paymentMethod: PaymentMethod,
    note: string,
  ) {
    if (!this.isSmtpConfigured()) {
      this.logger.warn(`[SKIP] Email báo sự cố (seller) #${orderId} → ${sellerEmail} — SMTP chưa cấu hình`);
      return false;
    }
    const methodLabels: Record<PaymentMethod, string> = {
      COD: 'Thanh toán khi nhận hàng',
      QR_CODE: 'QR Ngân hàng',
      MOMO: 'Ví MoMo',
      ZALOPAY: 'ZaloPay',
    };

    try {
      await this.mailerService.sendMail({
        to: sellerEmail,
        subject: `[Agri Connect] ⚠️ Sự cố đơn hàng #${orderId} - Người mua chưa nhận được hàng`,
        template: 'issue-reported-seller',
        context: {
          sellerName: sellerName || 'bạn',
          buyerName: buyerName || 'Người mua',
          orderId,
          paymentMethod: methodLabels[paymentMethod] ?? paymentMethod,
          note,
        },
      });
      this.logger.log(`[SUCCESS] Đã gửi email sự cố đơn #${orderId} đến seller: ${sellerEmail}`);
      return true;
    } catch (error) {
      this.logger.error(`[ERROR] Lỗi gửi email sự cố đến ${sellerEmail}`, error);
      return false;
    }
  }

  async sendSellerReplyEmail(
    buyerEmail: string,
    buyerName: string,
    sellerName: string,
    orderId: string,
    reply: string,
  ) {
    if (!this.isSmtpConfigured()) {
      this.logger.warn(`[SKIP] Email seller reply #${orderId} → ${buyerEmail} — SMTP chưa cấu hình`);
      return false;
    }
    try {
      await this.mailerService.sendMail({
        to: buyerEmail,
        subject: `[Agri Connect] Người bán đã phản hồi đánh giá của bạn - Đơn #${orderId}`,
        template: 'seller-reply',
        context: {
          buyerName: buyerName || 'bạn',
          sellerName,
          orderId,
          reply,
        },
      });
      this.logger.log(`[SUCCESS] Đã gửi email phản hồi review đơn #${orderId} đến buyer: ${buyerEmail}`);
      return true;
    } catch (error) {
      this.logger.error(`[ERROR] Lỗi gửi email phản hồi review đến ${buyerEmail}`, error);
      return false;
    }
  }
}