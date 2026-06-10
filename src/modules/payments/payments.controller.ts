import { BadRequestException, Body, Controller, Get, Param, Post, Query, Redirect, Request, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { MomoCreateDto } from './dtos/momo-create.dto';
import { AuthGuard } from '@nestjs/passport';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  // Buyer tạo yêu cầu thanh toán MoMo cho đơn đã checkout với payment_method = MOMO
  @ApiOperation({ summary: 'Tạo thanh toán MoMo', description: 'Trả payUrl/deeplink MoMo cho đơn/CheckoutSession.' })
  @ApiBearerAuth('access-token')
  @UseGuards(AuthGuard('jwt'))
  @Post('momo/create')
  async createMomo(@Request() req, @Body() dto: MomoCreateDto) {
    const id = dto.checkout_session_id ?? dto.order_id;
    if (!id) {
      throw new BadRequestException('Thiếu checkout_session_id (hoặc order_id).');
    }
    return this.paymentsService.createMomoPayment(req.user.sub, id);
  }

  // MoMo gọi IPN (notify) — server-to-server POST. Miễn rate-limit (webhook ngoài,
  // idempotent theo momo_trans_id) để không bị 429 chặn callback thanh toán.
  @ApiOperation({ summary: 'MoMo IPN webhook (server-to-server)', description: 'MoMo gọi xác nhận thanh toán. Verify signature + idempotent theo transId. KHÔNG dùng cho client.' })
  @SkipThrottle()
  @Post('momo/ipn')
  async momoIpn(@Body() body: any) {
    return this.paymentsService.handleMomoIpn(body);
  }

  // FE polling trên trang /payment/success — PUBLIC (không JWT), chỉ trả { status }.
  // Không lộ thông tin nhạy cảm; dùng để biết IPN của MoMo đã về hay chưa.
  // FE poll liên tục khi chờ IPN → miễn rate-limit (read-only, không nhạy cảm).
  @SkipThrottle()
  @Get('status/:orderId')
  async paymentStatus(@Param('orderId') orderId: string) {
    return this.paymentsService.getPaymentStatus(orderId);
  }

  // MoMo redirect browser của buyer về đây sau khi thanh toán (GET).
  // Service xác nhận signature, idempotent-update DB, trả URL FE để redirect tiếp.
  // @Redirect() đọc { url } trả về và phát 302 cho trình duyệt.
  @Get('momo/return')
  @Redirect()
  async momoReturn(@Query() query: Record<string, string>) {
    const url = await this.paymentsService.handleMomoReturn(query);
    return { url };
  }

  // FE polling trạng thái thanh toán — chạy ngay sau khi mở popup MoMo,
  // tự đóng popup khi paymentStatus = PAID. Không cần gated dev — buyer-only.
  @UseGuards(AuthGuard('jwt'))
  @Get('momo/status/:orderId')
  async momoStatus(@Request() req, @Param('orderId') orderId: string) {
    return this.paymentsService.getMomoPaymentStatus(req.user.sub, orderId);
  }

  // ─── DEV SIMULATOR (gated bằng MOMO_DEV_SIMULATOR=true) ──────────────────
  // Cho phép demo end-to-end không cần MoMo gọi IPN thật — hữu ích khi ngrok
  // chậm / MoMo sandbox down / demo offline.
  @UseGuards(AuthGuard('jwt'))
  @Post('momo/simulate-success/:orderId')
  async simulateSuccess(@Request() req, @Param('orderId') orderId: string) {
    return this.paymentsService.simulateMomoSuccess(req.user.sub, orderId);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('momo/simulate-failure/:orderId')
  async simulateFailure(
    @Request() req,
    @Param('orderId') orderId: string,
    @Body() body: { reason?: string },
  ) {
    return this.paymentsService.simulateMomoFailure(req.user.sub, orderId, body?.reason);
  }
}
