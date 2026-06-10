import { Body, Controller, Get, Param, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/decorators/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { AdminService } from './admin.service';
import { DisputeService } from './dispute.service';
import { AdjudicateDto, ModerateProductDto, SetUserStatusDto, VerifyShopDto } from './dtos/admin.dtos';

// Toàn bộ route /admin/* yêu cầu JWT hợp lệ + activeRole = ADMIN (RolesGuard coi
// ADMIN là superuser). Buyer/Seller gọi vào sẽ nhận 403 Forbidden.
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly disputes: DisputeService,
  ) {}

  // ─── Dashboard ───────────────────────────────────────────────────────────
  @Get('analytics/dashboard')
  dashboard() {
    return this.admin.dashboard();
  }

  // ─── Users ─────────────────────────────────────────────────────────────
  @Get('users')
  listUsers(@Query('page') page?: string, @Query('limit') limit?: string, @Query('search') search?: string) {
    return this.admin.listUsers({ page, limit, search });
  }

  @Get('users/:id/details')
  userDetails(@Param('id') id: string) {
    return this.admin.userDetails(id);
  }

  @Patch('users/:id/status')
  setUserStatus(@Param('id') id: string, @Body() dto: SetUserStatusDto) {
    return this.admin.setUserStatus(id, dto.is_active);
  }

  // ─── Seller / shop approval ────────────────────────────────────────────
  @Get('shops/pending')
  pendingShops() {
    return this.admin.listPendingShops();
  }

  @Patch('shops/:userId/verify')
  verifyShop(@Param('userId') userId: string, @Body() dto: VerifyShopDto) {
    return this.admin.verifyShop(userId, dto.is_verified);
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

  @Patch('products/:id/moderation')
  moderateProduct(@Param('id') id: string, @Body() dto: ModerateProductDto) {
    return this.admin.moderateProduct(id, dto.status, dto.reason);
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
}
