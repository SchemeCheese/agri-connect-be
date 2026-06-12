import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { MessageType } from '@prisma/client';
import { isManagedChatImageUrl } from '../../common/storage/product-image.storage';
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

  // ─── Đánh dấu đã đọc + trả về unread sau khi mark ─────────────────────────
  // Idempotent: gọi nhiều lần cũng OK.
  async markAsRead(conversationId: string, userId: string) {
    const conv = await this.assertMembership(conversationId, userId);
    const now = new Date();
    const isUser1 = conv.user1_id === userId;
    await this.db.conversation.update({
      where: { id: conversationId },
      data: isUser1 ? { user1_last_read_at: now } : { user2_last_read_at: now },
    });
    return { conversationId, unread: 0, lastReadAt: now };
  }

  // ─── Tính unread cho 1 conversation ───────────────────────────────────────
  async getUnreadCount(conversationId: string, userId: string): Promise<number> {
    const conv = await this.db.conversation.findUnique({
      where: { id: conversationId },
      select: { user1_id: true, user2_id: true, user1_last_read_at: true, user2_last_read_at: true },
    });
    if (!conv) return 0;
    if (conv.user1_id !== userId && conv.user2_id !== userId) return 0;

    const lastRead = conv.user1_id === userId ? conv.user1_last_read_at : conv.user2_last_read_at;

    return this.db.chatMessage.count({
      where: {
        conversation_id: conversationId,
        sender_id: { not: userId }, // không đếm tin nhắn của chính mình
        ...(lastRead ? { created_at: { gt: lastRead } } : {}),
      },
    });
  }

  // ─── Tổng unread của 1 user (cho app icon badge) ──────────────────────────
  async getUnreadTotal(userId: string): Promise<number> {
    const convs = await this.db.conversation.findMany({
      where: { OR: [{ user1_id: userId }, { user2_id: userId }] },
      select: { id: true, user1_id: true, user2_id: true, user1_last_read_at: true, user2_last_read_at: true },
    });
    if (convs.length === 0) return 0;

    // Gom thành 1 query duy nhất bằng raw SQL để tránh N+1
    const parts: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const c of convs) {
      const lastRead = c.user1_id === userId ? c.user1_last_read_at : c.user2_last_read_at;
      if (lastRead) {
        parts.push(`(conversation_id = $${i++} AND sender_id <> $${i++} AND created_at > $${i++})`);
        values.push(c.id, userId, lastRead);
      } else {
        parts.push(`(conversation_id = $${i++} AND sender_id <> $${i++})`);
        values.push(c.id, userId);
      }
    }
    const sql = `SELECT COUNT(*)::int AS count FROM "ChatMessage" WHERE ${parts.join(' OR ')}`;
    const rows = await this.db.$queryRawUnsafe<{ count: number }[]>(sql, ...values);
    return rows[0]?.count ?? 0;
  }

  // ─── Trả về userId của đối phương trong conversation ──────────────────────
  async getOtherParticipant(conversationId: string, userId: string): Promise<string | null> {
    const conv = await this.db.conversation.findUnique({
      where: { id: conversationId },
      select: { user1_id: true, user2_id: true },
    });
    if (!conv) return null;
    if (conv.user1_id === userId) return conv.user2_id;
    if (conv.user2_id === userId) return conv.user1_id;
    return null;
  }

  // ─── Bảo đảm user thuộc conversation (dùng ở gateway TRƯỚC khi xử lý event) ──
  // Trả về conversation nếu hợp lệ, throw ForbiddenException nếu không.
  async assertMembership(conversationId: string, userId: string) {
    const conv = await this.db.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, user1_id: true, user2_id: true },
    });
    if (!conv) throw new NotFoundException('Cuộc trò chuyện không tồn tại.');
    if (conv.user1_id !== userId && conv.user2_id !== userId) {
      throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này.');
    }
    return conv;
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

  // ─── Lưu tin nhắn TEXT vào DB (idempotent theo client_message_id) ─────────
  async saveMessage(
    conversationId: string,
    senderId: string,
    content: string,
    clientMessageId?: string,
  ) {
    const conv = await this.db.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('Cuộc trò chuyện không tồn tại.');
    if (conv.user1_id !== senderId && conv.user2_id !== senderId) {
      throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này.');
    }

    // Nếu FE gửi kèm clientMessageId → kiểm tra đã lưu chưa để chống duplicate khi retry
    if (clientMessageId) {
      const existing = await this.db.chatMessage.findUnique({
        where: {
          sender_id_client_message_id: {
            sender_id: senderId,
            client_message_id: clientMessageId,
          },
        },
        include: { sender: { select: { id: true, full_name: true } } },
      });
      if (existing) return existing;
    }

    try {
      return await this.db.chatMessage.create({
        data: {
          conversation_id: conversationId,
          sender_id: senderId,
          message_content: content,
          message_type: MessageType.TEXT,
          client_message_id: clientMessageId ?? null,
        },
        include: { sender: { select: { id: true, full_name: true } } },
      });
    } catch (err: any) {
      // Race condition: 2 request gần như đồng thời cùng clientMessageId → P2002 unique
      // Khi đó row đã được insert bởi request kia → trả về row đó
      if (err?.code === 'P2002' && clientMessageId) {
        const existing = await this.db.chatMessage.findUnique({
          where: {
            sender_id_client_message_id: {
              sender_id: senderId,
              client_message_id: clientMessageId,
            },
          },
          include: { sender: { select: { id: true, full_name: true } } },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }

  // ─── Lưu tin nhắn ảnh (idempotent theo client_message_id) ─────────────────
  // imageUrl phải là path do POST /chat/upload-image trả về.
  async saveImageMessage(
    conversationId: string,
    senderId: string,
    imageUrl: string,
    caption?: string,
    clientMessageId?: string,
  ) {
    const conv = await this.db.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('Cuộc trò chuyện không tồn tại.');
    if (conv.user1_id !== senderId && conv.user2_id !== senderId) {
      throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này.');
    }
    if (!imageUrl?.trim()) {
      throw new BadRequestException('Thiếu imageUrl.');
    }
    // Only accept legacy chat paths or values produced by the managed image store.
    if (!isManagedChatImageUrl(imageUrl)) {
      throw new BadRequestException('imageUrl không hợp lệ.');
    }

    if (clientMessageId) {
      const existing = await this.db.chatMessage.findUnique({
        where: {
          sender_id_client_message_id: {
            sender_id: senderId,
            client_message_id: clientMessageId,
          },
        },
        include: { sender: { select: { id: true, full_name: true } } },
      });
      if (existing) return existing;
    }

    try {
      return await this.db.chatMessage.create({
        data: {
          conversation_id: conversationId,
          sender_id: senderId,
          message_content: caption?.trim() || '',
          message_type: MessageType.IMAGE,
          image_url: imageUrl,
          client_message_id: clientMessageId ?? null,
        },
        include: { sender: { select: { id: true, full_name: true } } },
      });
    } catch (err: any) {
      if (err?.code === 'P2002' && clientMessageId) {
        const existing = await this.db.chatMessage.findUnique({
          where: {
            sender_id_client_message_id: {
              sender_id: senderId,
              client_message_id: clientMessageId,
            },
          },
          include: { sender: { select: { id: true, full_name: true } } },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }

  // ─── Lấy lịch sử tin nhắn (cursor pagination) ─────────────────────────────
  // Strategy: query DESC theo created_at để load page cũ hơn, sau đó reverse về ASC để FE render.
  // - limit: số tin nhắn / trang (default 30, tối đa 100)
  // - beforeMessageId: lấy các tin nhắn được tạo TRƯỚC message này (cho infinite scroll lên)
  async getMessages(
    conversationId: string,
    requesterId: string,
    opts: { limit?: number; beforeMessageId?: string } = {},
  ) {
    const conv = await this.db.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('Cuộc trò chuyện không tồn tại.');
    if (conv.user1_id !== requesterId && conv.user2_id !== requesterId) {
      throw new ForbiddenException('Bạn không có quyền xem cuộc trò chuyện này.');
    }

    const take = Math.min(Math.max(opts.limit ?? 30, 1), 100);

    const messages = await this.db.chatMessage.findMany({
      where: { conversation_id: conversationId },
      orderBy: { created_at: 'desc' },
      take: take + 1, // lấy thừa 1 để biết còn page trước nữa không
      ...(opts.beforeMessageId
        ? { cursor: { id: opts.beforeMessageId }, skip: 1 }
        : {}),
      include: {
        sender: { select: { id: true, full_name: true } },
        context_product: {
          select: { id: true, name: true, reference_price: true, unit: true, min_negotiation_qty: true },
        },
      },
    });

    const hasMore = messages.length > take;
    const page = hasMore ? messages.slice(0, take) : messages;
    const nextCursor = hasMore ? page[page.length - 1].id : null;
    // Đảo lại ASC cho FE hiển thị (cũ → mới)
    page.reverse();

    // Lấy ảnh cho tất cả context_product một lần (tránh N+1)
    const productIds = [...new Set(
      page.map((m) => m.context_product_id).filter(Boolean),
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

    // Batch load orders for NEGOTIATION_QUOTE messages to avoid N+1 queries
    const quoteMessageIds = page
      .filter((m) => m.message_type === MessageType.NEGOTIATION_QUOTE)
      .map((m) => m.id);

    // 1 query duy nhất với IN clause → tránh N+1. orderBy desc để đơn MỚI NHẤT
    // của mỗi quote được ưu tiên (1 quote có thể có nhiều Order khi buyer retry
    // sau khi đơn cũ bị CANCELLED/FAILED — xem thiết kế negotiation_quote_id).
    const ordersRaw = quoteMessageIds.length
      ? await this.db.order.findMany({
          where: { negotiation_quote_id: { in: quoteMessageIds } },
          orderBy: { created_at: 'desc' },
          select: {
            id: true,
            negotiation_quote_id: true,
            status: true,
            payment_method: true,
            final_total_price: true,
            checkout_session_id: true,
            payments: { select: { status: true }, take: 1, orderBy: { created_at: 'desc' } },
          },
        })
      : [];

    // Map orders by their negotiation_quote_id for O(1) lookup. orderBy desc ở trên +
    // "chỉ set nếu chưa có" → đơn mới nhất / quote thắng.
    const orderMap = new Map<string, any>();
    for (const order of ordersRaw) {
      if (order.negotiation_quote_id && !orderMap.has(order.negotiation_quote_id)) {
        const paymentStatus = order.payments?.[0]?.status ?? null;
        orderMap.set(order.negotiation_quote_id, {
          // Khóa theo yêu cầu Task 1 (snake_case, tối thiểu cần có)
          id: order.id,
          status: order.status,
          payment_status: paymentStatus,
          payment_method: order.payment_method,
          // Khóa tương thích ngược với FE hiện tại (NegotiationQuoteCard.QuoteOrderInfo)
          orderId: order.id,
          orderStatus: order.status,
          paymentStatus,
          checkoutSessionId: order.checkout_session_id ?? undefined,
          totalAmount: order.final_total_price ? Number(order.final_total_price) : 0,
        });
      }
    }

    const items = page.map((m) => ({
      id: m.id,
      sender: m.sender,
      message_content: m.message_content,
      message_type: m.message_type,
      image_url: m.image_url ?? null,
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
      // Order info — hydrated for NEGOTIATION_QUOTE messages that have associated orders
      orderInfo: m.message_type === MessageType.NEGOTIATION_QUOTE ? (orderMap.get(m.id) ?? null) : null,
    }));

    return { items, nextCursor, hasMore };
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

    if (conversations.length === 0) return [];

    // Tính unread mỗi conv. N ở đây nhỏ (<50) → đếm song song, đủ nhanh.
    const unreadEntries = await Promise.all(
      conversations.map(async (c) => {
        const lastRead = c.user1_id === userId ? c.user1_last_read_at : c.user2_last_read_at;
        const cnt = await this.db.chatMessage.count({
          where: {
            conversation_id: c.id,
            sender_id: { not: userId },
            ...(lastRead ? { created_at: { gt: lastRead } } : {}),
          },
        });
        return [c.id, cnt] as const;
      }),
    );
    const unreadMap = new Map<string, number>(unreadEntries);

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
          unread_count: unreadMap.get(conv.id) ?? 0,
          created_at: conv.created_at,
        };
      }),
    );
  }
}
