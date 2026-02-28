import { Controller, Post, Patch, Body, UseGuards, Request, Get, Param } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dtos/create-order.dto';
import { CancelOrderDto } from './dtos/cancel-order.dto';
import { ReportIssueDto } from './dtos/report-issue.dto';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/decorators/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
    constructor(private readonly ordersService: OrdersService) { }

    // ─── BUYER: Đặt hàng ─────────────────────────────────────────────────────
    @UseGuards(RolesGuard)
    @Roles(UserRole.BUYER)
    @Post('checkout')
    async checkout(@Request() req, @Body() dto: CreateOrderDto) {
        return this.ordersService.checkout(req.user.sub, dto);
    }

    // ─── BUYER: Xem đơn của mình ──────────────────────────────────────────────
    @UseGuards(RolesGuard)
    @Roles(UserRole.BUYER)
    @Get('my-orders')
    async getMyOrders(@Request() req) {
        return this.ordersService.getUserOrders(req.user.sub);
    }

    // ─── SELLER: Xem đơn nhận được ───────────────────────────────────────────
    @UseGuards(RolesGuard)
    @Roles(UserRole.SELLER)
    @Get('seller-orders')
    async getSellerOrders(@Request() req) {
        return this.ordersService.getSellerOrders(req.user.sub);
    }

    // ─── SELLER: Xác nhận đơn  PENDING → CONFIRMED ───────────────────────────
    @UseGuards(RolesGuard)
    @Roles(UserRole.SELLER)
    @Patch(':id/confirm')
    async confirm(@Request() req, @Param('id') orderId: string) {
        return this.ordersService.confirmOrder(req.user.sub, orderId);
    }

    // ─── SELLER: Gửi đơn  CONFIRMED → SHIPPING ───────────────────────────────
    @UseGuards(RolesGuard)
    @Roles(UserRole.SELLER)
    @Patch(':id/ship')
    async ship(@Request() req, @Param('id') orderId: string) {
        return this.ordersService.shipOrder(req.user.sub, orderId);
    }

    // ─── BUYER: Xác nhận nhận hàng  SHIPPING → COMPLETED ────────────────────
    @UseGuards(RolesGuard)
    @Roles(UserRole.BUYER)
    @Patch(':id/complete')
    async complete(@Request() req, @Param('id') orderId: string) {
        return this.ordersService.completeOrder(req.user.sub, orderId);
    }
    // ─── BUYER: Báo chưa nhận hàng  SHIPPING → ISSUE_REPORTED ─────────────────
    @UseGuards(RolesGuard)
    @Roles(UserRole.BUYER)
    @Patch(':id/report-issue')
    async reportIssue(
        @Request() req,
        @Param('id') orderId: string,
        @Body() dto: ReportIssueDto,
    ) {
        return this.ordersService.reportIssue(req.user.sub, orderId, dto?.note);
    }

    // ─── SELLER: Xác nhận hàng thất lạc  ISSUE_REPORTED → FAILED ────────────
    @UseGuards(RolesGuard)
    @Roles(UserRole.SELLER)
    @Patch(':id/confirm-lost')
    async confirmLost(@Request() req, @Param('id') orderId: string) {
        return this.ordersService.confirmLost(req.user.sub, orderId);
    }
    // ─── SELLER: Hủy đơn + gửi email  (PENDING | CONFIRMED) → CANCELLED ─────
    @UseGuards(RolesGuard)
    @Roles(UserRole.SELLER)
    @Patch(':id/cancel')
    async cancelBySeller(@Request() req, @Param('id') orderId: string, @Body() dto: CancelOrderDto) {
        return this.ordersService.cancelOrderBySeller(req.user.sub, orderId, dto.reason);
    }

    // ─── BUYER: Tự hủy đơn  PENDING → CANCELLED ──────────────────────────────
    @UseGuards(RolesGuard)
    @Roles(UserRole.BUYER)
    @Patch(':id/cancel-by-buyer')
    async cancelByBuyer(@Request() req, @Param('id') orderId: string) {
        return this.ordersService.cancelOrderByBuyer(req.user.sub, orderId);
    }

    // ─── SELLER: Dashboard tổng quan ─────────────────────────────────────────
    @UseGuards(RolesGuard)
    @Roles(UserRole.SELLER)
    @Get('seller-dashboard')
    async getSellerDashboard(@Request() req) {
        return this.ordersService.getSellerDashboard(req.user.sub);
    }
}
