import { Injectable, BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { PaymentStatus, PaymentMethod, PaymentType, OrderStatus, CheckoutSessionStatus, Prisma } from '@prisma/client';
import axios from 'axios';
import * as crypto from 'crypto';

// Accepts either the long-lived DatabaseService or a Prisma TransactionClient
// so callers inside a $transaction can route writes through PaymentsService
// without breaking atomicity.
type PaymentTx = Prisma.TransactionClient | DatabaseService;

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
  private readonly momoRequestTimeoutMs = Number(process.env.MOMO_HTTP_TIMEOUT_MS ?? 15000);

  constructor(private readonly db: DatabaseService) {}

  // ─── Domain helpers: payment row writes ─────────────────────────────────
  // OrdersService used to do prisma.payment.create()/updateMany() inline. These
  // helpers move that ownership into PaymentsService while accepting the caller's
  // Prisma transaction client so atomicity is preserved.

  /** Initial UNPAID payment row created during checkout. */
  createInitialPayment(
    tx: PaymentTx,
    args: { orderId: string; payerId: string; amount: number; method: PaymentMethod },
  ) {
    return tx.payment.create({
      data: {
        order_id: args.orderId,
        payer_id: args.payerId,
        amount: args.amount,
        payment_method: args.method,
        status: PaymentStatus.UNPAID,
      },
    });
  }

  /** Flip every payment row of an order to PAID. Used by completeOrder. */
  markPaid(tx: PaymentTx, orderId: string) {
    return tx.payment.updateMany({
      where: { order_id: orderId },
      data: { status: PaymentStatus.PAID },
    });
  }

  /** Mark COD/refund-impossible flows as FAILED. */
  markFailed(tx: PaymentTx, orderId: string) {
    return tx.payment.updateMany({
      where: { order_id: orderId },
      data: { status: PaymentStatus.FAILED },
    });
  }

  /** Mark refund pipeline as REFUNDING (intermediate before refundMomoTransaction). */
  markRefunding(tx: PaymentTx, orderId: string) {
    return tx.payment.updateMany({
      where: { order_id: orderId },
      data: { status: PaymentStatus.REFUNDING },
    });
  }

  /** Force REFUNDED — used as a safety mirror after a successful MoMo refund. */
  markRefunded(tx: PaymentTx, orderId: string) {
    return tx.payment.updateMany({
      where: { order_id: orderId },
      data: { status: PaymentStatus.REFUNDED },
    });
  }

  /** Sync payment.payment_method when buyer changes order method (UNPAID only). */
  changeMethod(tx: PaymentTx, orderId: string, method: PaymentMethod) {
    return tx.payment.updateMany({
      where: { order_id: orderId },
      data: { payment_method: method },
    });
  }

  /** Cron sweep: mark stale UNPAID rows for a batch of orders as FAILED. */
  batchFailUnpaid(tx: PaymentTx, orderIds: string[]) {
    return tx.payment.updateMany({
      where: { order_id: { in: orderIds }, status: PaymentStatus.UNPAID },
      data: { status: PaymentStatus.FAILED },
    });
  }

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

  /**
   * Resolve an incoming id to a CheckoutSession. Accepts either a session id
   * directly (new flow) or a legacy order id whose Order is linked to a session
   * (so callers still sending order_id keep working). Throws if neither resolves.
   */
  private async resolveCheckoutSession(id: string) {
    let session = await this.db.checkoutSession.findUnique({
      where: { id },
      include: { orders: { include: { payments: true } } },
    });
    if (!session) {
      const order = await this.db.order.findUnique({
        where: { id },
        select: { checkout_session_id: true },
      });
      if (order?.checkout_session_id) {
        session = await this.db.checkoutSession.findUnique({
          where: { id: order.checkout_session_id },
          include: { orders: { include: { payments: true } } },
        });
      }
    }
    return session;
  }

  async createMomoPayment(buyerId: string, checkoutSessionId: string) {
    const session = await this.resolveCheckoutSession(checkoutSessionId);
    if (!session) throw new NotFoundException('Phiên thanh toán không tồn tại');
    if (session.buyer_id !== buyerId) throw new ForbiddenException('Bạn không sở hữu phiên thanh toán này');
    if (session.orders.length === 0) throw new BadRequestException('Phiên thanh toán không có đơn hàng');
    if (session.orders.some((o) => o.payment_method !== PaymentMethod.MOMO)) {
      throw new BadRequestException('Phiên này có đơn không chọn phương thức MoMo');
    }
    if (session.status === CheckoutSessionStatus.PAID) {
      return { message: 'Phiên đã thanh toán MoMo', payUrl: null };
    }

    // Tổng tiền cả nhóm (nhiều shop) → 1 giao dịch MoMo duy nhất.
    const amount = Math.round(Number(session.total_amount));
    const { partnerCode, accessKey, secretKey, endpoint, redirectUrl, ipnUrl } = this.getMomoConfig();

    // Gửi session.id làm MoMo orderId — IPN/return trả về chính id này để resolve
    // cả nhóm. MoMo dedupe theo orderId; case đã PAID đã early-return ở trên, còn
    // case UNPAID lâu sẽ do cron cancelStaleUnpaidMomoOrders (24h) dọn dẹp.
    const momoOrderId = session.id;
    const requestId = `${Date.now()}`;
    const orderInfo = `Thanh toan ${session.orders.length} don hang`;
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
      `[MoMo CREATE] session=${momoOrderId} orders=${session.orders.length} amount=${amount} ipnUrl="${ipnUrl}" timeoutMs=${this.momoRequestTimeoutMs}`,
    );

    let data: any;
    try {
      const response = await axios.post(endpoint, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: this.momoRequestTimeoutMs,
        timeoutErrorMessage: 'MoMo request timed out',
      });
      data = response.data;
    } catch (error: any) {
      const status = error?.response?.status;
      const responseData = error?.response?.data;
      const message = responseData?.message || error?.message || 'Không kết nối được tới MoMo';

      this.logger.error(
        `[MoMo CREATE] request failed session=${momoOrderId} status=${status ?? 'n/a'} message=${message}`,
        error?.stack,
      );

      if (error?.code === 'ECONNABORTED' || String(message).toLowerCase().includes('timed out')) {
        throw new ServiceUnavailableException('MoMo tạm thời không phản hồi, vui lòng thử lại sau.');
      }

      if (status && status >= 400 && status < 500) {
        throw new BadRequestException(message);
      }

      throw new ServiceUnavailableException('Không tạo được giao dịch MoMo, vui lòng thử lại sau.');
    }

    if (data?.resultCode !== 0) {
      this.logger.error(`MoMo create fail: ${JSON.stringify(data)}`);
      throw new BadRequestException(data?.message || 'Không tạo được giao dịch MoMo');
    }

    // Lưu transaction_ref (payUrl/deeplink) lên mọi payment trong nhóm để tiện tracking
    const orderIds = session.orders.map((o) => o.id);
    await this.db.payment.updateMany({
      where: { order_id: { in: orderIds } },
      data: { transaction_ref: data.payUrl ?? data.deeplink ?? requestId },
    });

    return {
      checkoutSessionId: session.id,
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
      // SecOps trace: chỉ log orderId/transId (không dump toàn payload/signature nhạy cảm).
      this.logger.error(
        `[MoMo IPN] SIGNATURE MISMATCH — orderId=${ipn.orderId} transId=${ipn.transId} resultCode=${ipn.resultCode}. Webhook bị từ chối.`,
      );
      throw new BadRequestException('Invalid signature');
    }
    this.logger.log(`[MoMo IPN] signature OK — orderId=${ipn.orderId} transId=${ipn.transId}`);

    // ipn.orderId IS the CheckoutSession id (or legacy order id).
    // Early idempotency check: if already PAID, return immediately (prevent duplicate processing).
    if (ipn.resultCode === 0) {
      const session = await this.db.checkoutSession.findUnique({
        where: { id: ipn.orderId },
        select: { status: true },
      });

      // CheckoutSession found and already PAID → idempotent return
      if (session && session.status === CheckoutSessionStatus.PAID) {
        this.logger.log(
          `[MoMo IPN] IDEMPOTENT: CheckoutSession ${ipn.orderId} already PAID. Skipping duplicate processing.`,
        );
        return { resultCode: 0, message: 'OK' };
      }

      await this.markMomoPaid(ipn.orderId, String(ipn.transId));
      this.logger.log(
        `[MoMo IPN] ✅ Đã xác thực & ghi nhận THANH TOÁN — orderId=${ipn.orderId} transId=${ipn.transId} amount=${ipn.amount}`,
      );
    } else {
      this.logger.warn(
        `[MoMo IPN] resultCode=${ipn.resultCode} (KHÔNG thành công) — orderId=${ipn.orderId} transId=${ipn.transId}. Không đổi trạng thái.`,
      );
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
    // Cảnh báo cấu hình: thiếu FRONTEND_URL trên Railway → redirect buyer về
    // localhost:3000 (không tồn tại với trình duyệt user) → "thành công nhưng
    // trang trắng". Log để phát hiện ngay trên Railway logs.
    if (!process.env.FRONTEND_URL) {
      this.logger.warn(
        '[MoMo RETURN] FRONTEND_URL chưa set — đang fallback http://localhost:3000. ' +
          'Set FRONTEND_URL=<domain FE> trên Railway để redirect sau thanh toán hoạt động.',
      );
    }
    // query.orderId IS the real DB orderId (no composite suffix anymore).
    const orderId = query.orderId;
    this.logger.log(
      `[MoMo RETURN] orderId=${query.orderId ?? 'n/a'} resultCode=${query.resultCode ?? 'n/a'} transId=${query.transId ?? 'n/a'} feBase=${feBase}`,
    );
    if (!orderId) return `${feBase}/payment/failed?reason=missing_orderId`;

    const { accessKey, secretKey, partnerCode } = this.getMomoConfig();
    if (query.partnerCode && query.partnerCode !== partnerCode) {
      this.logger.warn(`Return partnerCode mismatch: ${query.partnerCode}`);
      return `${feBase}/payment/failed?orderId=${orderId}&reason=partner_mismatch`;
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
        await this.markMomoPaid(orderId, String(query.transId));
      } catch (err) {
        // If session/payment not found yet (very unusual race), let IPN handle it.
        this.logger.warn(`markMomoPaid from return failed for ${orderId}: ${(err as Error).message}`);
      }
      return `${feBase}/payment/success?orderId=${orderId}&transId=${encodeURIComponent(query.transId)}&amount=${encodeURIComponent(query.amount ?? '')}`;
    }

    return `${feBase}/payment/failed?orderId=${orderId}&resultCode=${resultCode}&message=${encodeURIComponent(query.message ?? '')}`;
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
        data: {
          status: PaymentStatus.PAID,
          transaction_ref: transId,
          momo_trans_id: String(transId),
        },
      });
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CONFIRMED },
      });
    });
  }

  /**
   * Dispatcher cho MoMo "payment cleared": id có thể là CheckoutSession id (flow
   * mới, nhóm nhiều đơn) hoặc order id (legacy đơn lẻ). Resolve session trước;
   * nếu không phải session thì fallback markPaymentSucceeded theo order id.
   */
  private async markMomoPaid(id: string, transId: string) {
    const session = await this.db.checkoutSession.findUnique({ where: { id } });
    if (session) {
      await this.markSessionPaid(id, transId);
    } else {
      await this.markPaymentSucceeded(id, transId);
    }
  }

  /**
   * Một CheckoutSession đã thanh toán: mark TẤT CẢ Payment trong nhóm = PAID,
   * TẤT CẢ Order = CONFIRMED, và CheckoutSession = PAID — atomic trong 1
   * $transaction (all-or-none). Idempotent: early-return nếu session đã PAID.
   *
   * Multi-shop constraint: Khi buyer checkout nhiều shop, tất cả order và payment
   * trong session sẽ được cập nhật cùng lúc (atomic). Không ai có thể partial-confirm.
   */
  private async markSessionPaid(sessionId: string, transId: string) {
    await this.db.$transaction(async (tx) => {
      // Fetch session + all its orders to get the full scope of updates
      const session = await tx.checkoutSession.findUnique({
        where: { id: sessionId },
        include: { orders: { select: { id: true } } },
      });
      if (!session) throw new NotFoundException('Phiên thanh toán không tồn tại');

      // Idempotency: nếu session đã PAID, return ngay (tránh duplicate webhook processing)
      if (session.status === CheckoutSessionStatus.PAID) {
        this.logger.log(`[markSessionPaid] IDEMPOTENT: session=${sessionId} already PAID, skipping.`);
        return;
      }

      const orderIds = session.orders.map((o) => o.id);
      const orderCount = orderIds.length;

      // 1. Update ALL Payments in this session → PAID with MoMo transaction_id
      //    (matches "updateMany Payments where order.checkout_session_id matches")
      const paymentResult = await tx.payment.updateMany({
        where: { order_id: { in: orderIds } },
        data: {
          status: PaymentStatus.PAID,
          transaction_ref: transId,
          momo_trans_id: String(transId),
        },
      });
      this.logger.log(`[markSessionPaid] Updated ${paymentResult.count} payments to PAID`);

      // 2. Update ALL Orders in this session → CONFIRMED
      const orderResult = await tx.order.updateMany({
        where: { id: { in: orderIds } },
        data: { status: OrderStatus.CONFIRMED },
      });
      this.logger.log(`[markSessionPaid] Updated ${orderResult.count} orders to CONFIRMED`);

      // 3. Update CheckoutSession → PAID (marks entire multi-shop transaction complete)
      await tx.checkoutSession.update({
        where: { id: sessionId },
        data: { status: CheckoutSessionStatus.PAID, momo_trans_id: String(transId) },
      });
      this.logger.log(
        `[markSessionPaid] ✅ SUCCESS: sessionId=${sessionId} orders=${orderCount} amount=${session.total_amount} transId=${transId}`,
      );
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
  async simulateMomoSuccess(buyerId: string, id: string) {
    this.requireDevSimulator();

    // id có thể là CheckoutSession id (flow mới) hoặc order id (legacy).
    const session = await this.db.checkoutSession.findUnique({
      where: { id },
      include: { orders: { select: { payment_method: true } } },
    });

    const fakeTransId = `DEV-${Date.now()}`;

    if (session) {
      if (session.buyer_id !== buyerId) {
        throw new ForbiddenException('Bạn không sở hữu phiên thanh toán này');
      }
      if (session.orders.some((o) => o.payment_method !== PaymentMethod.MOMO)) {
        throw new BadRequestException('Phiên này có đơn không thanh toán bằng MoMo');
      }
      await this.markSessionPaid(id, fakeTransId);
      this.logger.warn(
        `[DEV-SIMULATOR] Marked session ${id} (${session.orders.length} orders) as PAID. transId=${fakeTransId}`,
      );
      return {
        message: 'Đã giả lập thanh toán MoMo thành công.',
        checkoutSessionId: id,
        transId: fakeTransId,
        paymentStatus: PaymentStatus.PAID,
        orderStatus: OrderStatus.CONFIRMED,
      };
    }

    const order = await this.db.order.findUnique({
      where: { id },
      include: { payments: true },
    });
    if (!order) throw new NotFoundException('Đơn hàng không tồn tại');
    if (order.buyer_id !== buyerId) {
      throw new ForbiddenException('Bạn không sở hữu đơn hàng này');
    }
    if (order.payment_method !== PaymentMethod.MOMO) {
      throw new BadRequestException('Đơn này không thanh toán bằng MoMo');
    }

    await this.markPaymentSucceeded(id, fakeTransId);
    this.logger.warn(
      `[DEV-SIMULATOR] Marked order ${id} as PAID without real MoMo callback. transId=${fakeTransId}`,
    );
    return {
      message: 'Đã giả lập thanh toán MoMo thành công.',
      orderId: id,
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
   * Lightweight, PUBLIC payment-status lookup cho FE polling trên trang
   * /payment/success sau khi MoMo redirect buyer về. Không gated JWT để trang
   * success hoạt động kể cả khi token chưa kịp load; chỉ trả về `status` (không
   * lộ amount/payer). Trả { status: null } nếu chưa có Payment row (race hiếm).
   */
  async getPaymentStatus(id: string): Promise<{ status: string | null }> {
    // id có thể là CheckoutSession id (flow mới) — FE chỉ so sánh 'PAID'/'FAILED',
    // PENDING coi như tiếp tục poll.
    const session = await this.db.checkoutSession.findUnique({
      where: { id },
      select: { status: true },
    });
    if (session) return { status: session.status };

    const payment = await this.db.payment.findFirst({
      where: { order_id: id },
      select: { status: true },
      orderBy: { created_at: 'desc' },
    });
    return { status: payment?.status ?? null };
  }

  /**
   * Trạng thái Payment + Order — dùng cho FE polling trên trang checkout sau khi
   * buyer click "Mở MoMo". Khi Payment.status === PAID, FE đóng popup và redirect.
   * KHÔNG gated bằng dev simulator — đây là path bình thường để FE biết IPN đã về.
   */
  async getMomoPaymentStatus(buyerId: string, id: string) {
    // id có thể là CheckoutSession id (flow mới) hoặc order id (legacy).
    const session = await this.db.checkoutSession.findUnique({
      where: { id },
      include: { orders: { select: { status: true } } },
    });
    if (session) {
      if (session.buyer_id !== buyerId) {
        throw new ForbiddenException('Bạn không sở hữu phiên thanh toán này');
      }
      return {
        orderId: id,
        // session.status: PENDING/PAID/FAILED — FE chỉ check PAID/FAILED.
        paymentStatus: session.status,
        orderStatus: session.orders[0]?.status ?? null,
        transactionRef: session.momo_trans_id ?? null,
        amount: Number(session.total_amount),
      };
    }

    const order = await this.db.order.findUnique({
      where: { id },
      include: { payments: true },
    });
    if (!order) throw new NotFoundException('Đơn hàng không tồn tại');
    if (order.buyer_id !== buyerId) {
      throw new ForbiddenException('Bạn không sở hữu đơn hàng này');
    }
    const payment = order.payments?.[0];
    return {
      orderId: id,
      paymentStatus: payment?.status ?? null,
      orderStatus: order.status,
      transactionRef: payment?.transaction_ref ?? null,
      amount: Number(order.final_total_price),
    };
  }

  /**
   * Low-level MoMo /refund HTTP call. Centralises signature, timeout (15s) và
   * error handling cho cả refundMomoTransaction (legacy, per-order) lẫn
   * refundPayment (session). Throws BadRequestException nếu MoMo từ chối hoặc
   * network lỗi — caller KHÔNG được mark DB REFUNDED khi hàm này throw.
   *
   * Signed string (alphabetically sorted, NO signature field inside):
   *   accessKey=...&amount=...&description=...&orderId=...&partnerCode=...&requestId=...&transId=...
   * `orderId` phải UNIQUE mỗi lần (MoMo dedupe); `transId` là transId mua gốc.
   */
  private async momoRefundRequest(args: {
    originalTransId: string;
    refundOrderId: string;
    requestId: string;
    amount: number;
    description: string;
  }): Promise<any> {
    const { partnerCode, accessKey, secretKey, endpoint } = this.getMomoConfig();
    const refundEndpoint =
      process.env.MOMO_REFUND_ENDPOINT || endpoint.replace('/create', '/refund');

    const rawSignature =
      `accessKey=${accessKey}&amount=${args.amount}&description=${args.description}` +
      `&orderId=${args.refundOrderId}&partnerCode=${partnerCode}` +
      `&requestId=${args.requestId}&transId=${args.originalTransId}`;
    const signature = this.signMomoRequest(rawSignature, secretKey);

    const payload = {
      partnerCode,
      orderId: args.refundOrderId,
      requestId: args.requestId,
      amount: args.amount,
      transId: Number(args.originalTransId),
      lang: 'vi',
      description: args.description,
      signature,
    };

    try {
      const { data } = await axios.post(refundEndpoint, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      // MoMo: resultCode === 0 → refund accepted. Khác → để caller giữ REFUNDING, retry sau.
      if (data?.resultCode !== 0) {
        this.logger.error(`MoMo refund rejected (refundOrderId=${args.refundOrderId}): ${JSON.stringify(data)}`);
        throw new BadRequestException(data?.message || 'MoMo từ chối yêu cầu hoàn tiền.');
      }
      return data;
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      // Timeout / network / 5xx — log nguyên payload lỗi của MoMo nếu có.
      this.logger.error(
        `MoMo refund API error (refundOrderId=${args.refundOrderId}): ${JSON.stringify(err?.response?.data ?? err?.message ?? err)}`,
      );
      throw new BadRequestException(
        err?.response?.data?.message || 'Gọi MoMo refund API thất bại (timeout/network).',
      );
    }
  }

  /**
   * Calls MoMo's /v2/gateway/api/refund (LEGACY, per-order).
   *  - `orderId` sent to MoMo MUST be NEW per refund attempt (MoMo dedupes).
   *  - `transId` is the ORIGINAL purchase transId in Payment.transaction_ref.
   *  - DB writes wrap in a Prisma $transaction (Payment + Order flip to REFUNDED).
   * Vẫn giữ cho đơn cũ không thuộc CheckoutSession; đơn mới đi qua refundPayment().
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

    // Giao dịch thật ⇒ gọi MoMo refund API qua helper (sign + timeout + try/catch).
    // requestId + refundOrderId unique mỗi lần để MoMo không dedupe.
    const refundOrderId = `${orderId}-rfd-${Date.now()}`;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = await this.momoRefundRequest({
      originalTransId: payment.transaction_ref,
      refundOrderId,
      requestId,
      amount: refundAmount,
      description: reason,
    });

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

    this.logger.log(
      `[MoMo Refund] ✅ Hoàn tiền thành công — orderId=${orderId} origTransId=${payment.transaction_ref} ` +
        `refundTransId=${data.transId ?? refundOrderId} amount=${refundAmount}`,
    );
    return {
      message: 'Hoàn tiền MoMo thành công.',
      refundTransId: data.transId,
      refundOrderId,
      amount: refundAmount,
    };
  }

  /**
   * Hoàn tiền MoMo theo CheckoutSession (kiến trúc nhóm nhiều shop).
   *
   *  - Resolve session + verify momo_trans_id (transId mua gốc đã lưu khi PAID).
   *  - opts.orderId  → hoàn TỪNG PHẦN (1 shop trong nhóm). MoMo hỗ trợ partial
   *                    refund theo amount; ta gửi đúng số tiền của (các) đơn đó.
   *    không có orderId → hoàn TOÀN BỘ session.
   *  - Gọi MoMo refund qua momoRefundRequest (unique requestId + refundOrderId
   *    dạng REFUND_<sessionId>_<ts>). Nếu MoMo fail → throw, KHÔNG mark DB.
   *  - Thành công: trong 1 $transaction → Order(target)=REFUNDED, Payment gốc
   *    (PAYMENT)=REFUNDED, tạo Payment log type=REFUND cho từng đơn, và cập nhật
   *    CheckoutSession = REFUNDED (toàn bộ) | PARTIALLY_REFUNDED (một phần).
   */
  async refundPayment(
    checkoutSessionId: string,
    amount: number,
    opts: { orderId?: string; reason?: string } = {},
  ) {
    const reason = opts.reason ?? 'Hoàn tiền đơn hàng';
    const session = await this.db.checkoutSession.findUnique({
      where: { id: checkoutSessionId },
      include: { orders: true },
    });
    if (!session) throw new NotFoundException('Phiên thanh toán không tồn tại');
    if (!session.momo_trans_id) {
      throw new BadRequestException('Phiên chưa có momo_trans_id — không thể hoàn tiền MoMo.');
    }

    // Đơn cần hoàn: 1 đơn (partial) hoặc cả nhóm (full).
    const targetOrders = opts.orderId
      ? session.orders.filter((o) => o.id === opts.orderId)
      : session.orders;
    if (targetOrders.length === 0) {
      throw new NotFoundException('Không tìm thấy đơn cần hoàn trong phiên này.');
    }

    // Idempotency: nếu tất cả đơn target đã REFUNDED → no-op an toàn.
    if (targetOrders.every((o) => o.status === OrderStatus.REFUNDED)) {
      return { message: 'Các đơn này đã được hoàn tiền trước đó.', alreadyRefunded: true };
    }

    const refundAmount = Math.floor(amount); // MoMo yêu cầu integer VND
    if (refundAmount <= 0) throw new BadRequestException('Số tiền hoàn phải lớn hơn 0.');

    const originalTransId = session.momo_trans_id;
    const isDevTransaction = originalTransId.startsWith('DEV-');
    const targetOrderIds = targetOrders.map((o) => o.id);
    const isFullSession = targetOrders.length === session.orders.length;

    // requestId + refundOrderId unique mỗi lần (MoMo dedupe theo orderId).
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const refundOrderId = `REFUND_${checkoutSessionId}_${Date.now()}`;

    let refundTransId: string;
    if (isDevTransaction) {
      refundTransId = `DEV-RFD-${Date.now()}`;
      this.logger.warn(
        `[DEV-SIMULATOR] Refund session=${checkoutSessionId} orders=${targetOrderIds.length} amount=${refundAmount} — transId giả lập, skip MoMo API.`,
      );
    } else {
      this.logger.log(
        `[MoMo REFUND] session=${checkoutSessionId} orders=${targetOrderIds.length} amount=${refundAmount} transId=${originalTransId}`,
      );
      const data = await this.momoRefundRequest({
        originalTransId,
        refundOrderId,
        requestId,
        amount: refundAmount,
        description: reason,
      });
      refundTransId = String(data.transId ?? refundOrderId);
    }

    // MoMo đã chấp nhận (hoặc DEV) → ghi DB atomic.
    await this.db.$transaction(async (tx) => {
      // 1) Đơn target + payment gốc (PAYMENT) → REFUNDED
      await tx.order.updateMany({
        where: { id: { in: targetOrderIds } },
        data: { status: OrderStatus.REFUNDED },
      });
      await tx.payment.updateMany({
        where: { order_id: { in: targetOrderIds }, payment_type: PaymentType.PAYMENT },
        data: { status: PaymentStatus.REFUNDED },
      });

      // 2) Log REFUND record cho từng đơn (đối soát theo số tiền thực của đơn)
      for (const o of targetOrders) {
        await tx.payment.create({
          data: {
            order_id: o.id,
            payer_id: session.buyer_id,
            amount: Number(o.final_total_price),
            payment_method: PaymentMethod.MOMO,
            status: PaymentStatus.REFUNDED,
            payment_type: PaymentType.REFUND,
            transaction_ref: refundTransId,
            momo_trans_id: originalTransId,
          },
        });
      }

      // 3) Cập nhật trạng thái session: toàn bộ hoàn → REFUNDED, một phần → PARTIALLY_REFUNDED
      const remaining = await tx.order.findMany({
        where: { checkout_session_id: checkoutSessionId },
        select: { status: true },
      });
      const allRefunded = remaining.every((o) => o.status === OrderStatus.REFUNDED);
      await tx.checkoutSession.update({
        where: { id: checkoutSessionId },
        data: {
          status: allRefunded
            ? CheckoutSessionStatus.REFUNDED
            : CheckoutSessionStatus.PARTIALLY_REFUNDED,
        },
      });
    });

    return {
      message: isDevTransaction
        ? 'Hoàn tiền MoMo thành công (DEV simulator).'
        : 'Hoàn tiền MoMo thành công.',
      checkoutSessionId,
      refundTransId,
      refundOrderId,
      amount: refundAmount,
      partial: !isFullSession,
      simulated: isDevTransaction,
    };
  }
}
