import { Controller, Post, Body, UseGuards, Request, Get } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dtos/create-order.dto';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard'; // Đường dẫn có thể cần chỉnh lại cho đúng

@Controller('orders')
export class OrdersController {
    constructor(private readonly ordersService: OrdersService) { }

    @UseGuards(JwtAuthGuard) // Bắt buộc phải có Token
    @Post('checkout')
    async checkout(@Request() req, @Body() dto: CreateOrderDto) {
        // req.user.sub chính là ID của User đang đăng nhập (được lấy từ JwtStrategy)
        const buyerId = req.user.sub;

        return this.ordersService.checkout(buyerId, dto);
    }

    @UseGuards(JwtAuthGuard)
    @Get('my-orders')
    async getMyOrders(@Request() req) {
        return this.ordersService.getUserOrders(req.user.sub);
    }
}