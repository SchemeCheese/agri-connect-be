import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import { CreateVoucherDto } from './dtos/create-voucher.dto';
import { ValidateVoucherDto } from './dtos/validate-voucher.dto';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/decorators/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@Controller('vouchers')
@UseGuards(JwtAuthGuard)
export class VouchersController {
  constructor(private readonly vouchersService: VouchersService) {}

  // ─── SELLER ──────────────────────────────────────────────────────────────

  /** POST /vouchers — Tạo voucher */
  @UseGuards(RolesGuard)
  @Roles(UserRole.SELLER)
  @Post()
  async create(@Request() req, @Body() dto: CreateVoucherDto) {
    return this.vouchersService.createVoucher(req.user.sub, dto);
  }

  /** GET /vouchers/mine — Xem danh sách voucher của mình */
  @UseGuards(RolesGuard)
  @Roles(UserRole.SELLER)
  @Get('mine')
  async getMyVouchers(@Request() req) {
    return this.vouchersService.getMyVouchers(req.user.sub);
  }

  /** PATCH /vouchers/:id — Sửa voucher */
  @UseGuards(RolesGuard)
  @Roles(UserRole.SELLER)
  @Patch(':id')
  async update(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: Partial<CreateVoucherDto>,
  ) {
    return this.vouchersService.updateVoucher(req.user.sub, id, dto);
  }

  /** DELETE /vouchers/:id — Xóa voucher */
  @UseGuards(RolesGuard)
  @Roles(UserRole.SELLER)
  @Delete(':id')
  async remove(@Request() req, @Param('id') id: string) {
    return this.vouchersService.deleteVoucher(req.user.sub, id);
  }

  // ─── BUYER ───────────────────────────────────────────────────────────────

  /** GET /vouchers/shop/:shopId — Xem voucher của 1 shop (public) */
  @Get('shop/:shopId')
  async getShopVouchers(@Param('shopId') shopId: string) {
    return this.vouchersService.getShopVouchers(shopId);
  }

  /** POST /vouchers/save/:id — Lưu voucher vào ví */
  @UseGuards(RolesGuard)
  @Roles(UserRole.BUYER)
  @Post('save/:id')
  async saveVoucher(@Request() req, @Param('id') id: string) {
    return this.vouchersService.saveVoucher(req.user.sub, id);
  }

  /** GET /vouchers/saved — Ví voucher của buyer */
  @UseGuards(RolesGuard)
  @Roles(UserRole.BUYER)
  @Get('saved')
  async getSavedVouchers(@Request() req) {
    return this.vouchersService.getSavedVouchers(req.user.sub);
  }

  /** POST /vouchers/validate — Kiểm tra và tính tiền giảm */
  @Post('validate')
  async validate(@Request() req, @Body() dto: ValidateVoucherDto) {
    return this.vouchersService.validateVoucher(req.user.sub, dto);
  }
}
