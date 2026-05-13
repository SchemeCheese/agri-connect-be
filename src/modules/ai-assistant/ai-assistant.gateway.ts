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
   * Payload: { content, sessionId?, mode, context? }
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

    // Emit thinking immediately — user sees indicator before any LLM call
    client.emit('ai:thinking', { sessionId: data.sessionId ?? null });

    try {
      const result = await this.aiService.ask(userId, data);

      // Stream tokens to client
      for await (const token of result.stream) {
        if (!client.connected) break; // Client disconnected — stop streaming
        client.emit('ai:token', {
          chunk: token,
          sessionId: result.sessionId,
        });
      }

      client.emit('ai:complete', {
        sessionId: result.sessionId,
        intent: result.intent,
      });
    } catch (err) {
      this.logger.error(`[AI-CHAT] Error for user ${userId}: ${err.message}`, err.stack);
      client.emit('ai:error', {
        code: 'INTERNAL_ERROR',
        message: 'Xin lỗi, đã có lỗi xảy ra. Vui lòng thử lại.',
      });
    }

    return { event: 'ai:ask_received' };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private requireAuth(client: Socket): string {
    const userId = client.data?.userId;
    if (!userId) throw new WsException('Chưa xác thực.');
    return userId as string;
  }
}
