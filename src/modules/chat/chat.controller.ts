import { Controller, Get, Post, Param, Body, UseGuards, Request, Query } from '@nestjs/common';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ConversationType } from '@prisma/client';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';

class InitiateChatDto {
  @IsString()
  @IsNotEmpty()
  partnerId: string;

  // Nếu bấm "Chat ngay" từ trang sản phẩm — truyền vào để BE gắn context SP
  // Nếu bấm từ trang shop (chat chung) — không truyền
  @IsString()
  @IsOptional()
  productId?: string;
}

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /**
   * POST /chat/initiate
   * Nút "Chat ngay" ở trang sản phẩm / trang shop.
   * Tạo hoặc lấy conversation GENERAL, trả về conversationId để FE điều hướng.
   * FE không cần socket trước — chỉ cần gọi HTTP rồi navigate sang trang chat.
   */
  @Post('initiate')
  async initiateChat(@Request() req, @Body() dto: InitiateChatDto) {
    return this.chatService.initiateChat(req.user.sub, dto.partnerId, dto.productId);
  }

  /**
   * GET /chat/conversations?type=GENERAL|NEGOTIATION
   * Danh sách cuộc trò chuyện. Không truyền type → trả về GENERAL + NEGOTIATION.
   * FE dùng để render sidebar danh sách chat.
   */
  @Get('conversations')
  async getConversations(
    @Request() req,
    @Query('type') type?: ConversationType,
  ) {
    return this.chatService.getConversations(req.user.sub, type);
  }

  /**
   * GET /chat/conversations/:id/messages
   * Lịch sử tin nhắn của một conversation (phân trang sau nếu cần).
   */
  @Get('conversations/:id/messages')
  async getMessages(@Request() req, @Param('id') conversationId: string) {
    return this.chatService.getMessages(conversationId, req.user.sub);
  }
}
