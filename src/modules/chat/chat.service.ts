import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { MessageType } from '@prisma/client';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class ChatService {
  constructor(private readonly db: DatabaseService) {}

  // ─── Tìm hoặc tạo Conversation — 1 cặp user = 1 conversation duy nhất ──────
  async findOrCreateConversation(userAId: string, userBId: string) {
    const [user1Id, user2Id] = [userAId, userBId].sort();

    const existing = await this.db.conversation.findFirst({
      where: {
        OR: [
          { user1_id: user1Id, user2_id: user2Id },
          { user1_id: user2Id, user2_id: user1Id },
        ],
      },
    });

    if (existing) return existing;

    return this.db.conversation.create({
      data: { user1_id: user1Id, user2_id: user2Id },
    });
  }

  // ─── Tìm conversation theo cặp partner (dùng cho FE check trước khi navigate) ──
  async findConversationByPartner(userId: string, partnerId: string) {
    const [user1Id, user2Id] = [userId, partnerId].sort();
    const conv = await this.db.conversation.findUnique({
      where: { user1_id_user2_id: { user1_id: user1Id, user2_id: user2Id } },
    });
    return conv ?? null;
  }

  // ─── HTTP: Khởi tạo chat từ trang sản phẩm hoặc trang shop ──────────────────
  // productId truyền vào → gửi SYSTEM message đính SP → FE render badge SP
  // productId không truyền → chat thường từ trang shop, không badge SP
  async initiateChat(requesterId: string, partnerId: string, productId?: string) {
    if (requesterId === partnerId) {
      throw new BadRequestException('Không thể tự chat với chính mình.');
    }

    const partner = await this.db.user.findUnique({
      where: { id: partnerId },
      select: { id: true, full_name: true },
    });
    if (!partner) throw new NotFoundException('Người dùng không tồn tại.');

    const conv = await this.findOrCreateConversation(requesterId, partnerId);

    let productContext: {
      id: string;
      name: string;
      reference_price: number;
      unit: string;
      min_negotiation_qty: number | null;
      image: string | null;
    } | null = null;

    if (productId) {
      const product = await this.db.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, reference_price: true, unit: true, min_negotiation_qty: true },
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
          min_negotiation_qty: product.min_negotiation_qty
            ? Number(product.min_negotiation_qty)
            : null,
          image: img?.url ?? null,
        };

        // Gửi SYSTEM message chỉ khi tin nhắn cuối cùng CHƯA phải context về SP này
        // Tránh spam SYSTEM msg mỗi lần user bấm "Chat ngay" vào cùng 1 SP
        const lastMsg = await this.db.chatMessage.findFirst({
          where: { conversation_id: conv.id },
          orderBy: { created_at: 'desc' },
          select: { message_type: true, context_product_id: true },
        });
        const alreadyContexted =
          lastMsg?.message_type === MessageType.SYSTEM &&
          lastMsg?.context_product_id === productId;

        if (!alreadyContexted) {
          await this.db.chatMessage.create({
            data: {
              conversation_id: conv.id,
              sender_id: requesterId,
              message_content: `🧺 Đang hỏi về sản phẩm "${product.name}"`,
              message_type: MessageType.SYSTEM,
              context_product_id: productId,
            },
          });
        }
      }
    }

    return { conversationId: conv.id, partner, product: productContext };
  }

  // ─── Lưu tin nhắn TEXT vào DB ─────────────────────────────────────────────
  async saveMessage(conversationId: string, senderId: string, content: string) {
    const conv = await this.db.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('Cuộc trò chuyện không tồn tại.');
    if (conv.user1_id !== senderId && conv.user2_id !== senderId) {
      throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này.');
    }

    return this.db.chatMessage.create({
      data: {
        conversation_id: conversationId,
        sender_id: senderId,
        message_content: content,
        message_type: MessageType.TEXT,
      },
      include: { sender: { select: { id: true, full_name: true } } },
    });
  }

  // ─── Lấy lịch sử tin nhắn ────────────────────────────────────────────────
  async getMessages(conversationId: string, requesterId: string) {
    const conv = await this.db.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('Cuộc trò chuyện không tồn tại.');
    if (conv.user1_id !== requesterId && conv.user2_id !== requesterId) {
      throw new ForbiddenException('Bạn không có quyền xem cuộc trò chuyện này.');
    }

    const messages = await this.db.chatMessage.findMany({
      where: { conversation_id: conversationId },
      orderBy: { created_at: 'asc' },
      include: {
        sender: { select: { id: true, full_name: true } },
        context_product: {
          select: { id: true, name: true, reference_price: true, unit: true, min_negotiation_qty: true },
        },
      },
    });

    // Lấy ảnh cho tất cả context_product một lần (tránh N+1)
    const productIds = [...new Set(
      messages.map((m) => m.context_product_id).filter(Boolean),
    )] as string[];
    const attachmentsRaw = productIds.length
      ? await this.db.attachment.findMany({
          where: { target_id: { in: productIds }, target_type: 'PRODUCT' },
          select: { target_id: true, url: true },
          orderBy: { created_at: 'asc' },
        })
      : [];
    const imageMap = new Map<string, string>();
    for (const att of attachmentsRaw) {
      if (!imageMap.has(att.target_id)) imageMap.set(att.target_id, att.url);
    }

    return messages.map((m) => ({
      id: m.id,
      sender: m.sender,
      message_content: m.message_content,
      message_type: m.message_type,
      created_at: m.created_at,
      // Badge sản phẩm — có ở SYSTEM message "Chat ngay" / startNegotiation và NEGOTIATION_QUOTE
      context_product: m.context_product
        ? {
            id: m.context_product.id,
            name: m.context_product.name,
            reference_price: Number(m.context_product.reference_price),
            unit: m.context_product.unit,
            min_negotiation_qty: m.context_product.min_negotiation_qty
              ? Number(m.context_product.min_negotiation_qty)
              : null,
            image: imageMap.get(m.context_product.id) ?? null,
          }
        : null,
      // Đề xuất của buyer — có ở SYSTEM message từ startNegotiation
      proposed_quantity: m.proposed_quantity ? Number(m.proposed_quantity) : null,
      proposed_price: m.proposed_price ? Number(m.proposed_price) : null,
      // Card báo giá — chỉ có khi message_type = NEGOTIATION_QUOTE
      quote: m.message_type === MessageType.NEGOTIATION_QUOTE
        ? {
            productId: m.quote_product_id,
            productName: m.quote_product_name,
            quantity: m.quote_quantity ? Number(m.quote_quantity) : null,
            price: m.quote_price ? Number(m.quote_price) : null,
            unit: m.quote_unit,
            status: m.quote_status,
          }
        : null,
    }));
  }

  // ─── Danh sách conversation của user ─────────────────────────────────────
  async getConversations(userId: string) {
    const conversations = await this.db.conversation.findMany({
      where: {
        OR: [{ user1_id: userId }, { user2_id: userId }],
      },
      include: {
        user1: { select: { id: true, full_name: true } },
        user2: { select: { id: true, full_name: true } },
        messages: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
      orderBy: { created_at: 'desc' },
    });

    return Promise.all(
      conversations.map(async (conv) => {
        const partner = conv.user1_id === userId ? conv.user2 : conv.user1;

        const avatarAttachment = await this.db.attachment.findFirst({
          where: { target_id: partner.id, target_type: 'AVATAR' },
          select: { url: true },
        });

        const lastMsg = conv.messages[0] ?? null;

        return {
          id: conv.id,
          partner: {
            id: partner.id,
            full_name: partner.full_name,
            avatar: avatarAttachment?.url ?? null,
          },
          lastMessage: lastMsg
            ? {
                id: lastMsg.id,
                content: lastMsg.message_content,
                message_type: lastMsg.message_type,
                created_at: lastMsg.created_at,
              }
            : null,
          created_at: conv.created_at,
        };
      }),
    );
  }
}
