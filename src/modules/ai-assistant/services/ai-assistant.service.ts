import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIMode, Prisma } from '@prisma/client';
import { DatabaseService } from '../../../database/database.service';
import { AskQuestionDto } from '../dtos/ask-question.dto';
import { LLM_PROVIDER } from '../providers/llm.interface';
import type {
  ILLMProvider,
  LLMConversationMessage,
  LLMMessage,
  LLMToolCallMessage,
  LLMToolResultMessage,
} from '../providers/llm.interface';
import { buildSystemPrompt, SystemPromptContext } from '../prompts/system.prompt';
import { BUYER_FAQ_CACHE } from '../prompts/buyer.prompt';
import { SELLER_FAQ_CACHE } from '../prompts/seller.prompt';
import { InputSanitizer } from '../security/input-sanitizer';
import { OutputValidator } from '../security/output-validator';
import { IntentClassifierService } from './intent-classifier.service';
import { SessionService } from './session.service';
import { RateLimitService } from './rate-limit.service';
import { IntentLabel } from '../prompts/intent-classifier.prompt';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { AGRI_TOOLS } from '../tools/tool-registry';
import { TOOL_WHITELIST, ToolExecutionContext, ToolName, MAX_TOOL_ROUNDS } from '../tools/types';

const REASONING_MODEL = 'llama-3.3-70b-versatile';
const FAST_MODEL = 'llama-3.1-8b-instant';

const COMPLEX_INTENTS: IntentLabel[] = ['PRICE_ANALYSIS', 'NEGOTIATION_SUPPORT'];

// Intents that must use tool calling to retrieve live data
const TOOL_REQUIRED_INTENTS: IntentLabel[] = [
  'PRODUCT_SEARCH',
  'PRICE_ANALYSIS',
  'NEGOTIATION_SUPPORT',
  'SELLER_RECOMMENDATION',
];

const OFF_TOPIC_RESPONSE =
  'Tôi chỉ có thể hỗ trợ nghiệp vụ giao dịch nông sản trên Agri-Connect. ' +
  'Bạn có muốn tôi giúp gì về sản phẩm, giá cả, thương lượng, hoặc quy trình mua bán không?';

const INJECTION_RESPONSE =
  'Yêu cầu của bạn không thể được xử lý. Tôi chỉ hỗ trợ các nghiệp vụ giao dịch nông sản.';

export interface AskResult {
  sessionId: string;
  intent: IntentLabel;
  stream: AsyncGenerator<string>;
}

@Injectable()
export class AIAssistantService {
  private readonly logger = new Logger(AIAssistantService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: ILLMProvider,
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly sanitizer: InputSanitizer,
    private readonly outputValidator: OutputValidator,
    private readonly intentClassifier: IntentClassifierService,
    private readonly sessionService: SessionService,
    private readonly rateLimitService: RateLimitService,
    private readonly toolExecutor: ToolExecutorService,
  ) {}

  async ask(userId: string, dto: AskQuestionDto): Promise<AskResult> {
    // ── 1. Rate limit ────────────────────────────────────────────────────────
    const rateCheck = this.rateLimitService.checkRequestLimit(userId);
    if (!rateCheck.allowed) {
      return this.staticResponse('', 'OFF_TOPIC', rateCheck.reason!);
    }

    // ── 2. Input sanitization ────────────────────────────────────────────────
    const sanitized = this.sanitizer.sanitize(dto.content);
    if (sanitized.blocked) {
      const msg =
        sanitized.reason === 'injection'
          ? INJECTION_RESPONSE
          : sanitized.reason === 'too_long'
            ? 'Tin nhắn quá dài. Vui lòng giới hạn trong 500 ký tự.'
            : 'Tin nhắn không hợp lệ.';
      return this.staticResponse('', 'OFF_TOPIC', msg);
    }

    // ── 3. Session ───────────────────────────────────────────────────────────
    const session = await this.sessionService.getOrCreate(
      userId,
      dto.sessionId,
      dto.mode,
      dto.context as Prisma.InputJsonValue,
    );

    // ── 4. Static FAQ cache — bypass LLM entirely ────────────────────────────
    const faqHit = this.checkFaqCache(sanitized.sanitized, dto.mode);
    if (faqHit) {
      await this.sessionService.saveUserMessage(session.id, sanitized.sanitized, 'FAQ');
      await this.sessionService.saveAssistantMessage(session.id, faqHit, {
        intent: 'FAQ',
        modelUsed: 'static-cache',
      });
      return this.staticResponse(session.id, 'FAQ', faqHit);
    }

    // ── 5. Intent classification ─────────────────────────────────────────────
    const intent = await this.intentClassifier.classify(sanitized.sanitized);

    if (intent === 'OFF_TOPIC') {
      await this.sessionService.saveUserMessage(session.id, sanitized.sanitized, 'OFF_TOPIC');
      await this.sessionService.saveAssistantMessage(session.id, OFF_TOPIC_RESPONSE, {
        intent: 'OFF_TOPIC',
        modelUsed: 'none',
      });
      return this.staticResponse(session.id, 'OFF_TOPIC', OFF_TOPIC_RESPONSE);
    }

    // ── 6. Build LLM context ─────────────────────────────────────────────────
    const userContext = await this.buildUserContext(userId, dto.mode, dto.context?.productId);
    const systemPrompt = buildSystemPrompt(userContext);
    const historyMessages = this.sessionService.buildContextMessages(session);

    const messages: LLMConversationMessage[] = [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
      { role: 'user', content: sanitized.sanitized },
    ];

    const model = COMPLEX_INTENTS.includes(intent) ? REASONING_MODEL : FAST_MODEL;
    const useTools = TOOL_REQUIRED_INTENTS.includes(intent);

    // ── 7. Save user message before streaming ────────────────────────────────
    await this.sessionService.saveUserMessage(session.id, sanitized.sanitized, intent);

    // ── 8. Return streaming generator ────────────────────────────────────────
    const toolCtx: ToolExecutionContext = { userId, sessionId: session.id };
    const stream = useTools
      ? this.streamWithToolLoop(session.id, messages, model, intent, toolCtx)
      : this.streamAndSave(session.id, messages, model, intent);

    return { sessionId: session.id, intent, stream };
  }

  /**
   * Tool-calling orchestration:
   * 1. completeWithTools() to detect which tools the LLM wants
   * 2. Execute tools (parallel, with timeout + caching)
   * 3. Repeat up to MAX_TOOL_ROUNDS
   * 4. stream() for the final human-readable answer
   */
  private async *streamWithToolLoop(
    sessionId: string,
    initialMessages: LLMConversationMessage[],
    model: string,
    intent: IntentLabel,
    ctx: ToolExecutionContext,
  ): AsyncGenerator<string> {
    const workingMessages: LLMConversationMessage[] = [...initialMessages];
    const toolsCalled: string[] = [];
    // Whitelist các entity được phép xuất hiện trong câu trả lời — extract từ tool result
    const validEntities = new Set<string>();
    let totalToolItems = 0;

    // Tool detection + execution loop (non-streaming)
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let toolResponse: Awaited<ReturnType<ILLMProvider['completeWithTools']>>;
      try {
        toolResponse = await this.llm.completeWithTools({
          model,
          messages: workingMessages,
          tools: AGRI_TOOLS,
          maxTokens: 256,
          temperature: 0.1,
        });
      } catch (err) {
        this.logger.warn(`Tool detection failed (round ${round + 1}): ${(err as Error).message}`);
        break;
      }

      if (toolResponse.finishReason !== 'tool_calls' || toolResponse.toolCalls.length === 0) {
        break; // LLM decided no more tools needed
      }

      // Security: filter to whitelist only
      const allowedCalls = toolResponse.toolCalls.filter((tc) =>
        TOOL_WHITELIST.has(tc.function.name as ToolName),
      );
      if (allowedCalls.length === 0) {
        this.logger.warn('All tool calls blocked by whitelist');
        break;
      }

      // Append assistant's tool-call decision to conversation history
      const assistantToolMsg: LLMToolCallMessage = {
        role: 'assistant',
        content: null,
        tool_calls: allowedCalls,
      };
      workingMessages.push(assistantToolMsg);

      // Execute tools in parallel
      const outcomes = await this.toolExecutor.executeAll(allowedCalls, ctx);

      for (const outcome of outcomes) {
        toolsCalled.push(outcome.toolName);
        const toolResultMsg: LLMToolResultMessage = {
          role: 'tool',
          tool_call_id: outcome.callId,
          content: JSON.stringify(outcome.result),
        };
        workingMessages.push(toolResultMsg);

        // Extract entity names từ tool output để build whitelist
        const items = this.extractEntities(outcome.result);
        for (const name of items) validEntities.add(name);
        totalToolItems += items.length;
      }

      this.logger.log(
        `Tool round ${round + 1}: called [${outcomes.map((o) => o.toolName).join(', ')}], entities=${validEntities.size}`,
      );
    }

    // Grounding reminder — list entity hợp lệ explicit
    const groundingContent = validEntities.size > 0
      ? `[GROUNDING — STRICT]
Chỉ được nhắc đến các tên sau trong câu trả lời (chính xác đến từng ký tự):
${[...validEntities].map((e) => `- ${e}`).join('\n')}

TUYỆT ĐỐI KHÔNG:
- Thêm tên cửa hàng/sản phẩm/seller nào KHÔNG có trong danh sách trên
- Bịa số điện thoại, địa chỉ đường phố, mã bưu chính, fax
- Thêm thông tin "đánh giá: 4.X/5" nếu tool không trả về stats
- Suy luận giá từ kiến thức bên ngoài

Nếu user hỏi về thứ KHÔNG có trong danh sách → trả lời:
"Hệ thống chưa có dữ liệu phù hợp. Bạn có thể thử từ khóa khác hoặc xem trực tiếp tại mục Cửa hàng."`
      : `[GROUNDING — NO DATA]
Tool đã chạy nhưng không trả về kết quả nào. PHẢI trả lời ĐÚNG MẪU:
"Hệ thống chưa có dữ liệu cho yêu cầu này. Bạn có thể thử với từ khóa khác hoặc xem danh sách tại mục Cửa hàng/Sản phẩm."

KHÔNG được:
- Liệt kê bất kỳ tên cửa hàng nào (vì không có data → 100% bịa)
- Đề xuất "thường thì có thể là..." / "giá thị trường khoảng..."
- Dùng kiến thức chung về nông sản`;

    workingMessages.push({ role: 'system', content: groundingContent });

    // Final streaming answer: synthesize from all tool results
    yield* this.streamAndSave(sessionId, workingMessages, model, intent, toolsCalled, {
      validEntities,
      toolItemCount: totalToolItems,
    });
  }

  /**
   * Extract entity names (store_name, product name, seller name) từ tool result
   * để build whitelist chống hallucination.
   */
  private extractEntities(result: any): string[] {
    if (!result) return [];
    const data = result?.data ?? result;
    const items = Array.isArray(data) ? data : [];
    const names: string[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      // SellerScore.store_name | Product.name | misc
      if (typeof item.store_name === 'string' && item.store_name.trim()) names.push(item.store_name.trim());
      if (typeof item.name === 'string' && item.name.trim()) names.push(item.name.trim());
      if (typeof item.full_name === 'string' && item.full_name.trim()) names.push(item.full_name.trim());
      // top_products lồng trong seller
      if (Array.isArray(item.top_products)) {
        for (const p of item.top_products) {
          if (typeof p?.name === 'string' && p.name.trim()) names.push(p.name.trim());
        }
      }
    }
    return names;
  }

  /**
   * Streams tokens from LLM, validates output, persists to DB.
   * Used for both direct responses (no tools) and tool synthesis.
   */
  private async *streamAndSave(
    sessionId: string,
    messages: LLMConversationMessage[],
    model: string,
    intent: IntentLabel,
    toolsCalled: string[] = [],
    validation?: { validEntities: Set<string>; toolItemCount: number },
  ): AsyncGenerator<string> {
    let fullContent = '';
    const maxTokens = this.config.get<number>('AI_MAX_TOKENS_PER_REQUEST', 800);
    let streamError: unknown = null;

    try {
      // temperature thấp để giảm hallucination — câu trả lời cần bám tool result/context
      for await (const token of this.llm.stream({ model, messages, maxTokens, temperature: 0.3 })) {
        fullContent += token;
        yield token;
      }
    } catch (err) {
      streamError = err;
      this.logger.error(`Stream error: ${(err as Error)?.message}`, (err as Error)?.stack);
    }

    // Validate sau khi stream xong — nếu fail thì cảnh báo + thay nội dung lưu DB
    const validated = this.outputValidator.validate(fullContent, {
      validEntities: validation?.validEntities,
      intent,
    });
    if (validated !== fullContent) {
      const warning = '\n\n---\n⚠️ Thông tin trên có thể không chính xác, hệ thống đã chặn.\n' + validated;
      for (const chunk of warning.match(/.{1,40}/g) ?? []) {
        yield chunk;
      }
    }

    const finalContent = validated;
    const inputTokens = messages.reduce(
      (sum, m) =>
        sum + Math.ceil((typeof (m as LLMMessage).content === 'string' ? (m as LLMMessage).content.length : 0) / 4),
      0,
    );
    const outputTokens = Math.ceil(finalContent.length / 4);

    await this.sessionService.saveAssistantMessage(sessionId, finalContent, {
      intent,
      tokensUsed: inputTokens + outputTokens,
      modelUsed: model,
      toolsCalled,
    });

    this.rateLimitService.recordTokenUsage(sessionId, inputTokens + outputTokens);
    await this.maybeSummarize(sessionId, messages.filter((m): m is LLMMessage => m.role !== 'tool'));

    if (streamError) throw streamError;
  }

  private async maybeSummarize(sessionId: string, plainMessages: LLMMessage[]): Promise<void> {
    const count = await this.sessionService.getMessageCount(sessionId);
    if (count <= 12) return;

    try {
      const oldMessages = plainMessages.slice(1, -SLIDING_WINDOW_FOR_SUMMARY);
      if (oldMessages.length < 3) return;

      const summaryContent = oldMessages.map((m) => `${m.role}: ${m.content}`).join('\n');

      const result = await this.llm.complete({
        model: FAST_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Tóm tắt ngắn gọn trong 2-3 câu (tiếng Việt): sản phẩm đã hỏi, giá đã biết, quyết định đã đưa ra. Chỉ facts, không nhận xét.',
          },
          { role: 'user', content: summaryContent },
        ],
        maxTokens: 150,
        temperature: 0.1,
      });

      await this.sessionService.writeSummary(sessionId, result.content);
    } catch (err: unknown) {
      this.logger.warn(`Summarization failed for ${sessionId}: ${(err as Error).message}`);
    }
  }

  private async buildUserContext(
    userId: string,
    mode: AIMode,
    currentProductId?: string,
  ): Promise<SystemPromptContext> {
    const [user, behaviors, recentOrders] = await Promise.all([
      this.db.user.findUnique({ where: { id: userId }, select: { full_name: true } }),
      this.db.userBehavior.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
        take: 20,
        select: { action: true, target_id: true, metadata: true },
      }),
      this.db.order.findMany({
        where: mode === AIMode.BUYER ? { buyer_id: userId } : { seller_id: userId },
        orderBy: { created_at: 'desc' },
        take: 3,
        select: {
          status: true,
          final_total_price: true,
          order_items: {
            select: { product: { select: { name: true, category: { select: { name: true } } } } },
          },
        },
      }),
    ]);

    const viewedProductIds = behaviors
      .filter((b) => b.action === 'VIEW_PRODUCT' && b.target_id)
      .map((b) => b.target_id!)
      .slice(0, 5);

    const recentViewedProducts =
      viewedProductIds.length > 0
        ? await this.db.product
            .findMany({ where: { id: { in: viewedProductIds } }, select: { name: true } })
            .then((ps) => ps.map((p) => p.name))
        : [];

    const purchaseCategories = [
      ...new Set(
        recentOrders.flatMap((o) =>
          o.order_items.map((i) => i.product?.category?.name).filter(Boolean),
        ),
      ),
    ] as string[];

    const recentOrderSummary =
      recentOrders.length > 0
        ? recentOrders
            .map((o) => `${o.status} — ${Number(o.final_total_price).toLocaleString('vi-VN')}đ`)
            .join('; ')
        : undefined;

    let currentProductName: string | undefined;
    if (currentProductId) {
      const p = await this.db.product.findUnique({
        where: { id: currentProductId },
        select: { name: true },
      });
      currentProductName = p?.name;
    }

    return {
      userName: user?.full_name ?? 'Khách',
      userRole: mode === AIMode.BUYER ? 'BUYER' : 'SELLER',
      currentProductName,
      recentViewedProducts,
      purchaseCategories,
      recentOrderSummary,
    };
  }

  private checkFaqCache(message: string, mode: AIMode): string | null {
    const lower = message.toLowerCase();
    const cache = mode === AIMode.BUYER ? BUYER_FAQ_CACHE : SELLER_FAQ_CACHE;
    for (const [key, answer] of Object.entries(cache)) {
      if (lower.includes(key)) return answer;
    }
    return null;
  }

  private staticResponse(sessionId: string, intent: IntentLabel, message: string): AskResult {
    const stream = (async function* () {
      yield message;
    })();
    return { sessionId, intent, stream };
  }
}

const SLIDING_WINDOW_FOR_SUMMARY = 8;
