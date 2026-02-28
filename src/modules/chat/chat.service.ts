import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class ChatService {
  constructor(private readonly db: DatabaseService) {}

  // ─── Tìm hoặc tạo mới Conversation giữa 2 user ─────────────────────────
  async findOrCreateConversation(userAId: string, userBId: string) {
    // Đảm bảo thứ tự user1/user2 luôn nhất quán để tránh trùng lặp
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

  // ─── Lấy danh sách tất cả conversation của user ──────────────────────────
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
          partner: {
            id: partner.id,
            full_name: partner.full_name,
            avatar: avatarAttachment?.url ?? null,
          },
          lastMessage: conv.messages[0] ?? null,
          created_at: conv.created_at,
        };
      }),
    );
  }
}
