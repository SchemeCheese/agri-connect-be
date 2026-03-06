import { Controller, Get, Post, Param, Body, UseGuards, Request, NotFoundException } from '@nestjs/common';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';

class InitiateChatDto {
  @IsString()
  @IsNotEmpty()
  partnerId: string;

  // Truyền vào khi bấm "Chat ngay" từ trang sản phẩm
  // Không truyền khi bấm "Chat với shop" từ trang shop
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
   * Kết hợp 2 luồng trong 1 endpoint:
   * - { partnerId, productId } → "Chat ngay" từ trang sản phẩm (gửi SYSTEM msg kèm SP)
   * - { partnerId }           → "Chat với shop" (không kèm sản phẩm)
   * Trả về conversationId + thông tin SP (nếu có) để FE navigate vào trang chat.
   */
  @Post('initiate')
  async initiateChat(@Request() req, @Body() dto: InitiateChatDto) {
    return this.chatService.initiateChat(req.user.sub, dto.partnerId, dto.productId);
  }

  /**
   * GET /chat/conversations
   * Danh sách tất cả conversation của user hiện tại.
   * Mỗi cặp buyer-seller chỉ có 1 conversation duy nhất.
   */
  @Get('conversations')
  async getConversations(@Request() req) {
    return this.chatService.getConversations(req.user.sub);
  }

  /**
   * GET /chat/conversations/partner/:partnerId
   * Kiểm tra xem đã có conversation với partner chưa.
   * FE dùng để navigate thẳng vào chat window mà không cần gọi POST /initiate.
   * Trả về { conversationId } hoặc 404 nếu chưa có.
   */
  @Get('conversations/partner/:partnerId')
  async getConversationByPartner(@Request() req, @Param('partnerId') partnerId: string) {
    const conv = await this.chatService.findConversationByPartner(req.user.sub, partnerId);
    if (!conv) throw new NotFoundException('Chưa có cuộc trò chuyện với người dùng này.');
    return { conversationId: conv.id };
  }

  /**
   * GET /chat/conversations/:id/messages
   * Lịch sử tin nhắn. Mỗi item có :
   * - message_type: TEXT | SYSTEM | NEGOTIATION_QUOTE
   * - context_product: thông tin SP (nếu là SYSTEM msg "Chat ngay" hoặc NEGOTIATION)
   * - quote: thông tin báo giá (nếu NEGOTIATION_QUOTE)
   */
  @Get('conversations/:id/messages')
  async getMessages(@Request() req, @Param('id') conversationId: string) {
    return this.chatService.getMessages(conversationId, req.user.sub);
  }
}
