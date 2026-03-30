import { Injectable, BadRequestException, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { PaymentStatus, PaymentMethod, OrderStatus } from '@prisma/client';
import axios from 'axios';
import * as crypto from 'crypto';

interface MomoIpnPayload {
  partnerCode: string;
  orderId: string;
  requestId: string;
  amount: string;
  orderInfo: string;
  orderType: string;
  transId: string;
  resultCode: number;
  message: string;
  payType: string;
  responseTime: number;
  extraData: string;
  signature: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(private readonly db: DatabaseService) {}

  private getMomoConfig() {
    const partnerCode = process.env.MOMO_PARTNER_CODE;
    const accessKey = process.env.MOMO_ACCESS_KEY;
    const secretKey = process.env.MOMO_SECRET_KEY;
    const endpoint = process.env.MOMO_ENDPOINT || 'https://test-payment.momo.vn/v2/gateway/api/create';
    const redirectUrl = process.env.MOMO_REDIRECT_URL || 'http://localhost:3000/payment-result';
    const ipnUrl = process.env.MOMO_IPN_URL || 'http://localhost:3001/payments/momo/ipn';

    if (!partnerCode || !accessKey || !secretKey) {
      throw new BadRequestException('Chưa cấu hình biến môi trường MoMo (MOMO_PARTNER_CODE, MOMO_ACCESS_KEY, MOMO_SECRET_KEY)');
    }

    return { partnerCode, accessKey, secretKey, endpoint, redirectUrl, ipnUrl };
  }

  private signMomoRequest(raw: string, secretKey: string) {
    return crypto.createHmac('sha256', secretKey).update(raw).digest('hex');
  }

  async createMomoPayment(buyerId: string, orderId: string) {
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      include: { payments: true },
    });

    if (!order) throw new NotFoundException('Đơn hàng không tồn tại');
    if (order.buyer_id !== buyerId) throw new ForbiddenException('Bạn không sở hữu đơn hàng này');
    if (order.payment_method !== PaymentMethod.MOMO) {
      throw new BadRequestException('Đơn hàng này không chọn phương thức MoMo');
    }

    // Lấy payment record (được tạo ở bước checkout)
    const payment = order.payments?.[0];
    if (!payment) throw new NotFoundException('Chưa có bản ghi thanh toán cho đơn này');
    if (payment.status === PaymentStatus.PAID) {
      return { message: 'Đơn đã thanh toán MoMo', payUrl: null };
    }

    const amount = Number(payment.amount);
    const { partnerCode, accessKey, secretKey, endpoint, redirectUrl, ipnUrl } = this.getMomoConfig();

    const requestId = `${Date.now()}`;
    const orderInfo = `Thanh toan don hang ${orderId}`;
    const requestType = 'captureWallet';
    const extraData = '';

    const rawSignature =
      `accessKey=${accessKey}&amount=${amount}&extraData=${extraData}&ipnUrl=${ipnUrl}` +
      `&orderId=${orderId}&orderInfo=${orderInfo}&partnerCode=${partnerCode}` +
      `&redirectUrl=${redirectUrl}&requestId=${requestId}&requestType=${requestType}`;

    const signature = this.signMomoRequest(rawSignature, secretKey);

    const payload = {
      partnerCode,
      accessKey,
      requestId,
      amount: amount.toString(),
      orderId,
      orderInfo,
      redirectUrl,
      ipnUrl,
      extraData,
      requestType,
      signature,
      lang: 'vi',
    };

    const response = await axios.post(endpoint, payload, { headers: { 'Content-Type': 'application/json' } });
    const data = response.data as any;

    if (data?.resultCode !== 0) {
      this.logger.error(`MoMo create fail: ${JSON.stringify(data)}`);
      throw new BadRequestException(data?.message || 'Không tạo được giao dịch MoMo');
    }

    // Lưu transaction_ref (payUrl requestId) để tiện tracking
    await this.db.payment.update({
      where: { id: payment.id },
      data: { transaction_ref: data.payUrl ?? data.deeplink ?? requestId },
    });

    return {
      payUrl: data.payUrl,
      deeplink: data.deeplink,
      qrCodeUrl: data.qrCodeUrl,
      requestId,
    };
  }

  async handleMomoIpn(ipn: MomoIpnPayload) {
    const { partnerCode, accessKey, secretKey } = this.getMomoConfig();

    if (ipn.partnerCode !== partnerCode) {
      this.logger.warn(`IPN partnerCode mismatch: ${ipn.partnerCode}`);
      throw new BadRequestException('Invalid partnerCode');
    }

    const rawSignature =
      `accessKey=${accessKey}&amount=${ipn.amount}&extraData=${ipn.extraData}&message=${ipn.message}` +
      `&orderId=${ipn.orderId}&orderInfo=${ipn.orderInfo}&orderType=${ipn.orderType}` +
      `&partnerCode=${ipn.partnerCode}&payType=${ipn.payType}&requestId=${ipn.requestId}` +
      `&responseTime=${ipn.responseTime}&resultCode=${ipn.resultCode}&transId=${ipn.transId}`;

    const expected = this.signMomoRequest(rawSignature, secretKey);
    if (expected !== ipn.signature) {
      this.logger.warn('MoMo IPN signature mismatch');
      throw new BadRequestException('Invalid signature');
    }

    // Only process success once
    if (ipn.resultCode === 0) {
      await this.db.$transaction(async (tx) => {
        const payment = await tx.payment.findFirst({ where: { order_id: ipn.orderId } });
        if (!payment) throw new NotFoundException('Payment not found');

        if (payment.status !== PaymentStatus.PAID) {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.PAID,
              transaction_ref: ipn.transId,
            },
          });

          await tx.order.update({
            where: { id: ipn.orderId },
            data: { status: OrderStatus.CONFIRMED },
          });
        }
      });
    }

    return { resultCode: 0, message: 'OK' };
  }
}
