import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { PaymentMethod } from '@prisma/client';

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

  async sendCancelOrderEmail(
    email: string,
    buyerName: string,
    orderId: string,
    reason: string,
  ) {
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

  async sendIssueReportedToBuyerEmail(
    buyerEmail: string,
    buyerName: string,
    sellerName: string,
    orderId: string,
    note: string,
  ) {
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
}