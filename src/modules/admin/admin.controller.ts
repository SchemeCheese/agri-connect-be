import { Body, Controller, Get, Param, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/decorators/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { AdminService } from './admin.service';
import { DisputeService } from './dispute.service';
import { AdjudicateDto, ModerateProductDto, SetTrustStatusDto, SetUserStatusDto, VerifyShopDto } from './dtos/admin.dtos';

// Toàn bộ route /admin/* yêu cầu JWT hợp lệ + activeRole = ADMIN (RolesGuard coi
// ADMIN là superuser). Buyer/Seller gọi vào sẽ nhận 403 Forbidden.
@ApiTags('Admin')
@ApiBearerAuth('access-token')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly disputes: DisputeService,
  ) {}

  // ─── Dashboard ───────────────────────────────────────────────────────────
  @ApiOperation({ summary: 'Dashboard quản trị', description: 'Thống kê users/products/orders/doanh thu (yêu cầu token ADMIN).' })
  @Get('analytics/dashboard')
  dashboard() {
    return this.admin.dashboard();
  }

  // ─── Users ─────────────────────────────────────────────────────────────
  @ApiOperation({ summary: 'Danh sách user (phân trang + tìm kiếm)', description: 'KHÔNG trả password_hash. Yêu cầu ADMIN.' })
  @Get('users')
  listUsers(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('role') role?: string,
  ) {
    return this.admin.listUsers({ page, limit, search, role });
  }

  @Get('users/:id/details')
  userDetails(@Param('id') id: string) {
    return this.admin.userDetails(id);
  }

  @Patch('users/:id/status')
  async setUserStatus(@Request() req, @Param('id') id: string, @Body() dto: SetUserStatusDto) {
    const result = await this.admin.setUserStatus(id, dto.is_active);
    await this.admin.writeAudit(req.user.sub, dto.is_active ? 'ACTIVATE_USER' : 'SUSPEND_USER', id, {
      is_active: dto.is_active,
      reason: dto.reason ?? null,
    });
    return result;
  }

  // ─── Shop verification (badge only, does not gate seller permissions) ──
  @Get('shops/unverified')
  unverifiedShops() {
    return this.admin.listUnverifiedShops();
  }

  // Backward-compatible alias for older clients.
  @Get('shops/pending')
  pendingShops() {
    return this.admin.listUnverifiedShops();
  }

  @Patch('shops/:userId/verify')
  async verifyShop(@Request() req, @Param('userId') userId: string, @Body() dto: VerifyShopDto) {
    const result = await this.admin.verifyShop(userId, dto.is_verified);
    await this.admin.writeAudit(req.user.sub, dto.is_verified ? 'VERIFY_SHOP' : 'UNVERIFY_SHOP', userId, {
      is_verified: dto.is_verified,
    });
    return result;
  }

  @Patch('shops/:userId/trust-status')
  async setShopTrust(@Request() req, @Param('userId') userId: string, @Body() dto: SetTrustStatusDto) {
    const result = await this.admin.setShopTrust(userId, dto.trust_status);
    await this.admin.writeAudit(req.user.sub, 'SET_TRUST_STATUS', userId, { trust_status: dto.trust_status });
    return result;
  }

  // ─── Product moderation ─────────────────────────────────────────────────
  @Get('products')
  listProducts(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.admin.listProducts({ page, limit, search, status });
  }

  @Get('products/:id/details')
  productDetails(@Param('id') id: string) {
    return this.admin.productDetails(id);
  }

  @Patch('products/:id/moderation')
  async moderateProduct(@Request() req, @Param('id') id: string, @Body() dto: ModerateProductDto) {
    const result = await this.admin.moderateProduct(id, dto.status, dto.reason);
    await this.admin.writeAudit(req.user.sub, 'MODERATE_PRODUCT', id, {
      status: dto.status,
      reason: dto.reason ?? null,
    });
    return result;
  }

  // ─── Disputes (admin view + phán quyết) ──────────────────────────────────
  @Get('disputes')
  listDisputes(@Query('status') status?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.disputes.listForAdmin({ status, page, limit });
  }

  @Get('disputes/:id')
  getDispute(@Param('id') id: string) {
    return this.disputes.getById(id);
  }

  @Post('disputes/:id/adjudicate')
  adjudicate(@Request() req, @Param('id') id: string, @Body() dto: AdjudicateDto) {
    return this.disputes.adjudicate(req.user.sub, id, dto);
  }

  // Alias đúng tên spec: POST /admin/disputes/:id/resolve (cùng logic adjudicate).
  @ApiOperation({ summary: 'Phán quyết tranh chấp (ADMIN)', description: 'outcome + action → refund/complete. Ghi AuditLog. Yêu cầu ADMIN.' })
  @Post('disputes/:id/resolve')
  resolve(@Request() req, @Param('id') id: string, @Body() dto: AdjudicateDto) {
    return this.disputes.adjudicate(req.user.sub, id, dto);
  }
}
