import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
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

  // MoMo gọi IPN (notify)
  @Post('momo/ipn')
  async momoIpn(@Body() body: any) {
    return this.paymentsService.handleMomoIpn(body);
  }
}
