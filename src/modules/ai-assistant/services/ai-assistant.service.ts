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
import { textOfContent } from '../providers/llm.interface';
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

const REASONING_MODEL = 'gemini-2.5-flash';
const FAST_MODEL = 'gemini-2.5-flash-lite';
// Vision model cho phân tích ảnh sản phẩm. Spec gốc yêu cầu gemini-1.5-flash
// nhưng Google đã retire model đó (09/2025) — 2.5-flash là bản thay thế chính thức.
const VISION_MODEL = 'gemini-2.5-flash';

const SUGGEST_PRODUCT_PROMPT =
  'You are an agricultural expert. Analyze this image. ' +
  'Return ONLY a JSON object with: { name: string, category_name: string, ' +
  'suggested_unit: string, description: string, confidence: number }. ' +
  'All string values must be in Vietnamese. "confidence" is a number between 0 and 1. ' +
  'If the image does not show an agricultural product, return all string fields as null and confidence 0.';

const COMPLEX_INTENTS: IntentLabel[] = ['PRICE_ANALYSIS', 'NEGOTIATION_SUPPORT'];

// Intents that must use tool calling to retrieve live data or knowledge-base content.
// PLATFORM_GUIDE + FAQ go through get_platform_policy so the LLM cannot hallucinate UI steps.
const TOOL_REQUIRED_INTENTS: IntentLabel[] = [
  'PRODUCT_SEARCH',
  'PRICE_ANALYSIS',
  'NEGOTIATION_SUPPORT',
  'SELLER_RECOMMENDATION',
  'PLATFORM_GUIDE',
  'FAQ',
];

// Knowledge-base tools — their results are authoritative prose, not entity rows.
// Grounding for these is "stay faithful to tool content", not "whitelist names".
// Names here MUST match the wire name in tool-registry.ts (function.name).
const KNOWLEDGE_TOOLS = new Set<string>(['get_platform_policy']);

// Cap tool rounds for knowledge-only intents — one lookup is always enough,
// extra rounds just burn 300-800ms of FAST_MODEL latency per request.
const KNOWLEDGE_INTENT_MAX_ROUNDS = 1;

const OFF_TOPIC_RESPONSE =
  'Tôi chỉ có thể hỗ trợ nghiệp vụ giao dịch nông sản trên Agri-Connect. ' +
  'Bạn có muốn tôi giúp gì về sản phẩm, giá cả, thương lượng, hoặc quy trình mua bán không?';

const INJECTION_RESPONSE =
  'Yêu cầu của bạn không thể được xử lý. Tôi chỉ hỗ trợ các nghiệp vụ giao dịch nông sản.';

export interface AskResult {
  sessionId: string;
  intent: IntentLabel;
  stream: AsyncGenerator<string | ToolStatusEvent>;
}

/** Gợi ý sản phẩm từ ảnh — mọi field nullable để FE luôn nhận 200 kể cả khi AI fail. */
export interface ProductSuggestion {
  name: string | null;
  category_name: string | null;
  suggested_unit: string | null;
  description: string | null;
  confidence: number | null;
}

const EMPTY_SUGGESTION: ProductSuggestion = {
  name: null,
  category_name: null,
  suggested_unit: null,
  description: null,
  confidence: null,
};

// Sự kiện trạng thái gửi giữa các token để FE hiển thị "Đang ..." labels.
// Gateway phân biệt: nếu chunk có shape ToolStatusEvent → emit ai:tool_start, else ai:token.
export interface ToolStatusEvent {
  __tool_status__: true;
  toolName: string;
  label: string;
}

const TOOL_STATUS_LABELS: Record<string, string> = {
  search_products: '🔍 Đang tìm sản phẩm...',
  get_product_details: '📦 Đang lấy chi tiết sản phẩm...',
  analyze_price_trends: '📊 Đang phân tích giá...',
  recommend_sellers: '🏪 Đang tìm cửa hàng phù hợp...',
  get_negotiation_guidance: '🤝 Đang phân tích chiến lược thương lượng...',
  get_platform_policy: '📋 Đang tra cứu chính sách...',
};

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

    // ── 2b. Ảnh đính kèm (nếu có) ────────────────────────────────────────────
    // FE thường gửi nguyên data URI — strip prefix; mime ưu tiên field riêng,
    // fallback suy từ prefix. Cả 2 model (2.5-flash / flash-lite) đều multimodal.
    const imageBase64 = dto.imageBase64?.replace(/^data:[^;]+;base64,/, '');
    const imageMime =
      dto.imageMimeType ?? dto.imageBase64?.match(/^data:([^;]+);base64,/)?.[1] ?? 'image/jpeg';
    const hasImage = !!imageBase64;

    // ── 3. Session ───────────────────────────────────────────────────────────
    const session = await this.sessionService.getOrCreate(
      userId,
      dto.sessionId,
      dto.mode,
      dto.context as Prisma.InputJsonValue,
    );

    // ── 4. Static FAQ cache — bypass LLM entirely ────────────────────────────
    // Có ảnh thì không dùng cache: câu trả lời tĩnh sẽ bỏ qua nội dung ảnh.
    const faqHit = hasImage ? null : this.checkFaqCache(sanitized.sanitized, dto.mode);
    if (faqHit) {
      await this.sessionService.saveUserMessage(session.id, sanitized.sanitized, 'FAQ');
      await this.sessionService.saveAssistantMessage(session.id, faqHit, {
        intent: 'FAQ',
        modelUsed: 'static-cache',
      });
      return this.staticResponse(session.id, 'FAQ', faqHit);
    }

    // ── 5. Intent classification ─────────────────────────────────────────────
    // Classifier chỉ thấy text — thêm hint khi có ảnh để câu hỏi ngắn kiểu
    // "đây là gì?" không bị phân loại nhầm OFF_TOPIC.
    const intent = await this.intentClassifier.classify(
      hasImage
        ? `${sanitized.sanitized} (người dùng đính kèm một hình ảnh nông sản)`
        : sanitized.sanitized,
    );

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

    // Có ảnh → user message thành multimodal chunks (text + inline image).
    // GeminiProvider map image part về inlineData; GroqProvider flatten về text.
    const userContent: LLMMessage['content'] = hasImage
      ? [
          { type: 'text', text: sanitized.sanitized },
          { type: 'image', imageBase64: imageBase64!, mimeType: imageMime },
        ]
      : sanitized.sanitized;

    const messages: LLMConversationMessage[] = [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
      { role: 'user', content: userContent },
    ];

    const model = COMPLEX_INTENTS.includes(intent) ? REASONING_MODEL : FAST_MODEL;
    const useTools = TOOL_REQUIRED_INTENTS.includes(intent);

    // ── 7. Save user message before streaming ────────────────────────────────
    // Ảnh không persist vào DB — chỉ đánh dấu để lịch sử hiển thị có ảnh kèm.
    await this.sessionService.saveUserMessage(
      session.id,
      hasImage ? `${sanitized.sanitized} [📷 kèm ảnh]` : sanitized.sanitized,
      intent,
    );

    // ── 8. Return streaming generator ────────────────────────────────────────
    const toolCtx: ToolExecutionContext = { userId, sessionId: session.id };
    const stream = useTools
      ? this.streamWithToolLoop(session.id, messages, model, intent, toolCtx)
      : this.streamAndSave(session.id, messages, model, intent);

    return { sessionId: session.id, intent, stream };
  }

  /**
   * Phân tích ảnh nông sản → gợi ý thông tin đăng bán (tên, danh mục, đơn vị, mô tả).
   * Không bao giờ throw — mọi lỗi AI/parse đều trả về EMPTY_SUGGESTION để FE
   * nhận HTTP 200 và tự fallback sang nhập tay.
   */
  async suggestProductFromImage(base64: string, mime: string): Promise<ProductSuggestion> {
    if (!this.llm.completeWithImage) {
      this.logger.warn('suggestProductFromImage: LLM provider has no vision support');
      return { ...EMPTY_SUGGESTION };
    }

    // FE thường gửi nguyên data URI — strip prefix nếu có.
    const imageBase64 = base64.replace(/^data:[^;]+;base64,/, '');

    try {
      const result = await this.llm.completeWithImage({
        model: VISION_MODEL,
        systemInstruction: SUGGEST_PRODUCT_PROMPT,
        imageBase64,
        mimeType: mime,
        jsonOutput: true,
        maxTokens: 800,
        temperature: 0.2,
      });

      const parsed: unknown = JSON.parse(result.content);
      return this.normalizeSuggestion(parsed);
    } catch (err) {
      this.logger.warn(`suggestProductFromImage failed: ${(err as Error).message}`);
      return { ...EMPTY_SUGGESTION };
    }
  }

  /** Coerce LLM output về đúng shape ProductSuggestion — field sai kiểu → null. */
  private normalizeSuggestion(raw: unknown): ProductSuggestion {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...EMPTY_SUGGESTION };
    }
    const obj = raw as Record<string, unknown>;
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() ? v.trim() : null;

    let confidence: number | null = null;
    if (typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)) {
      confidence = Math.min(1, Math.max(0, obj.confidence));
    }

    return {
      name: str(obj.name),
      category_name: str(obj.category_name),
      suggested_unit: str(obj.suggested_unit),
      description: str(obj.description),
      confidence,
    };
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
  ): AsyncGenerator<string | ToolStatusEvent> {
    const workingMessages: LLMConversationMessage[] = [...initialMessages];
    const toolsCalled: string[] = [];
    // Whitelist các entity được phép xuất hiện trong câu trả lời — extract từ tool result
    const validEntities = new Set<string>();
    let totalToolItems = 0;

    // Knowledge-only intents (PLATFORM_GUIDE, FAQ) never need multiple tool
    // hops. Cap the loop so a borderline classification doesn't pay the full
    // MAX_TOOL_ROUNDS latency budget.
    const roundBudget =
      intent === 'PLATFORM_GUIDE' || intent === 'FAQ'
        ? KNOWLEDGE_INTENT_MAX_ROUNDS
        : MAX_TOOL_ROUNDS;

    // Tool detection + execution loop (non-streaming)
    // Luôn dùng FAST_MODEL cho tool detection — chỉ cần nhận diện tool/argument,
    // không cần reasoning sâu. Tiết kiệm 500-1500ms/round so với 70b.
    for (let round = 0; round < roundBudget; round++) {
      let toolResponse: Awaited<ReturnType<ILLMProvider['completeWithTools']>>;
      try {
        toolResponse = await this.llm.completeWithTools({
          model: FAST_MODEL,
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

      // Yield status events TRƯỚC khi execute để FE hiển thị "Đang tìm sản phẩm..."
      // Đây là chunk đặc biệt (không phải text token).
      for (const tc of allowedCalls) {
        const toolName = tc.function.name;
        const label = TOOL_STATUS_LABELS[toolName] ?? `⏳ Đang xử lý: ${toolName}`;
        yield { __tool_status__: true, toolName, label } as ToolStatusEvent;
      }

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

    // ── Grounding selection ──────────────────────────────────────────────
    // Three cases, in priority order:
    //   (a) Knowledge tool ran → tool body is the source of truth (no entity list).
    //   (b) Retrieval tools returned entities → whitelist them by name.
    //   (c) Tools ran but returned nothing → forced no-data response.
    const hadKnowledgeTool = toolsCalled.some((n) => KNOWLEDGE_TOOLS.has(n));

    const groundingContent = hadKnowledgeTool
      ? `[GROUNDING — KNOWLEDGE BASE]
Câu trả lời PHẢI bám sát nội dung do get_platform_policy trả về.
TUYỆT ĐỐI KHÔNG:
- Thêm bước thao tác KHÔNG có trong tool result
- Bịa URL, mã giảm giá, hoa hồng, biểu phí mà tool không nhắc tới
- Diễn giải sai trạng thái đơn hàng (PENDING/CONFIRMED/SHIPPING/COMPLETED)

Hãy trình bày các bước dưới dạng danh sách rõ ràng, tiếng Việt, ngắn gọn.`
      : validEntities.size > 0
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
Tool đã chạy và trả về RỖNG. Hệ thống KHÔNG có sản phẩm/cửa hàng nào khớp với yêu cầu của user.

BẮT BUỘC: Trả lời CHÍNH XÁC theo mẫu dưới đây, KHÔNG thêm bất kỳ thông tin nào khác:

"Hiện tại trên hệ thống chưa có sản phẩm/cửa hàng phù hợp với yêu cầu của bạn. Bạn có thể thử lại với từ khóa khác, hoặc xem danh sách hiện có tại mục Cửa hàng/Sản phẩm trên Agri-Connect."

TUYỆT ĐỐI CẤM (vi phạm = output bị chặn 100%):
- Nêu BẤT KỲ con số giá nào (vd: "30.000đ/kg", "khoảng 25k", "giá thị trường ~20k") — KHÔNG CÓ DATA = KHÔNG CÓ GIÁ
- Nêu BẤT KỲ số lượng tồn kho nào (vd: "còn 200kg", "khoảng 50 phần") — KHÔNG CÓ DATA = KHÔNG CÓ STOCK
- Nêu BẤT KỲ tên cửa hàng / shop / seller / vựa / nông trại / hợp tác xã nào (vd: "Vựa Gạo Miền Tây", "Nông trại ABC") — KHÔNG CÓ DATA = KHÔNG CÓ TÊN
- Nêu BẤT KỲ tên sản phẩm cụ thể nào (vd: "cam sành Hà Giang", "gạo ST25") ngoài từ khóa user vừa hỏi
- Nêu địa chỉ, số điện thoại, link, mã giảm giá, đánh giá sao
- Dùng các cụm "thường thì...", "giá thị trường khoảng...", "có thể bạn quan tâm đến...", "ngoài ra còn có..."
- Dùng kiến thức chung về nông sản / kinh nghiệm cá nhân để lấp chỗ trống
- Đề xuất shop/sản phẩm thay thế bằng phỏng đoán

Câu trả lời chỉ gồm ĐÚNG 1 đoạn thông báo trên. Có thể kết bằng 1 câu hỏi gợi mở ngắn (vd: "Bạn muốn tôi tìm theo loại khác không?") nhưng KHÔNG được kèm bất kỳ tên/giá/số liệu nào.`;

    workingMessages.push({ role: 'system', content: groundingContent });

    // Knowledge-tool answers shouldn't run the entity-whitelist validator —
    // pass undefined so OutputValidator falls into knowledge mode (PII / leak
    // / price guards still run unconditionally).
    yield* this.streamAndSave(sessionId, workingMessages, model, intent, toolsCalled, {
      validEntities: hadKnowledgeTool ? undefined : validEntities,
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
    validation?: { validEntities?: Set<string>; toolItemCount: number },
  ): AsyncGenerator<string> {
    // Pre-compute input-side tokens ONCE before streaming. The messages array
    // is immutable from here, and waiting to reduce after the stream just
    // delays generator close. Char-based (len/4) is the same heuristic as
    // before, just hoisted out of the post-stream critical path.
    const inputTokens = estimateMessagesTokens(messages);

    const maxTokens = this.config.get<number>('AI_MAX_TOKENS_PER_REQUEST', 800);
    let fullContent = '';
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

    // Validate sau khi stream xong — nếu fail thì cảnh báo + thay nội dung lưu DB.
    // validEntities === undefined signals knowledge mode (entity rules skip;
    // PII / leak / price guards still run).
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

    const outputTokens = Math.ceil(validated.length / 4);
    const totalTokens = inputTokens + outputTokens;

    await this.sessionService.saveAssistantMessage(sessionId, validated, {
      intent,
      tokensUsed: totalTokens,
      modelUsed: model,
      toolsCalled,
    });
    this.rateLimitService.recordTokenUsage(sessionId, totalTokens);

    // Summarization is best-effort and adds 200-2000ms to the LLM round-trip.
    // Fire-and-forget — the next /ask call will see the summary once it lands.
    // Errors are already swallowed inside maybeSummarize.
    void this.maybeSummarize(
      sessionId,
      messages.filter((m): m is LLMMessage => m.role !== 'tool'),
    );

    if (streamError) throw streamError;
  }

  private async maybeSummarize(sessionId: string, plainMessages: LLMMessage[]): Promise<void> {
    const count = await this.sessionService.getMessageCount(sessionId);
    if (count <= 12) return;

    try {
      const oldMessages = plainMessages.slice(1, -SLIDING_WINDOW_FOR_SUMMARY);
      if (oldMessages.length < 3) return;

      const summaryContent = oldMessages.map((m) => `${m.role}: ${textOfContent(m.content)}`).join('\n');

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

/**
 * Cheap ~4-chars-per-token estimate over the message stream. Hoisted out of
 * streamAndSave so we compute it ONCE before streaming starts instead of
 * after — the messages array is frozen for the duration of one ask().
 */
function estimateMessagesTokens(messages: LLMConversationMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    const c = (m as LLMMessage).content;
    if (typeof c === 'string') {
      chars += c.length;
    } else if (Array.isArray(c)) {
      for (const part of c) {
        // Ảnh inline ≈ 258 token với Gemini — quy về ~1000 chars theo heuristic /4
        chars += part.type === 'text' ? part.text.length : 1000;
      }
    }
  }
  return Math.ceil(chars / 4);
}
