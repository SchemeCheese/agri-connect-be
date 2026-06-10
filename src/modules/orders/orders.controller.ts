import { Controller, Post, Patch, Body, UseGuards, Request, Get, Param, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PaymentsService } from '../payments/payments.service';
import { DatabaseService } from '../../database/database.service';
import { CreateOrderDto } from './dtos/create-order.dto';
import { CheckoutQuoteDto } from './dtos/checkout-quote.dto';
import { CancelOrderDto } from './dtos/cancel-order.dto';
import { ReportIssueDto } from './dtos/report-issue.dto';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/decorators/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/decorators/roles.decorator';

@ApiTags('Orders')
@ApiBearerAuth('access-token')
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
    constructor(
        private readonly ordersService: OrdersService,
        private readonly paymentsService: PaymentsService,
        private readonly databaseService: DatabaseService,
    ) { }

    // ─── BUYER: Đặt hàng ─────────────────────────────────────────────────────
    // Tạo đơn: 5 request / phút / IP (chống spam tạo đơn / lạm dụng trừ kho).
    @ApiOperation({ summary: 'Checkout (tạo đơn)', description: 'BUYER tạo đơn từ giỏ; trừ tồn kho atomic. Rate-limit 5/phút.' })
    @Throttle({ default: { limit: 5, ttl: 60000 } })
    @UseGuards(RolesGuard)
    @Roles(UserRole.BUYER)
    @Post('checkout')
    async checkout(@Request() req, @Body() dto: CreateOrderDto) {
        return this.ordersService.checkout(req.user.sub, dto);
    }

    // ─── BUYER: Thanh toán quote ngay trong chat ───────────────────────────
    @Throttle({ default: { limit: 5, ttl: 60000 } })
    @UseGuards(RolesGuard)
    @Roles(UserRole.BUYER)
    @Post('checkout-quote')
    async checkoutQuote(@Request() req, @Body() dto: CheckoutQuoteDto) {
        return this.ordersService.checkoutQuote(req.user.sub, dto);
    }

    // ─── BUYER: Xem đơn của mình ──────────────────────────────────────────────
    @ApiOperation({ summary: 'Đơn của tôi (BUYER)', description: 'Danh sách đơn của buyer đang đăng nhập.' })
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

    // ─── SELLER: Dashboard tổng quan ─────────────────────────────────────────
    @UseGuards(RolesGuard)
    @Roles(UserRole.SELLER)
    @Get('seller-dashboard')
    async getSellerDashboard(@Request() req) {
        return this.ordersService.getSellerDashboard(req.user.sub);
    }

    // ─── BUYER: Xem chi tiết 1 đơn hàng ─────────────────────────────────────
    @ApiOperation({ summary: 'Chi tiết đơn (BUYER)', description: 'Chỉ trả đơn thuộc về buyer đang đăng nhập (IDOR-safe).' })
    @UseGuards(RolesGuard)
    @Roles(UserRole.BUYER)
    @Get(':id')
    async getOrderById(@Request() req, @Param('id') orderId: string) {
        return this.ordersService.getOrderById(req.user.sub, orderId);
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

    // ─── BUYER: "Tôi chưa nhận được hàng" — refund/dispute flow ─────────────
    // Rule 1 (COD)        → Order=RETURNED, no refund call.
    // Rule 2 (validation) → SHIPPING > 3 ngày từ shipped_at, hoặc COMPLETED < 3 ngày từ updated_at.
    // Rule 3 (MoMo paid)  → Order=REFUND_PENDING + Payment=REFUNDING, đợi admin gọi /refund.
    @UseGuards(RolesGuard)
    @Roles(UserRole.BUYER)
    @Patch(':id/not-received')
    async reportNotReceived(
        @Request() req,
        @Param('id') orderId: string,
        @Body() dto: ReportIssueDto,
    ) {
        return this.ordersService.reportItemNotReceived(req.user.sub, orderId, dto?.note);
    }

    // ─── ADMIN: Thực thi hoàn tiền MoMo (Rule 4) ─────────────────────────────
    // POST /orders/:id/refund — gọi MoMo refund API, Order=REFUNDED + Payment=REFUNDED.
    // Yêu cầu req.user.is_admin === true. Body có thể override amount; mặc định lấy final_total_price.
    @Post(':id/refund')
    async adminRefund(
        @Request() req,
        @Param('id') orderId: string,
        @Body() body: { amount?: number; reason?: string },
    ) {
        if (!req.user?.is_admin) {
            throw new ForbiddenException('Chỉ admin được phép thực thi hoàn tiền.');
        }
        const order = await this.databaseService.order.findUnique({
            where: { id: orderId },
            select: { final_total_price: true },
        });
        const amount = body?.amount ?? Number(order?.final_total_price ?? 0);
        return this.paymentsService.refundMomoTransaction(orderId, amount, body?.reason);
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

    // ─── BUYER: Đổi phương thức thanh toán (MOMO → COD khi chưa thanh toán) ──
    @UseGuards(RolesGuard)
    @Roles(UserRole.BUYER)
    @Patch(':id/change-payment-method')
    async changePaymentMethod(
        @Request() req,
        @Param('id') orderId: string,
        @Body() body: { payment_method: PaymentMethod },
    ) {
        if (!body?.payment_method) {
            throw new BadRequestException('Thiếu payment_method trong body.');
        }
        return this.ordersService.changePaymentMethod(req.user.sub, orderId, body.payment_method);
    }

    // ─── BUYER: Tự hủy đơn  PENDING → CANCELLED ──────────────────────────────
    @ApiOperation({ summary: 'Hủy đơn (BUYER)', description: 'PENDING → CANCELLED; tự hoàn tồn kho đã trừ.' })
    @UseGuards(RolesGuard)
    @Roles(UserRole.BUYER)
    @Patch(':id/cancel-by-buyer')
    async cancelByBuyer(@Request() req, @Param('id') orderId: string) {
        return this.ordersService.cancelOrderByBuyer(req.user.sub, orderId);
    }
}
