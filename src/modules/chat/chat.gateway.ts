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
import { Logger, UsePipes } from '@nestjs/common';
import { wsValidationPipe } from '../../common/pipes/ws-validation.pipe';
import { SendMessageDto } from './dtos/send-message.dto';
import { SendNegotiationQuoteDto } from './dtos/send-negotiation-quote.dto';
import { RespondToQuoteDto } from './dtos/respond-to-quote.dto';
import { JoinRoomDto } from './dtos/join-room.dto';
import { SendImageMessageDto } from './dtos/send-image-message.dto';
import { StartConversationDto } from './dtos/start-conversation.dto';
import { StartNegotiationDto } from './dtos/start-negotiation.dto';
import { CancelNegotiationDto } from './dtos/cancel-negotiation.dto';

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
      client.data.userRole = { is_buyer: payload.is_buyer, is_seller: payload.is_seller };
      client.data.userName = payload.email;
      // Cache conversation đã verify membership trong vòng đời socket
      client.data.memberOf = new Set<string>();

      this.connectedUsers.set(payload.sub, client.id);
      // Personal room cho mỗi user — server emit unreadUpdated tới `user:${id}` không phụ thuộc conversation
      await client.join(`user:${payload.sub}`);
      this.logger.log(`✅ [CONNECT] User ${payload.sub} (${client.id})`);
    } catch (err) {
      this.logger.warn(`❌ [CONNECT FAILED] ${client.id} — ${err.message}`);
      client.emit('error', { message: 'Xác thực thất bại. Vui lòng đăng nhập lại.' });
      client.disconnect();
    }
  }

  // ─── Helper: assert + cache membership trên socket ───────────────────────
  private async ensureMember(client: Socket, conversationId: string) {
    const userId = client.data?.userId;
    if (!userId) throw new WsException('Chưa xác thực.');
    if (!conversationId) throw new WsException('Thiếu conversationId.');

    const cache: Set<string> = client.data.memberOf ?? new Set<string>();
    if (cache.has(conversationId)) return userId;

    try {
      await this.chatService.assertMembership(conversationId, userId);
    } catch (err: any) {
      // Chuẩn hóa lỗi NestHttpException -> WsException
      throw new WsException(err?.message || 'Không có quyền truy cập cuộc trò chuyện.');
    }
    cache.add(conversationId);
    client.data.memberOf = cache;
    return userId;
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
  @UsePipes(wsValidationPipe)
  async handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: JoinRoomDto,
  ) {
    const userId = await this.ensureMember(client, data.conversationId);

    await client.join(data.conversationId);
    this.logger.log(`📥 User ${userId} joined room ${data.conversationId}`);

    // Khi user join room → coi như đã đọc tất cả tin nhắn cũ trong room
    try {
      await this.chatService.markAsRead(data.conversationId, userId);
      const total = await this.chatService.getUnreadTotal(userId);
      this.server.to(`user:${userId}`).emit('unreadUpdated', {
        conversationId: data.conversationId,
        unread: 0,
        totalUnread: total,
      });
    } catch (err) {
      this.logger.warn(`[joinRoom] markAsRead failed: ${(err as any)?.message}`);
    }

    return { event: 'joinedRoom', data: { conversationId: data.conversationId } };
  }

  // Helper: emit unreadUpdated cho 1 user (sau khi recipient nhận tin nhắn mới)
  private async emitUnreadFor(conversationId: string, userId: string) {
    try {
      const [unread, total] = await Promise.all([
        this.chatService.getUnreadCount(conversationId, userId),
        this.chatService.getUnreadTotal(userId),
      ]);
      this.server.to(`user:${userId}`).emit('unreadUpdated', {
        conversationId,
        unread,
        totalUnread: total,
      });
    } catch (err) {
      this.logger.warn(`[emitUnreadFor] ${(err as any)?.message}`);
    }
  }


  // ─── Event: sendMessage — gửi tin nhắn ───────────────────────────────────
  // FE gọi: socket.emit('sendMessage', { conversationId, content })
  @SubscribeMessage('sendMessage')
  @UsePipes(wsValidationPipe)
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SendMessageDto,
  ) {
    const userId = await this.ensureMember(client, data.conversationId);

    const message = await this.chatService.saveMessage(
      data.conversationId,
      userId,
      data.content.trim(),
      data.clientMessageId,
    );

    // Phát tin nhắn đến tất cả client trong phòng (bao gồm người gửi)
    // Shape phải khớp với getMessages response — FE dùng chung model
    // client_message_id cho phép FE map echo với optimistic UI và bỏ tin gửi trùng
    this.server.to(data.conversationId).emit('newMessage', {
      id: message.id,
      conversationId: data.conversationId,
      sender: message.sender,
      message_content: message.message_content,
      message_type: message.message_type,
      context_product: null,
      proposed_quantity: null,
      proposed_price: null,
      quote: null,
      client_message_id: (message as any).client_message_id ?? data.clientMessageId ?? null,
      created_at: message.created_at,
    });

    // Tăng unread cho recipient (ngay cả khi họ đang offline — emit dù sao vẫn không sao)
    const recipientId = await this.chatService.getOtherParticipant(data.conversationId, userId);
    if (recipientId) void this.emitUnreadFor(data.conversationId, recipientId);

    return { event: 'messageSent', data: { id: message.id, clientMessageId: data.clientMessageId } };
  }

  // ─── Event: sendImageMessage — gửi tin nhắn ảnh ──────────────────────────
  // Flow: FE gọi POST /chat/upload-image trước → nhận imageUrl → emit event này
  // FE gọi: socket.emit('sendImageMessage', { conversationId, imageUrl, caption?, clientMessageId? })
  @SubscribeMessage('sendImageMessage')
  @UsePipes(wsValidationPipe)
  async handleSendImageMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SendImageMessageDto,
  ) {
    const userId = await this.ensureMember(client, data.conversationId);

    const message = await this.chatService.saveImageMessage(
      data.conversationId,
      userId,
      data.imageUrl,
      data.caption,
      data.clientMessageId,
    );

    this.server.to(data.conversationId).emit('newMessage', {
      id: message.id,
      conversationId: data.conversationId,
      sender: message.sender,
      message_content: message.message_content,
      message_type: message.message_type,
      image_url: (message as any).image_url ?? data.imageUrl,
      context_product: null,
      proposed_quantity: null,
      proposed_price: null,
      quote: null,
      client_message_id: (message as any).client_message_id ?? data.clientMessageId ?? null,
      created_at: message.created_at,
    });

    const recipientIdForImg = await this.chatService.getOtherParticipant(data.conversationId, userId);
    if (recipientIdForImg) void this.emitUnreadFor(data.conversationId, recipientIdForImg);

    return { event: 'imageSent', data: { id: message.id, clientMessageId: data.clientMessageId } };
  }

  // ─── Event: startConversation — join room sau khi FE đã có conversationId ─
  // FE gọi POST /chat/initiate trước (HTTP) để lấy conversationId,
  // sau đó mới emit 'startConversation' để join Socket.IO room.
  // FE gọi: socket.emit('startConversation', { partnerId })
  @SubscribeMessage('startConversation')
  @UsePipes(wsValidationPipe)
  async handleStartConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: StartConversationDto,
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

    await client.join(conversation.id);

    return { event: 'conversationReady', data: { conversationId: conversation.id } };
  }

  // ─── Event: startNegotiation — Buyer khởi động đàm phán giá ───────────────────────────
  // FE gọi: socket.emit('startNegotiation', { productId, quantity, proposedPrice })
  @SubscribeMessage('startNegotiation')
  @UsePipes(wsValidationPipe)
  async handleStartNegotiation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: StartNegotiationDto,
  ) {
    const userId = client.data?.userId;
    if (!userId) throw new WsException('Chưa xác thực.');

    this.logger.debug(`🤝 [startNegotiation] handleStartNegotiation entered`);
    this.logger.debug(`🤝 [startNegotiation] raw payload=${JSON.stringify(data)}`);
    this.logger.debug(`🤝 [startNegotiation] validation passed`);
    this.logger.debug(
      `🤝 [startNegotiation] current userId=${userId} productId=${data.productId} quantity=${data.quantity} proposedPrice=${data.proposedPrice}`,
    );

    this.logger.debug(`🤝 [startNegotiation] negotiationService.startNegotiation called`);
    const result = await this.negotiationService.startNegotiation(
      userId,
      data.productId,
      data.quantity,
      data.proposedPrice,
    );

    this.logger.debug(
      `🤝 [startNegotiation] ChatMessage created id=${result.systemMessage.id} type=${result.systemMessage.message_type} conversationId=${result.conversationId}`,
    );

    // Buyer tự join vào phòng
    await client.join(result.conversationId);

    // Phát SYSTEM message đã lưu — đúng shape như getMessages, seller thấy ngay
    this.server.to(result.conversationId).emit('newMessage', {
      id: result.systemMessage.id,
      conversationId: result.conversationId,
      sender: { id: userId, full_name: null },
      message_content: result.systemMessage.message_content,
      message_type: result.systemMessage.message_type,
      context_product: {
        id: result.product.id,
        name: result.product.name,
        reference_price: result.product.reference_price,
        unit: result.product.unit,
        min_negotiation_qty: result.product.min_negotiation_qty,
        image: result.product.image,
      },
      proposed_quantity: result.systemMessage.proposed_quantity,
      proposed_price: result.systemMessage.proposed_price,
      quote: null,
      created_at: result.systemMessage.created_at,
    });

    // Trả về cho buyer: conversationId + thông tin sản phẩm + giá đề xuất
    return { event: 'negotiationStarted', data: result };
  }

  // ─── Event: sendNegotiationQuote — Seller gửi card báo giá ──────────────────────────────
  // FE gọi: socket.emit('sendNegotiationQuote', { conversationId, productId, productName, quantity, price, unit })
  @SubscribeMessage('sendNegotiationQuote')
  @UsePipes(wsValidationPipe)
  async handleSendNegotiationQuote(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SendNegotiationQuoteDto,
  ) {
    const userId = await this.ensureMember(client, data.conversationId);

    const message = await this.negotiationService.sendQuote(userId, data);

    // Phát card báo giá đến tất cả thành viên trong phòng
    this.server.to(data.conversationId).emit('newMessage', {
      id: message.id,
      conversationId: data.conversationId,
      sender: message.sender,
      message_content: message.message_content,
      message_type: message.message_type,
      context_product: null,
      proposed_quantity: null,
      proposed_price: null,
      quote: {
        // messageId trong nested quote dùng để FE gọi respondToQuote chính xác
        // (extractQuote ưu tiên msg.quote nên nếu thiếu field này => undefined)
        messageId: message.id,
        productId: message.quote_product_id,
        productName: message.quote_product_name,
        quantity: message.quote_quantity ? Number(message.quote_quantity) : null,
        price: message.quote_price ? Number(message.quote_price) : null,
        unit: message.quote_unit,
        status: message.quote_status,
      },
      created_at: message.created_at,
    });

    return { event: 'quoteSent', data: { id: message.id } };
  }

  // ─── Event: respondToQuote — Buyer chấp nhận hoặc từ chối báo giá ────────────────────
  // FE gọi: socket.emit('respondToQuote', { messageId, action: 'ACCEPTED' | 'REJECTED', conversationId })
  @SubscribeMessage('respondToQuote')
  @UsePipes(wsValidationPipe)
  async handleRespondToQuote(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: RespondToQuoteDto,
  ) {
    const userId = await this.ensureMember(client, data.conversationId);

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
  @UsePipes(wsValidationPipe)
  async handleCancelNegotiation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: CancelNegotiationDto,
  ) {
    const userId = await this.ensureMember(client, data.conversationId);

    const message = await this.negotiationService.cancelNegotiation(userId, data.conversationId);

    this.server.to(data.conversationId).emit('newMessage', {
      id: message.id,
      conversationId: data.conversationId,
      sender: message.sender,
      message_content: message.message_content,
      message_type: message.message_type,
      context_product: null,
      proposed_quantity: null,
      proposed_price: null,
      quote: null,
      created_at: message.created_at,
    });

    this.server.to(data.conversationId).emit('negotiationCancelled', {
      conversationId: data.conversationId,
    });

    return { event: 'negotiationCancelled' };
  }
}
