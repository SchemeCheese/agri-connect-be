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
import { NegotiationService } from './negotiation.service';
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
    private readonly negotiationService: NegotiationService,
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

  // ─── Event: startConversation — join room sau khi FE đã có conversationId ─
  // Thông thường FE gọi HTTP POST /chat/initiate trước để lấy conversationId,
  // sau đó emit 'startConversation' để join room Socket.IO.
  // FE gọi: socket.emit('startConversation', { partnerId })
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
      // ConversationType.GENERAL — import thêm nếu cần
    );

    await client.join(conversation.id);

    return { event: 'conversationReady', data: { conversationId: conversation.id } };
  }

  // ─── Event: startNegotiation — Buyer khởi động đàm phán giá ───────────────────────────
  // FE gọi: socket.emit('startNegotiation', { productId, quantity })
  @SubscribeMessage('startNegotiation')
  async handleStartNegotiation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { productId: string; quantity: number },
  ) {
    const userId = client.data?.userId;
    if (!userId) throw new WsException('Chưa xác thực.');

    const result = await this.negotiationService.startNegotiation(
      userId,
      data.productId,
      data.quantity,
    );

    // Buyer tự join vào phòng
    await client.join(result.conversationId);

    // Phát tin nhắn hệ thống tới tất cả thành viên trong phòng (cả seller đang online)
    this.server.to(result.conversationId).emit('newMessage', {
      conversationId: result.conversationId,
      message_type: 'SYSTEM',
      content: `🌾 Đã bắt đầu cuộc đàm phán giá cho sản phẩm "${result.product.name}".`,
      created_at: new Date(),
    });

    // Trả về cho buyer: conversationId + thông tin sản phẩm để hiển thị
    return { event: 'negotiationStarted', data: result };
  }

  // ─── Event: sendNegotiationQuote — Seller gửi card báo giá ──────────────────────────────
  // FE gọi: socket.emit('sendNegotiationQuote', { conversationId, productId, productName, quantity, price, unit })
  @SubscribeMessage('sendNegotiationQuote')
  async handleSendNegotiationQuote(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      conversationId: string;
      productId: string;
      productName: string;
      quantity: number;
      price: number;
      unit: string;
    },
  ) {
    const userId = client.data?.userId;
    if (!userId) throw new WsException('Chưa xác thực.');

    const message = await this.negotiationService.sendQuote(userId, data);

    // Phát card báo giá đến tất cả thành viên trong phiëng
    this.server.to(data.conversationId).emit('newMessage', {
      id: message.id,
      conversationId: data.conversationId,
      sender: message.sender,
      content: message.message_content,
      message_type: message.message_type,
      quote: {
        messageId: message.id,
        productId: message.quote_product_id,
        productName: message.quote_product_name,
        quantity: Number(message.quote_quantity),
        price: Number(message.quote_price),
        unit: message.quote_unit,
        status: message.quote_status,
      },
      created_at: message.created_at,
    });

    return { event: 'quoteSent', data: { id: message.id } };
  }

  // ─── Event: respondToQuote — Buyer chấp nhận hoặc từ chối báo giá ────────────────────
  // FE gọi: socket.emit('respondToQuote', { messageId, action: 'ACCEPTED' | 'REJECTED' })
  @SubscribeMessage('respondToQuote')
  async handleRespondToQuote(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { messageId: string; action: 'ACCEPTED' | 'REJECTED'; conversationId: string },
  ) {
    const userId = client.data?.userId;
    if (!userId) throw new WsException('Chưa xác thực.');

    const result = await this.negotiationService.respondToQuote(userId, data.messageId, data.action);

    // Thông báo trạng thái báo giá cập nhật đến cả 2 bên
    this.server.to(data.conversationId).emit('quoteUpdated', {
      messageId: data.messageId,
      status: result.status,
    });

    // Nếu chấp nhận → gửi thêm sự kiện riêng cho buyer để redirect sang checkout
    if (result.status === 'ACCEPTED' && result.checkoutData) {
      client.emit('negotiationAccepted', { checkoutData: result.checkoutData });
    }

    return { event: 'quoteResponded', data: { status: result.status } };
  }

  // ─── Event: cancelNegotiation — Hủy cuộc đàm phán (cả 2 bên) ───────────────────────────
  // FE gọi: socket.emit('cancelNegotiation', { conversationId })
  @SubscribeMessage('cancelNegotiation')
  async handleCancelNegotiation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const userId = client.data?.userId;
    if (!userId) throw new WsException('Chưa xác thực.');

    const message = await this.negotiationService.cancelNegotiation(userId, data.conversationId);

    this.server.to(data.conversationId).emit('newMessage', {
      id: message.id,
      conversationId: data.conversationId,
      sender: message.sender,
      content: message.message_content,
      message_type: message.message_type,
      created_at: message.created_at,
    });

    this.server.to(data.conversationId).emit('negotiationCancelled', {
      conversationId: data.conversationId,
    });

    return { event: 'negotiationCancelled' };
  }
}
