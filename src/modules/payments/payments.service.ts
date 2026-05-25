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
    // .trim() để chống leading/trailing whitespace trong .env (ví dụ
    // `MOMO_IPN_URL= https://...` → MoMo reject URL → không nhận được IPN
    // → Payment không bao giờ flip PAID → FE polling mắc kẹt UNPAID).
    const partnerCode = process.env.MOMO_PARTNER_CODE?.trim();
    const accessKey = process.env.MOMO_ACCESS_KEY?.trim();
    const secretKey = process.env.MOMO_SECRET_KEY?.trim();
    const endpoint = process.env.MOMO_ENDPOINT?.trim() || 'https://test-payment.momo.vn/v2/gateway/api/create';
    const redirectUrl = process.env.MOMO_REDIRECT_URL?.trim() || 'http://localhost:3001/payments/momo/return';
    const ipnUrl = process.env.MOMO_IPN_URL?.trim();

    if (!partnerCode || !accessKey || !secretKey) {
      throw new BadRequestException('Chưa cấu hình biến môi trường MoMo (MOMO_PARTNER_CODE, MOMO_ACCESS_KEY, MOMO_SECRET_KEY)');
    }
    if (!ipnUrl) {
      throw new BadRequestException('Thiếu cấu hình MOMO_IPN_URL — set biến môi trường này tới URL public (ví dụ ngrok https://xxx.ngrok-free.app/payments/momo/ipn)');
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

    // MoMo dedupe theo orderId — phải unique mỗi lần gen QR. Order.id là CUID
    // (không chứa dấu '-'), nên IPN/return chỉ cần split('-')[0] để lấy lại original.
    const momoOrderId = `${orderId}-${Date.now()}`;
    const requestId = `${Date.now()}`;
    const orderInfo = `Thanh toan don hang ${orderId}`;
    const requestType = 'captureWallet';
    const extraData = '';

    const rawSignature =
      `accessKey=${accessKey}&amount=${amount}&extraData=${extraData}&ipnUrl=${ipnUrl}` +
      `&orderId=${momoOrderId}&orderInfo=${orderInfo}&partnerCode=${partnerCode}` +
      `&redirectUrl=${redirectUrl}&requestId=${requestId}&requestType=${requestType}`;

    const signature = this.signMomoRequest(rawSignature, secretKey);

    const payload = {
      partnerCode,
      accessKey,
      requestId,
      amount: amount.toString(),
      orderId: momoOrderId,
      orderInfo,
      redirectUrl,
      ipnUrl,
      extraData,
      requestType,
      signature,
      lang: 'vi',
    };

    this.logger.log(
      `[MoMo CREATE] order=${orderId} amount=${amount} ipnUrl="${ipnUrl}" redirectUrl="${redirectUrl}"`,
    );
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
    this.logger.log(
      `[MoMo IPN] orderId=${ipn.orderId} resultCode=${ipn.resultCode} transId=${ipn.transId} amount=${ipn.amount}`,
    );
    const { partnerCode, accessKey, secretKey } = this.getMomoConfig();

    if (ipn.partnerCode !== partnerCode) {
      this.logger.warn(`IPN partnerCode mismatch: ${ipn.partnerCode}`);
      throw new BadRequestException('Invalid partnerCode');
    }

    // Fallback `?? ''` cho mọi field — MoMo đôi khi bỏ trống extraData/payType/orderType
    // và string concat sẽ ép undefined thành chữ "undefined" → sai signature.
    const rawSignature =
      `accessKey=${accessKey}&amount=${ipn.amount ?? ''}&extraData=${ipn.extraData ?? ''}&message=${ipn.message ?? ''}` +
      `&orderId=${ipn.orderId ?? ''}&orderInfo=${ipn.orderInfo ?? ''}&orderType=${ipn.orderType ?? ''}` +
      `&partnerCode=${ipn.partnerCode ?? ''}&payType=${ipn.payType ?? ''}&requestId=${ipn.requestId ?? ''}` +
      `&responseTime=${ipn.responseTime ?? ''}&resultCode=${ipn.resultCode ?? ''}&transId=${ipn.transId ?? ''}`;

    const expected = this.signMomoRequest(rawSignature, secretKey);
    if (expected !== ipn.signature) {
      this.logger.error(`MoMo IPN signature mismatch. payload=${JSON.stringify(ipn)} rawSignature=${rawSignature} expected=${expected}`);
      throw new BadRequestException('Invalid signature');
    }

    // Only process success once. MoMo orderId là `${realOrderId}-${ts}` — tách lại id gốc.
    if (ipn.resultCode === 0) {
      const realOrderId = ipn.orderId.split('-')[0];
      await this.markPaymentSucceeded(realOrderId, ipn.transId);
    }

    return { resultCode: 0, message: 'OK' };
  }

  /**
   * MoMo browser-redirect ("Return URL") handler.
   *
   * Difference vs handleMomoIpn:
   *  - IPN is a POST from MoMo's server, signed with HMAC over a fixed field list.
   *  - Return is a GET MoMo redirects the BUYER'S BROWSER to. MoMo includes the
   *    same fields as query string with a signature MoMo computes.
   *
   * Why we still update DB here (in addition to IPN):
   *  - IPN sometimes lags 1–10s. The buyer is staring at the screen — we want
   *    to flip Order.CONFIRMED before the redirect target loads so /payment/success
   *    can render the truth.
   *  - markPaymentSucceeded is idempotent (early-return if already PAID), so if
   *    IPN beats the return, this is a no-op; if return beats IPN, IPN is a no-op.
   *
   * Returns the FE URL to 302-redirect the buyer to. Caller (controller) does the redirect.
   */
  async handleMomoReturn(query: Record<string, string>): Promise<string> {
    const feBase = process.env.FRONTEND_URL || 'http://localhost:3000';
    // MoMo trả về `${realOrderId}-${ts}` ở query.orderId — giữ composite để tính
    // signature, còn DB lookup + FE redirect dùng realOrderId.
    const orderId = query.orderId;
    if (!orderId) return `${feBase}/payment/failed?reason=missing_orderId`;
    const realOrderId = orderId.split('-')[0];

    const { accessKey, secretKey, partnerCode } = this.getMomoConfig();
    if (query.partnerCode && query.partnerCode !== partnerCode) {
      this.logger.warn(`Return partnerCode mismatch: ${query.partnerCode}`);
      return `${feBase}/payment/failed?orderId=${realOrderId}&reason=partner_mismatch`;
    }

    // MoMo signs return-URL fields in the same alphabetical order as the request
    // create signature, sans signature itself.
    const rawSignature =
      `accessKey=${accessKey}&amount=${query.amount ?? ''}&extraData=${query.extraData ?? ''}` +
      `&message=${query.message ?? ''}&orderId=${orderId}&orderInfo=${query.orderInfo ?? ''}` +
      `&orderType=${query.orderType ?? ''}&partnerCode=${query.partnerCode ?? partnerCode}` +
      `&payType=${query.payType ?? ''}&requestId=${query.requestId ?? ''}` +
      `&responseTime=${query.responseTime ?? ''}&resultCode=${query.resultCode ?? ''}` +
      `&transId=${query.transId ?? ''}`;
    const expected = this.signMomoRequest(rawSignature, secretKey);

    // Signature mismatch on return is treated as soft failure — we still redirect
    // (don't 500 the buyer) but log it so we notice tampering / bad config.
    if (query.signature && expected !== query.signature) {
      this.logger.error(`MoMo return signature mismatch. query=${JSON.stringify(query)} rawSignature=${rawSignature} expected=${expected}`);
    }

    const resultCode = Number(query.resultCode ?? -1);
    if (resultCode === 0 && query.transId) {
      try {
        await this.markPaymentSucceeded(realOrderId, query.transId);
      } catch (err) {
        // If Payment row not found yet (very unusual race), let IPN handle it.
        this.logger.warn(`markPaymentSucceeded from return failed for ${realOrderId}: ${(err as Error).message}`);
      }
      return `${feBase}/payment/success?orderId=${realOrderId}&transId=${encodeURIComponent(query.transId)}&amount=${encodeURIComponent(query.amount ?? '')}`;
    }

    return `${feBase}/payment/failed?orderId=${realOrderId}&resultCode=${resultCode}&message=${encodeURIComponent(query.message ?? '')}`;
  }

  /**
   * Single source of truth for "this MoMo payment cleared":
   *  - Payment.status → PAID
   *  - Payment.transaction_ref → transId (used later by refundMomoTransaction)
   *  - Order.status → CONFIRMED
   * Atomic in one $transaction. Idempotent — early-return if already PAID.
   * Called by handleMomoIpn (real callback) AND by simulateMomoSuccess (dev tool).
   */
  private async markPaymentSucceeded(orderId: string, transId: string) {
    await this.db.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({ where: { order_id: orderId } });
      if (!payment) throw new NotFoundException('Payment not found');
      if (payment.status === PaymentStatus.PAID) return; // idempotent

      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.PAID, transaction_ref: transId },
      });
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CONFIRMED },
      });
    });
  }

  private requireDevSimulator() {
    // Hard fail in production. Even when NODE_ENV !== 'production', require
    // MOMO_DEV_SIMULATOR=true so the endpoint isn't accidentally callable
    // from a staging deploy.
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('Dev simulator bị tắt trong production.');
    }
    if (process.env.MOMO_DEV_SIMULATOR !== 'true') {
      throw new ForbiddenException(
        'Dev simulator chưa được bật. Set MOMO_DEV_SIMULATOR=true trong BE/.env.',
      );
    }
  }

  /**
   * DEV ONLY — giả lập IPN thành công không cần MoMo gọi callback thật.
   * Cùng atomic transaction với real IPN, ownership check tránh buyer khác gọi
   * lên đơn của bạn. transId được sinh giả ngắn để dễ phân biệt với MoMo thật
   * (có prefix "DEV-") nếu sau này cần audit.
   */
  async simulateMomoSuccess(buyerId: string, orderId: string) {
    this.requireDevSimulator();

    const order = await this.db.order.findUnique({
      where: { id: orderId },
      include: { payments: true },
    });
    if (!order) throw new NotFoundException('Đơn hàng không tồn tại');
    if (order.buyer_id !== buyerId) {
      throw new ForbiddenException('Bạn không sở hữu đơn hàng này');
    }
    if (order.payment_method !== PaymentMethod.MOMO) {
      throw new BadRequestException('Đơn này không thanh toán bằng MoMo');
    }

    const fakeTransId = `DEV-${Date.now()}`;
    await this.markPaymentSucceeded(orderId, fakeTransId);

    this.logger.warn(
      `[DEV-SIMULATOR] Marked order ${orderId} as PAID without real MoMo callback. transId=${fakeTransId}`,
    );

    return {
      message: 'Đã giả lập thanh toán MoMo thành công.',
      orderId,
      transId: fakeTransId,
      paymentStatus: PaymentStatus.PAID,
      orderStatus: OrderStatus.CONFIRMED,
    };
  }

  /**
   * DEV ONLY — giả lập IPN báo lỗi (resultCode != 0).
   * Đặt Payment=FAILED, KHÔNG đổi Order.status (vẫn ở PENDING để buyer retry).
   */
  async simulateMomoFailure(buyerId: string, orderId: string, reason = 'DEV: simulated failure') {
    this.requireDevSimulator();

    const order = await this.db.order.findUnique({
      where: { id: orderId },
      include: { payments: true },
    });
    if (!order) throw new NotFoundException('Đơn hàng không tồn tại');
    if (order.buyer_id !== buyerId) {
      throw new ForbiddenException('Bạn không sở hữu đơn hàng này');
    }

    await this.db.payment.updateMany({
      where: { order_id: orderId },
      data: { status: PaymentStatus.FAILED },
    });

    this.logger.warn(`[DEV-SIMULATOR] Marked payment FAILED for order ${orderId}: ${reason}`);

    return {
      message: 'Đã giả lập thanh toán MoMo thất bại.',
      orderId,
      paymentStatus: PaymentStatus.FAILED,
      orderStatus: order.status,
    };
  }

  /**
   * Trạng thái Payment + Order — dùng cho FE polling trên trang checkout sau khi
   * buyer click "Mở MoMo". Khi Payment.status === PAID, FE đóng popup và redirect.
   * KHÔNG gated bằng dev simulator — đây là path bình thường để FE biết IPN đã về.
   */
  async getMomoPaymentStatus(buyerId: string, orderId: string) {
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      include: { payments: true },
    });
    if (!order) throw new NotFoundException('Đơn hàng không tồn tại');
    if (order.buyer_id !== buyerId) {
      throw new ForbiddenException('Bạn không sở hữu đơn hàng này');
    }
    const payment = order.payments?.[0];
    return {
      orderId,
      paymentStatus: payment?.status ?? null,
      orderStatus: order.status,
      transactionRef: payment?.transaction_ref ?? null,
      amount: Number(order.final_total_price),
    };
  }

  /**
   * Calls MoMo's /v2/gateway/api/refund.
   *
   * Signed string (alphabetically sorted, NO signature field inside):
   *   accessKey=...&amount=...&description=...&orderId=...&partnerCode=...&requestId=...&transId=...
   *
   * Important:
   *  - `orderId` sent to MoMo MUST be NEW per refund attempt (MoMo dedupes).
   *    We use `<originalOrderId>-rfd-<timestamp>`.
   *  - `transId` is the ORIGINAL purchase transId persisted into Payment.transaction_ref
   *    by handleMomoIpn().
   *  - DB writes wrap in a Prisma $transaction so Payment.status and Order.status
   *    flip together (REFUNDED).
   */
  async refundMomoTransaction(orderId: string, amount: number, reason = 'Buyer not received') {
    const payment = await this.db.payment.findFirst({
      where: { order_id: orderId, payment_method: PaymentMethod.MOMO },
    });
    if (!payment) throw new NotFoundException('Không tìm thấy giao dịch MoMo cho đơn này.');
    if (payment.status === PaymentStatus.REFUNDED) {
      return { message: 'Đơn đã được hoàn tiền trước đó.', alreadyRefunded: true };
    }
    if (payment.status !== PaymentStatus.PAID && payment.status !== PaymentStatus.REFUNDING) {
      throw new BadRequestException(
        `Chỉ hoàn tiền được khi Payment ở trạng thái PAID/REFUNDING. Hiện tại: ${payment.status}`,
      );
    }
    if (!payment.transaction_ref) {
      throw new BadRequestException('Thiếu transId gốc — không thể gọi MoMo refund.');
    }

    // Demo refund: giao dịch gốc là giả lập (DEV-xxx) ⇒ skip MoMo API,
    // mark REFUNDED tại DB để demo chạy end-to-end mà không cần ngrok IPN thật.
    const isDevTransaction = payment.transaction_ref.startsWith('DEV-');
    const refundAmount = Math.floor(amount); // MoMo yêu cầu integer VND

    if (isDevTransaction) {
      this.logger.warn(
        `[DEV-SIMULATOR] Refund for order ${orderId} — transId ${payment.transaction_ref} is simulated. Skipping MoMo API, marking REFUNDED locally.`,
      );
      const fakeRefundId = `DEV-RFD-${Date.now()}`;
      await this.db.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.REFUNDED,
            transaction_ref: `${payment.transaction_ref}|refund:${fakeRefundId}`,
          },
        });
        await tx.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.REFUNDED },
        });
      });
      return {
        message: 'Hoàn tiền MoMo thành công (DEV simulator).',
        refundTransId: fakeRefundId,
        refundOrderId: `${orderId}-rfd-dev-${Date.now()}`,
        amount: refundAmount,
        simulated: true,
      };
    }

    // Giao dịch thật ⇒ gọi MoMo refund API
    const { partnerCode, accessKey, secretKey, endpoint } = this.getMomoConfig();
    const refundEndpoint =
      process.env.MOMO_REFUND_ENDPOINT || endpoint.replace('/create', '/refund');

    const refundOrderId = `${orderId}-rfd-${Date.now()}`;
    const requestId = `${Date.now()}`;
    const description = reason;

    const rawSignature =
      `accessKey=${accessKey}&amount=${refundAmount}&description=${description}` +
      `&orderId=${refundOrderId}&partnerCode=${partnerCode}` +
      `&requestId=${requestId}&transId=${payment.transaction_ref}`;
    const signature = this.signMomoRequest(rawSignature, secretKey);

    const payload = {
      partnerCode,
      orderId: refundOrderId,
      requestId,
      amount: refundAmount,
      transId: Number(payment.transaction_ref),
      lang: 'vi',
      description,
      signature,
    };

    const { data } = await axios.post(refundEndpoint, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    // MoMo: resultCode === 0 → refund accepted.
    // Anything else: leave Payment at REFUNDING so admin can retry; do NOT mark REFUNDED.
    if (data?.resultCode !== 0) {
      this.logger.error(`MoMo refund fail (order ${orderId}): ${JSON.stringify(data)}`);
      throw new BadRequestException(data?.message || 'MoMo từ chối yêu cầu hoàn tiền.');
    }

    await this.db.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.REFUNDED,
          transaction_ref: `${payment.transaction_ref}|refund:${data.transId ?? refundOrderId}`,
        },
      });
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.REFUNDED },
      });
    });

    return {
      message: 'Hoàn tiền MoMo thành công.',
      refundTransId: data.transId,
      refundOrderId,
      amount: refundAmount,
    };
  }
}
