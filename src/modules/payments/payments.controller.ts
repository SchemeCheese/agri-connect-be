import { Body, Controller, Get, Param, Post, Query, Request, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { PaymentsService } from './payments.service';
import { MomoCreateDto } from './dtos/momo-create.dto';
import { AuthGuard } from '@nestjs/passport';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  // Buyer tạo yêu cầu thanh toán MoMo cho đơn đã checkout với payment_method = MOMO
  @UseGuards(AuthGuard('jwt'))
  @Post('momo/create')
  async createMomo(@Request() req, @Body() dto: MomoCreateDto) {
    return this.paymentsService.createMomoPayment(req.user.sub, dto.order_id);
  }

  // MoMo gọi IPN (notify) — server-to-server POST
  @Post('momo/ipn')
  async momoIpn(@Body() body: any) {
    return this.paymentsService.handleMomoIpn(body);
  }

  // MoMo redirect browser của buyer về đây sau khi thanh toán (GET).
  // Service xác nhận signature, idempotent-update DB, trả URL FE để redirect tiếp.
  @Get('momo/return')
  async momoReturn(@Query() query: Record<string, string>, @Res() res: Response) {
    const target = await this.paymentsService.handleMomoReturn(query);
    return res.redirect(302, target);
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
