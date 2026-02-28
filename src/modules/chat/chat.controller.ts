import { Controller, Get, Param, UseGuards, Request } from '@nestjs/common';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // GET /chat/conversations — danh sách các cuộc trò chuyện của user hiện tại
  @Get('conversations')
  async getConversations(@Request() req) {
    return this.chatService.getConversations(req.user.sub);
  }

  // GET /chat/conversations/:id/messages — lịch sử tin nhắn của một conversation
  @Get('conversations/:id/messages')
  async getMessages(@Request() req, @Param('id') conversationId: string) {
    return this.chatService.getMessages(conversationId, req.user.sub);
  }
}
