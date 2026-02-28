import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ChatService } from './chat.service';
import { Logger } from '@nestjs/common';

// Cho phép CORS từ FE (chỉnh origin phù hợp khi deploy)
@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  // Map: userId -> socketId (theo dõi ai đang online)
  private connectedUsers = new Map<string, string>();

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
  ) {}

  // ─── Khi client kết nối: xác thực JWT ────────────────────────────────────
  async handleConnection(client: Socket) {
    try {
      // FE gửi token qua: socket = io('/chat', { auth: { token: 'Bearer xxx' } })
      const rawToken =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization ||
        '';

      const token = rawToken.replace('Bearer ', '').trim();
      if (!token) throw new Error('Không có token');

      const payload = this.jwtService.verify(token, {
        secret: process.env.JWT_SECRET || 'secretKeyCuaBan',
      });

      // Gắn userId vào socket để dùng ở các handler bên dưới
      client.data.userId = payload.sub;
      client.data.userRole = payload.role;
      client.data.userName = payload.email;

      this.connectedUsers.set(payload.sub, client.id);
      this.logger.log(`✅ [CONNECT] User ${payload.sub} (${client.id})`);
    } catch (err) {
      this.logger.warn(`❌ [CONNECT FAILED] ${client.id} — ${err.message}`);
      client.emit('error', { message: 'Xác thực thất bại. Vui lòng đăng nhập lại.' });
      client.disconnect();
    }
  }

  // ─── Khi client ngắt kết nối ────────────────────────────────────────────
  handleDisconnect(client: Socket) {
    const userId = client.data?.userId;
    if (userId) {
      this.connectedUsers.delete(userId);
      this.logger.log(`🔌 [DISCONNECT] User ${userId}`);
    }
  }

  // ─── Event: joinRoom — tham gia phòng theo conversationId ────────────────
  // FE gọi: socket.emit('joinRoom', { conversationId })
  @SubscribeMessage('joinRoom')
  async handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const userId = client.data?.userId;
    if (!userId) throw new WsException('Chưa xác thực.');

    await client.join(data.conversationId);
    this.logger.log(`📥 User ${userId} joined room ${data.conversationId}`);

    return { event: 'joinedRoom', data: { conversationId: data.conversationId } };
  }

  // ─── Event: sendMessage — gửi tin nhắn ───────────────────────────────────
  // FE gọi: socket.emit('sendMessage', { conversationId, content })
  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; content: string },
  ) {
    const userId = client.data?.userId;
    if (!userId) throw new WsException('Chưa xác thực.');

    if (!data.content?.trim()) {
      throw new WsException('Nội dung tin nhắn không được rỗng.');
    }

    const message = await this.chatService.saveMessage(
      data.conversationId,
      userId,
      data.content.trim(),
    );

    // Phát tin nhắn đến tất cả client trong phòng (bao gồm người gửi)
    this.server.to(data.conversationId).emit('newMessage', {
      id: message.id,
      conversationId: data.conversationId,
      sender: message.sender,
      content: message.message_content,
      created_at: message.created_at,
    });

    return { event: 'messageSent', data: { id: message.id } };
  }

  // ─── Event: startConversation — tạo/lấy conversation với người bán ───────
  // FE gọi: socket.emit('startConversation', { partnerId })
  // Dùng khi buyer muốn chat với seller ngay từ trang sản phẩm
  @SubscribeMessage('startConversation')
  async handleStartConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { partnerId: string },
  ) {
    const userId = client.data?.userId;
    if (!userId) throw new WsException('Chưa xác thực.');

    if (userId === data.partnerId) {
      throw new WsException('Không thể tự chat với chính mình.');
    }

    const conversation = await this.chatService.findOrCreateConversation(
      userId,
      data.partnerId,
    );

    // Tự động join room ngay sau khi tạo
    await client.join(conversation.id);

    return { event: 'conversationReady', data: { conversationId: conversation.id } };
  }
}
