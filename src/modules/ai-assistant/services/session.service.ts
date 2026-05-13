import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AIMode, AIRole, Prisma } from '@prisma/client';
import { DatabaseService } from '../../../database/database.service';
import { LLMMessage } from '../providers/llm.interface';

const SLIDING_WINDOW = 8;
const SUMMARIZE_THRESHOLD = 12;

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(private readonly db: DatabaseService) {}

  async getOrCreate(
    userId: string,
    sessionId: string | undefined,
    mode: AIMode,
    context?: Prisma.InputJsonValue,
  ) {
    if (sessionId) {
      const existing = await this.db.aISession.findFirst({
        where: { id: sessionId, user_id: userId },
        include: { messages: { orderBy: { created_at: 'asc' } } },
      });
      if (existing) return existing;
      // Session ID provided but not found — create fresh (handles stale FE state)
    }

    return this.db.aISession.create({
      data: { user_id: userId, mode, context: context ?? Prisma.JsonNull },
      include: { messages: true },
    });
  }

  /**
   * Returns messages formatted for the LLM context window.
   * Keeps only the sliding window of recent messages.
   * If a session summary exists, prepends it as a system message.
   */
  buildContextMessages(
    session: { summary: string | null; messages: Array<{ role: AIRole; content: string }> },
  ): LLMMessage[] {
    const messages: LLMMessage[] = [];

    if (session.summary) {
      messages.push({
        role: 'user',
        content: `[Tóm tắt cuộc trò chuyện trước: ${session.summary}]`,
      });
      messages.push({
        role: 'assistant',
        content: 'Đã ghi nhận. Tiếp tục hỗ trợ bạn.',
      });
    }

    const recent = session.messages.slice(-SLIDING_WINDOW);
    for (const msg of recent) {
      messages.push({
        role: msg.role === AIRole.USER ? 'user' : 'assistant',
        content: msg.content,
      });
    }

    return messages;
  }

  async saveUserMessage(
    sessionId: string,
    content: string,
    intent?: string,
  ) {
    return this.db.aIMessage.create({
      data: {
        session_id: sessionId,
        role: AIRole.USER,
        content,
        intent,
      },
    });
  }

  async saveAssistantMessage(
    sessionId: string,
    content: string,
    opts: {
      intent?: string;
      tokensUsed?: number;
      modelUsed?: string;
      toolsCalled?: string[];
    },
  ) {
    const [message] = await this.db.$transaction([
      this.db.aIMessage.create({
        data: {
          session_id: sessionId,
          role: AIRole.ASSISTANT,
          content,
          intent: opts.intent,
          tokens_used: opts.tokensUsed,
          model_used: opts.modelUsed,
          tools_called: opts.toolsCalled ?? [],
        },
      }),
      this.db.aISession.update({
        where: { id: sessionId },
        data: { total_tokens_used: { increment: opts.tokensUsed ?? 0 } },
      }),
    ]);

    await this.maybeSummarize(sessionId);
    return message;
  }

  /**
   * Triggers summarization when message count exceeds SUMMARIZE_THRESHOLD.
   * Summarization itself is handled by AIAssistantService to avoid circular dependency.
   * Here we just flag the session — actual summary written by the orchestrator.
   */
  async getMessageCount(sessionId: string): Promise<number> {
    return this.db.aIMessage.count({ where: { session_id: sessionId } });
  }

  async writeSummary(sessionId: string, summary: string): Promise<void> {
    await this.db.aISession.update({
      where: { id: sessionId },
      data: { summary },
    });
  }

  async getSessionForUser(sessionId: string, userId: string) {
    const session = await this.db.aISession.findFirst({
      where: { id: sessionId, user_id: userId },
      include: {
        messages: { orderBy: { created_at: 'asc' }, take: 50 },
      },
    });
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  async getUserSessions(userId: string) {
    return this.db.aISession.findMany({
      where: { user_id: userId },
      orderBy: { updated_at: 'desc' },
      take: 20,
      select: {
        id: true,
        mode: true,
        context: true,
        total_tokens_used: true,
        created_at: true,
        updated_at: true,
        _count: { select: { messages: true } },
      },
    });
  }

  private async maybeSummarize(sessionId: string): Promise<void> {
    const count = await this.getMessageCount(sessionId);
    if (count > SUMMARIZE_THRESHOLD) {
      // Signal to service layer — actual summarization call happens in AIAssistantService
      this.logger.log(`Session ${sessionId} has ${count} messages — summarization needed`);
    }
  }
}
