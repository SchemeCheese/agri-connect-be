import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  Request,
  NotFoundException,
  Query,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';

// ─── Multer config dành riêng cho ảnh chat ─────────────────────────────────
const CHAT_UPLOAD_DIR = join(__dirname, '..', '..', '..', 'public', 'uploads', 'chat');
fs.mkdirSync(CHAT_UPLOAD_DIR, { recursive: true });

const CHAT_IMAGE_ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const chatImageMulter = {
  storage: diskStorage({
    destination: CHAT_UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${unique}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: CHAT_IMAGE_MAX_BYTES, files: 1 },
  fileFilter: (
    _req: unknown,
    file: { mimetype: string },
    cb: (err: Error | null, accept: boolean) => void,
  ) => {
    if (CHAT_IMAGE_ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new BadRequestException('Chỉ chấp nhận ảnh JPEG/PNG/WEBP/GIF.'), false);
    }
  },
};

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

class GetMessagesQueryDto {
  @IsOptional()
  @IsString()
  limit?: string;

  @IsOptional()
  @IsString()
  before?: string;
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
  async getMessages(
    @Request() req,
    @Param('id') conversationId: string,
    @Query() q: GetMessagesQueryDto,
  ) {
    const parsedLimit = q.limit ? Number.parseInt(q.limit, 10) : undefined;
    return this.chatService.getMessages(conversationId, req.user.sub, {
      limit: Number.isFinite(parsedLimit) && parsedLimit! > 0 ? parsedLimit : undefined,
      beforeMessageId: q.before,
    });
  }

  /**
   * POST /chat/conversations/:id/mark-read
   * Đánh dấu đã đọc — set last_read_at = NOW cho participant này.
   */
  @Post('conversations/:id/mark-read')
  async markRead(@Request() req, @Param('id') conversationId: string) {
    return this.chatService.markAsRead(conversationId, req.user.sub);
  }

  /**
   * GET /chat/unread-total
   * Tổng tin nhắn chưa đọc trên tất cả conversation — dùng cho badge app icon.
   */
  @Get('unread-total')
  async unreadTotal(@Request() req) {
    const total = await this.chatService.getUnreadTotal(req.user.sub);
    return { total };
  }

  /**
   * POST /chat/upload-image — Step 1 của image flow.
   * Multipart field name: `image`. Trả về { url } để FE bước 2 emit qua socket
   * hoặc gọi POST /chat/send-image với url đó.
   */
  @Post('upload-image')
  @UseInterceptors(FileInterceptor('image', chatImageMulter))
  async uploadChatImage(
    @Request() req,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Thiếu file ảnh.');
    // multer chạy fileFilter rồi nhưng double-check bên trong service-layer
    if (!CHAT_IMAGE_ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException('Định dạng ảnh không hỗ trợ.');
    }
    if (file.size > CHAT_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Ảnh vượt quá 5MB.');
    }
    // URL public — main.ts đã serve `public/`
    const url = `/uploads/chat/${file.filename}`;
    return { url, size: file.size, mime: file.mimetype };
  }

}
