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
import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { AIAssistantService } from './services/ai-assistant.service';
import { AskQuestionDto } from './dtos/ask-question.dto';
import { AIMode } from '@prisma/client';

/**
 * Separate namespace /ai-chat keeps AI traffic isolated from /chat.
 * Reuses the same JWT auth pattern as ChatGateway.
 */
@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/ai-chat',
  // socket.io mặc định giới hạn payload 1MB — quá nhỏ cho ảnh base64 trong
  // ai:ask (vượt limit là server tự ngắt kết nối). 16MB khớp MaxLength của DTO.
  maxHttpBufferSize: 16 * 1024 * 1024,
})
export class AIAssistantGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AIAssistantGateway.name);
  private readonly connectedUsers = new Map<string, string>(); // userId → socketId

  constructor(
    private readonly jwtService: JwtService,
    private readonly aiService: AIAssistantService,
  ) {}

  // ── Connection lifecycle ────────────────────────────────────────────────────

  async handleConnection(client: Socket) {
    try {
      const rawToken =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization ||
        '';
      const token = rawToken.replace('Bearer ', '').trim();
      if (!token) throw new Error('No token');

      const payload = this.jwtService.verify(token, {
        secret: process.env.JWT_SECRET ?? 'secretKeyCuaBan',
      });

      client.data.userId = payload.sub;
      client.data.userRole = { is_buyer: payload.is_buyer, is_seller: payload.is_seller };
      this.connectedUsers.set(payload.sub, client.id);

      this.logger.log(`[AI-CHAT] Connected: ${payload.sub}`);
    } catch (err) {
      client.emit('ai:error', { code: 'AUTH_FAILED', message: 'Xác thực thất bại.' });
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = client.data?.userId;
    if (userId) {
      this.connectedUsers.delete(userId);
      this.logger.log(`[AI-CHAT] Disconnected: ${userId}`);
    }
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  /**
   * Client creates/resumes an AI session before asking.
   * FE can pre-create when user opens a product page for lower first-response latency.
   *
   * Event: ai:new_session
   * Payload: { mode: 'BUYER'|'SELLER', context?: { productId?, shopId? } }
   */
  @SubscribeMessage('ai:new_session')
  async handleNewSession(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { mode: AIMode; context?: { productId?: string; shopId?: string } },
  ) {
    const userId = this.requireAuth(client);

    // Pre-warm: just creating the session here is enough.
    // When ai:ask arrives it will reuse this session via sessionId.
    const askDto: AskQuestionDto = {
      content: '__init__',
      mode: data.mode ?? AIMode.BUYER,
      context: data.context,
    };

    // We only need a session — call getOrCreate directly via service is overkill for gateway.
    // Return a placeholder; the actual session is created on first ai:ask.
    client.emit('ai:session_created', { sessionId: null, mode: data.mode });
    return { event: 'ai:session_ready' };
  }

  /**
   * Main event. Client asks a question.
   *
   * Event: ai:ask
   * Payload: { content, sessionId?, mode, context?, imageBase64?, imageMimeType? }
   *
   * Server emits (in order):
   *   ai:thinking       — immediately, shows typing indicator
   *   ai:token chunks   — streamed tokens
   *   ai:complete       — done, includes sessionId + intent
   *   ai:error          — on failure
   */
  @SubscribeMessage('ai:ask')
  async handleAsk(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: AskQuestionDto,
  ) {
    const userId = this.requireAuth(client);
    this.logger.log(
      `[AI-CHAT] ai:ask user=${userId} mode=${data?.mode} sessionId=${data?.sessionId ?? '∅'} image=${data?.imageBase64 ? 'yes' : 'no'} content="${(data?.content ?? '').slice(0, 60)}"`,
    );

    // Emit thinking immediately — user sees indicator before any LLM call
    client.emit('ai:thinking', { sessionId: data.sessionId ?? null });

    try {
      const result = await this.aiService.ask(userId, data);

      // Stream tokens to client — phân biệt text chunk vs tool status vs actionable data
      let tokenCount = 0;
      for await (const chunk of result.stream) {
        if (!client.connected) break;
        if (typeof chunk === 'object' && chunk !== null && (chunk as any).__tool_status__) {
          const status = chunk as { toolName: string; label: string };
          client.emit('ai:tool_start', {
            sessionId: result.sessionId,
            toolName: status.toolName,
            label: status.label,
          });
        } else if (typeof chunk === 'object' && chunk !== null && (chunk as any).__actionable_data__) {
          // Entity cards từ tool result — FE render product/shop card clickable
          const evt = chunk as { type: 'products' | 'shops'; data: any[] };
          this.emitActionableData(client.id, evt.type, evt.data, result.sessionId);
        } else {
          client.emit('ai:token', {
            chunk,
            sessionId: result.sessionId,
          });
          tokenCount++;
        }
      }

      this.logger.log(`[AI-CHAT] ai:complete user=${userId} session=${result.sessionId} tokens=${tokenCount}`);
      client.emit('ai:complete', {
        sessionId: result.sessionId,
        intent: result.intent,
      });
    } catch (err: any) {
      this.logger.error(`[AI-CHAT] Error user=${userId}: ${err?.message}`, err?.stack);
      // Phân loại lỗi: thiếu API key vs lỗi runtime để FE hiển thị message rõ ràng
      const raw = err?.message ?? '';
      const isAuthErr = /401|api[\s-]?key|unauthorized/i.test(raw);
      client.emit('ai:error', {
        code: isAuthErr ? 'CONFIG_ERROR' : 'INTERNAL_ERROR',
        message: isAuthErr
          ? 'Trợ lý AI chưa cấu hình đúng (GROQ_API_KEY). Liên hệ admin.'
          : `Lỗi xử lý: ${raw.slice(0, 200) || 'Vui lòng thử lại'}`,
      });
    }

    return { event: 'ai:ask_received' };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Đẩy entity cards (sản phẩm/shop từ tool result) về 1 client cụ thể.
   * socket.io v4: mỗi socket tự join room trùng tên socket.id → server.to(clientId)
   * nhắm đúng client đó trong namespace /ai-chat.
   *
   * Event: ai:actionable_data
   * Payload: { type: 'products'|'shops', data: [...], sessionId? }
   */
  emitActionableData(
    clientId: string,
    type: 'products' | 'shops',
    data: any[],
    sessionId?: string,
  ) {
    if (!Array.isArray(data) || data.length === 0) return;
    this.server.to(clientId).emit('ai:actionable_data', { type, data, sessionId: sessionId ?? null });
  }

  private requireAuth(client: Socket): string {
    const userId = client.data?.userId;
    if (!userId) throw new WsException('Chưa xác thực.');
    return userId as string;
  }
}
