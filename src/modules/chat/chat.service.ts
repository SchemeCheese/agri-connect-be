import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConversationType } from '@prisma/client';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class ChatService {
  constructor(private readonly db: DatabaseService) {}

  // ─── Tìm hoặc tạo mới Conversation giữa 2 user ─────────────────────────
  // type mặc định là GENERAL; NegotiationService truyền NEGOTIATION
  // productId: gắn sản phẩm đang hỏi/đàm phán vào cuộc trò chuyện (optional)
  async findOrCreateConversation(
    userAId: string,
    userBId: string,
    type: ConversationType = ConversationType.GENERAL,
    productId?: string,
  ) {
    const [user1Id, user2Id] = [userAId, userBId].sort();

    // Với GENERAL: mỗi (buyer, seller, product) chỉ có 1 conversation
    // Với NEGOTIATION: mỗi (buyer, seller, product) cũng chỉ có 1
    const existing = await this.db.conversation.findFirst({
      where: {
        OR: [
          { user1_id: user1Id, user2_id: user2Id },
          { user1_id: user2Id, user2_id: user1Id },
        ],
        conversation_type: type,
        product_id: productId ?? null,
      },
    });

    if (existing) return existing;

    return this.db.conversation.create({
      data: {
        user1_id: user1Id,
        user2_id: user2Id,
        conversation_type: type,
        product_id: productId ?? null,
      },
    });
  }

  // ─── HTTP: Khởi tạo chat thường (dùng cho nút "Chat ngay" ở trang sản phẩm) ─
  // productId (optional): nếu bấm từ trang sản phẩm thì truyền vào để gắn context SP
  async initiateChat(requesterId: string, partnerId: string, productId?: string) {
    if (requesterId === partnerId) {
      throw new BadRequestException('Không thể tự chat với chính mình.');
    }
    const partner = await this.db.user.findUnique({
      where: { id: partnerId },
      select: { id: true, full_name: true },
    });
    if (!partner) throw new NotFoundException('Người dùng không tồn tại.');

    // Lấy thông tin sản phẩm nếu có (FE dùng hiển thị popover context)
    let productContext: {
      id: string;
      name: string;
      reference_price: number;
      unit: string;
      image: string | null;
    } | null = null;

    if (productId) {
      const product = await this.db.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, reference_price: true, unit: true },
      });
      if (product) {
        const img = await this.db.attachment.findFirst({
          where: { target_id: product.id, target_type: 'PRODUCT' },
          select: { url: true },
        });
        productContext = {
          id: product.id,
          name: product.name,
          reference_price: Number(product.reference_price),
          unit: product.unit,
          image: img?.url ?? null,
        };
      }
    }

    const conv = await this.findOrCreateConversation(
      requesterId,
      partnerId,
      ConversationType.GENERAL,
      productId,
    );
    return { conversationId: conv.id, partner, product: productContext };
  }

  // ─── Lưu tin nhắn vào DB ─────────────────────────────────────────────────
  async saveMessage(conversationId: string, senderId: string, content: string) {
    // Kiểm tra người gửi có thuộc conversation này không
    const conv = await this.db.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conv) throw new NotFoundException('Cuộc trò chuyện không tồn tại.');

    if (conv.user1_id !== senderId && conv.user2_id !== senderId) {
      throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này.');
    }

    return this.db.chatMessage.create({
      data: {
        conversation_id: conversationId,
        sender_id: senderId,
        message_content: content,
      },
      include: {
        sender: {
          select: { id: true, full_name: true },
        },
      },
    });
  }

  // ─── Lấy lịch sử tin nhắn của một conversation ───────────────────────────
  async getMessages(conversationId: string, requesterId: string) {
    const conv = await this.db.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conv) throw new NotFoundException('Cuộc trò chuyện không tồn tại.');

    if (conv.user1_id !== requesterId && conv.user2_id !== requesterId) {
      throw new ForbiddenException('Bạn không có quyền xem cuộc trò chuyện này.');
    }

    return this.db.chatMessage.findMany({
      where: { conversation_id: conversationId },
      orderBy: { created_at: 'asc' },
      include: {
        sender: { select: { id: true, full_name: true } },
      },
    });
  }

  // ─── Lấy danh sách conversation của user (có thể lọc theo type) ───────────
  // type = undefined → trả về GENERAL + NEGOTIATION (bỏ qua AI)
  async getConversations(userId: string, type?: ConversationType) {
    const conversations = await this.db.conversation.findMany({
      where: {
        OR: [{ user1_id: userId }, { user2_id: userId }],
        conversation_type: type ?? { in: [ConversationType.GENERAL, ConversationType.NEGOTIATION] },
      },
      include: {
        user1: { select: { id: true, full_name: true } },
        user2: { select: { id: true, full_name: true } },
        // Gắn thông tin sản phẩm (nếu có) — dùng hiển thị header "Đang hỏi về: ..."
        product: {
          select: { id: true, name: true, reference_price: true, unit: true, min_negotiation_qty: true },
        },
        messages: {
          orderBy: { created_at: 'desc' },
          take: 1, // Tin nhắn mới nhất để preview
        },
      },
      orderBy: { created_at: 'desc' },
    });

    // Lấy avatar của đối phương từ bảng Attachment
    return Promise.all(
      conversations.map(async (conv) => {
        // Xác định đối phương
        const partner = conv.user1_id === userId ? conv.user2 : conv.user1;

        const avatarAttachment = await this.db.attachment.findFirst({
          where: { target_id: partner.id, target_type: 'AVATAR' },
          select: { url: true },
        });

        return {
          id: conv.id,
          conversation_type: conv.conversation_type,
          partner: {
            id: partner.id,
            full_name: partner.full_name,
            avatar: avatarAttachment?.url ?? null,
          },
        // null nếu chỉ chat thường từ trang shop (không kèm sản phẩm)
          product: conv.product
            ? {
                id: conv.product.id,
                name: conv.product.name,
                reference_price: Number(conv.product.reference_price),
                unit: conv.product.unit,
                min_negotiation_qty: conv.product.min_negotiation_qty
                  ? Number(conv.product.min_negotiation_qty)
                  : null,
              }
            : null,
          // Chỉ có giá trị khi conversation_type = NEGOTIATION
          proposedQuantity: (conv as any).proposed_quantity ? Number((conv as any).proposed_quantity) : null,
          proposedPrice: (conv as any).proposed_price ? Number((conv as any).proposed_price) : null,
          // lastMessage.message_content là field FE phải dùng (KHÔNG phải 'content')
          lastMessage: conv.messages[0]
            ? {
                id: conv.messages[0].id,
                content: (conv.messages[0] as any).message_content,
                message_type: (conv.messages[0] as any).message_type,
                created_at: conv.messages[0].created_at,
              }
            : null,
          created_at: conv.created_at,
        };
      }),
    );
  }
}
