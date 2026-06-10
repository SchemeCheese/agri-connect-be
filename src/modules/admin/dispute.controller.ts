import { Body, Controller, Get, Param, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/decorators/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { DisputeService } from './dispute.service';
import { CreateDisputeDto, SellerRespondDto } from './dtos/admin.dtos';

// Hành động khiếu nại của Buyer/Seller (khác /admin/* dành cho Admin phân xử).
@ApiTags('Disputes')
@ApiBearerAuth('access-token')
@Controller('disputes')
@UseGuards(JwtAuthGuard)
export class DisputeController {
  constructor(private readonly disputes: DisputeService) {}

  // BUYER mở khiếu nại cho 1 đơn của mình
  @ApiOperation({ summary: 'Mở khiếu nại (BUYER)', description: 'Tạo Dispute (OPEN) + ảnh bằng chứng cho đơn của mình. KHÔNG tự hoàn tiền.' })
  @UseGuards(RolesGuard)
  @Roles(UserRole.BUYER)
  @Post('order/:orderId')
  create(@Request() req, @Param('orderId') orderId: string, @Body() dto: CreateDisputeDto) {
    return this.disputes.createByBuyer(req.user.sub, orderId, dto);
  }

  // SELLER gửi bằng chứng giải trình
  @ApiOperation({ summary: 'Gửi bằng chứng (SELLER)', description: 'Seller giải trình + ảnh → dispute UNDER_ADMIN_REVIEW. Chỉ dispute của shop mình.' })
  @UseGuards(RolesGuard)
  @Roles(UserRole.SELLER)
  @Patch(':id/respond')
  respond(@Request() req, @Param('id') id: string, @Body() dto: SellerRespondDto) {
    return this.disputes.respondBySeller(req.user.sub, id, dto);
  }

  // BUYER/SELLER xem các khiếu nại liên quan tới mình
  @Get('mine')
  mine(@Request() req) {
    return this.disputes.listMine(req.user.sub);
  }
}
