import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MessageType, QuoteStatus, ConversationType } from '@prisma/client';
import { DatabaseService } from '../../database/database.service';
import { ChatService } from './chat.service';

export interface StartNegotiationResult {
  conversationId: string;
  // Giá và số lượng do buyer đề xuất (FE hiển thị lại trong chat header / card)
  proposedQuantity: number;
  proposedPrice: number;
  product: {
    id: string;
    name: string;
    unit: string;
    reference_price: number;
    min_negotiation_qty: number;
  };
}

export interface SendQuoteDto {
  conversationId: string;
  productId: string;
  productName: string;
  quantity: number;
  price: number;       // Giá đề xuất (đ / đơn vị)
  unit: string;
}

@Injectable()
export class NegotiationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly chatService: ChatService,
  ) {}

  // ─── Buyer khởi động đàm phán ─────────────────────────────────────────────
  // Validate ngưỡng kg, tìm/tạo conversation, lưu giá đề xuất, gửi tin nhắn SYSTEM
  async startNegotiation(
    buyerId: string,
    productId: string,
    quantity: number,
    proposedPrice: number,
  ): Promise<StartNegotiationResult> {
    const product = await this.db.product.findUnique({
      where: { id: productId },
      include: { seller: { select: { id: true, full_name: true } } },
    });

    if (!product || !product.is_active) {
      throw new NotFoundException('Sản phẩm không tồn tại hoặc đã ngừng bán.');
    }
    if (product.seller_id === buyerId) {
      throw new BadRequestException('Bạn không thể đàm phán với chính sản phẩm của mình.');
    }
    if (!product.min_negotiation_qty) {
      throw new BadRequestException('Sản phẩm này không hỗ trợ thương lượng giá.');
    }
    if (quantity < Number(product.min_negotiation_qty)) {
      throw new BadRequestException(
        `Phải mua từ ${product.min_negotiation_qty} ${product.unit} trở lên mới được thương lượng.`,
      );
    }

    // Tìm hoặc tạo conversation kiểu NEGOTIATION riêng (tách khỏi chat thường)
    // Gắn productId để FE hiển thị header "Đang thương lượng: [tên SP]"
    const conversation = await this.chatService.findOrCreateConversation(
      buyerId,
      product.seller_id,
      ConversationType.NEGOTIATION,
      productId,
    );

    // Cập nhật giá đề xuất mới nhất của buyer vào conversation
    // (buyer có thể gử lại nhiều lần với giá khác nhau trước khi seller phản hồi)
    await this.db.conversation.update({
      where: { id: conversation.id },
      data: { proposed_quantity: quantity, proposed_price: proposedPrice },
    });

    // Lấy tên buyer để ghi vào tin nhắn hệ thống
    const buyer = await this.db.user.findUnique({
      where: { id: buyerId },
      select: { full_name: true },
    });

    const systemMsg =
      `🌾 ${buyer?.full_name ?? 'Người mua'} muốn thương lượng giá sản phẩm ` +
      `"${product.name}" — ${quantity} ${product.unit} ` +
      `với giá đề xuất ${proposedPrice.toLocaleString('vi-VN')}đ/${product.unit}.`;

    await this.db.chatMessage.create({
      data: {
        conversation_id: conversation.id,
        sender_id: buyerId,
        message_content: systemMsg,
        message_type: MessageType.SYSTEM,
      },
    });

    return {
      conversationId: conversation.id,
      proposedQuantity: quantity,
      proposedPrice,
      product: {
        id: product.id,
        name: product.name,
        unit: product.unit,
        reference_price: Number(product.reference_price),
        min_negotiation_qty: Number(product.min_negotiation_qty),
      },
    };
  }

  // ─── Seller gửi card báo giá ──────────────────────────────────────────────
  // Chỉ cho phép 1 PENDING quote tại 1 thời điểm trong mỗi conversation
  async sendQuote(sellerId: string, dto: SendQuoteDto) {
    const conv = await this.db.conversation.findUnique({
      where: { id: dto.conversationId },
    });
    if (!conv) throw new NotFoundException('Cuộc trò chuyện không tồn tại.');
    if (conv.user1_id !== sellerId && conv.user2_id !== sellerId) {
      throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này.');
    }

    // Kiểm tra có PENDING quote chưa xử lý không
    const pendingQuote = await this.db.chatMessage.findFirst({
      where: {
        conversation_id: dto.conversationId,
        message_type: MessageType.NEGOTIATION_QUOTE,
        quote_status: QuoteStatus.PENDING,
      },
    });
    if (pendingQuote) {
      throw new BadRequestException(
        'Đang có một báo giá chưa được phản hồi. Vui lòng chờ người mua quyết định.',
      );
    }

    return this.db.chatMessage.create({
      data: {
        conversation_id: dto.conversationId,
        sender_id: sellerId,
        message_content:
          `📋 Báo giá: ${dto.productName} — ` +
          `${dto.quantity} ${dto.unit} × ${dto.price.toLocaleString('vi-VN')}đ/${dto.unit}`,
        message_type: MessageType.NEGOTIATION_QUOTE,
        quote_product_id: dto.productId,
        quote_product_name: dto.productName,
        quote_quantity: dto.quantity,
        quote_price: dto.price,
        quote_unit: dto.unit,
        quote_status: QuoteStatus.PENDING,
      },
      include: { sender: { select: { id: true, full_name: true } } },
    });
  }

  // ─── Buyer phản hồi báo giá (chấp nhận / từ chối) ────────────────────────
  // Nếu ACCEPTED → trả về checkoutData để FE redirect sang trang đặt hàng
  async respondToQuote(
    buyerId: string,
    messageId: string,
    action: 'ACCEPTED' | 'REJECTED',
  ) {
    const msg = await this.db.chatMessage.findUnique({
      where: { id: messageId },
      include: { conversation: true },
    });

    if (!msg) throw new NotFoundException('Báo giá không tồn tại.');
    if (msg.message_type !== MessageType.NEGOTIATION_QUOTE) {
      throw new BadRequestException('Tin nhắn này không phải báo giá.');
    }
    if (msg.quote_status !== QuoteStatus.PENDING) {
      throw new BadRequestException('Báo giá này đã được xử lý rồi.');
    }

    const conv = msg.conversation;
    if (conv.user1_id !== buyerId && conv.user2_id !== buyerId) {
      throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này.');
    }
    // Người gửi quote là seller — buyer không phải sender
    if (msg.sender_id === buyerId) {
      throw new ForbiddenException('Người bán mới có thể gửi báo giá.');
    }

    const updated = await this.db.chatMessage.update({
      where: { id: messageId },
      data: {
        quote_status: action === 'ACCEPTED' ? QuoteStatus.ACCEPTED : QuoteStatus.REJECTED,
      },
    });

    if (action === 'ACCEPTED') {
      return {
        status: 'ACCEPTED' as const,
        // FE dùng dữ liệu này để pre-fill form checkout
        checkoutData: {
          productId: updated.quote_product_id,
          productName: updated.quote_product_name,
          quantity: Number(updated.quote_quantity),
          negotiatedPrice: Number(updated.quote_price),
          unit: updated.quote_unit,
          sellerId: msg.sender_id,
        },
      };
    }

    return { status: 'REJECTED' as const };
  }

  // ─── Hủy đàm phán (cả 2 bên có thể hủy) ─────────────────────────────────
  // Reject tất cả PENDING quote + gửi tin nhắn SYSTEM thông báo
  async cancelNegotiation(userId: string, conversationId: string) {
    const conv = await this.db.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('Cuộc trò chuyện không tồn tại.');
    if (conv.user1_id !== userId && conv.user2_id !== userId) {
      throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này.');
    }

    // Hủy toàn bộ PENDING quote trong conversation
    await this.db.chatMessage.updateMany({
      where: {
        conversation_id: conversationId,
        message_type: MessageType.NEGOTIATION_QUOTE,
        quote_status: QuoteStatus.PENDING,
      },
      data: { quote_status: QuoteStatus.REJECTED },
    });

    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { full_name: true },
    });

    return this.db.chatMessage.create({
      data: {
        conversation_id: conversationId,
        sender_id: userId,
        message_content: `❌ ${user?.full_name ?? 'Người dùng'} đã hủy cuộc đàm phán.`,
        message_type: MessageType.SYSTEM,
      },
      include: { sender: { select: { id: true, full_name: true } } },
    });
  }
}
