import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIMode, Prisma } from '@prisma/client';
import { DatabaseService } from '../../../database/database.service';
import { AskQuestionDto } from '../dtos/ask-question.dto';
import type {
  ILLMProvider,
  LLMCompleteResult,
  LLMCompleteWithToolsOptions,
  LLMCompleteWithToolsResult,
  LLMConversationMessage,
  LLMMessage,
  LLMStreamOptions,
  LLMToolCallMessage,
  LLMToolResultMessage,
} from '../providers/llm.interface';
import { textOfContent } from '../providers/llm.interface';
import { GeminiProvider, GEMINI_MODELS } from '../providers/gemini.provider';
import { GroqProvider } from '../providers/groq.provider';
import { buildSystemPrompt, SystemPromptContext } from '../prompts/system.prompt';
import { BUYER_FAQ_CACHE } from '../prompts/buyer.prompt';
import { SELLER_FAQ_CACHE } from '../prompts/seller.prompt';
import { InputSanitizer } from '../security/input-sanitizer';
import { OutputValidator } from '../security/output-validator';
import { IntentClassifierService } from './intent-classifier.service';
import { SessionService } from './session.service';
import { RateLimitService } from './rate-limit.service';
import { VisionModerationService } from './vision-moderation.service';
import { IntentLabel } from '../prompts/intent-classifier.prompt';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { AGRI_TOOLS } from '../tools/tool-registry';
import type { ProductSummary } from '../tools/product-search.tool';
import type { SellerScore } from '../tools/seller-recommendation.tool';
import { TOOL_WHITELIST, ToolExecutionContext, ToolName, MAX_TOOL_ROUNDS } from '../tools/types';

// Model routing — single source of truth lives in gemini.provider.ts (GEMINI_MODELS).
// General chat sessions → flash / flash-lite; image vision & moderation → pro (Criterion 1).
const REASONING_MODEL = GEMINI_MODELS.CHAT; // gemini-2.5-flash — general chat (incl. chat-with-image)
const FAST_MODEL = GEMINI_MODELS.CHAT_LITE; // gemini-2.5-flash-lite — light chat / tool detection
// gemini-2.5-pro — STRICTLY for dedicated image vision/moderation analysis
// (product-photo classification), never for ordinary conversational turns.
const VISION_MODEL = GEMINI_MODELS.VISION;

// Model Groq tương đương khi fallback (Gemini rate limit / 5xx). Model id của
// Gemini không tồn tại trên Groq nên bắt buộc phải remap. Llama 3.x trên Groq
// hỗ trợ tool calling nhưng KHÔNG có vision — query kèm ảnh không fallback.
const GROQ_FALLBACK_MODEL: Record<string, string> = {
  [REASONING_MODEL]: 'llama-3.3-70b-versatile',
  [FAST_MODEL]: 'llama-3.1-8b-instant',
};
const GROQ_DEFAULT_FALLBACK = 'llama-3.3-70b-versatile';

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

// Thông báo khi ảnh bị Vision moderation chặn — chạy TRƯỚC Gemini để vừa an
// toàn vừa không tốn token cho ảnh rác (selfie, screenshot, NSFW...).
const UNSAFE_IMAGE_RESPONSE =
  'Hình ảnh có chứa nội dung nhạy cảm. Vui lòng chọn ảnh khác.';
const NON_AGRI_IMAGE_RESPONSE =
  'Hình ảnh này có vẻ không phải là nông sản. Vui lòng thử lại với ảnh khác.';

export interface AskResult {
  sessionId: string;
  intent: IntentLabel;
  stream: AsyncGenerator<string | ToolStatusEvent | ActionableDataEvent>;
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

/** Đơn vị hợp lệ cho gợi ý Magic Fill (seller) — Gemini phải chọn trong danh sách này. */
export const SELLER_SUGGEST_UNITS = ['kg', 'bó', 'túi', 'thùng', 'quả', 'gói', 'bao'] as const;

/** Gợi ý sản phẩm đầy đủ cho seller (Magic Fill) — đã validate categoryId/unit/price. */
export interface SellerProductSuggestion {
  name: string;
  description: string;
  suggestedPrice: number | null;
  unit: string;
  categoryId: string | null;
  confidence: number;
}

const EMPTY_SELLER_SUGGESTION: SellerProductSuggestion = {
  name: '',
  description: '',
  suggestedPrice: null,
  unit: '',
  categoryId: null,
  confidence: 0,
};

// Sự kiện trạng thái gửi giữa các token để FE hiển thị "Đang ..." labels.
// Gateway phân biệt: nếu chunk có shape ToolStatusEvent → emit ai:tool_start, else ai:token.
export interface ToolStatusEvent {
  __tool_status__: true;
  toolName: string;
  label: string;
}

/**
 * Entity cards gửi kèm stream để FE render UI có link THẬT (anti-hallucination:
 * LLM không được tự sinh link/ID — card data lấy thẳng từ tool result/DB).
 * Gateway nhận diện shape này → emit ai:actionable_data thay vì ai:token.
 */
export interface ActionableDataEvent {
  __actionable_data__: true;
  type: 'products' | 'shops';
  data: Array<Record<string, unknown>>;
}

/** Card sản phẩm — khớp ProductCardList bên FE (AIAssistantPanel). */
interface ProductCard {
  id: string;
  name: string;
  price: number;
  unit: string | null;
  image_url: string | null;
}

/** Card cửa hàng — khớp ShopCardList bên FE. */
interface ShopCard {
  seller_id: string;
  shop_name: string | null;
  avatar_url: string | null;
  avg_rating: number | null;
  verdict: string | null;
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
    // Inject trực tiếp cả 2 provider để orchestrate fallback ở service layer:
    // Gemini-first, lỗi (rate limit / 5xx) trên text query → Groq.
    private readonly gemini: GeminiProvider,
    private readonly groq: GroqProvider,
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly sanitizer: InputSanitizer,
    private readonly outputValidator: OutputValidator,
    private readonly intentClassifier: IntentClassifierService,
    private readonly sessionService: SessionService,
    private readonly rateLimitService: RateLimitService,
    private readonly toolExecutor: ToolExecutorService,
    private readonly visionModeration: VisionModerationService,
  ) {}

  // ─── LLM orchestration: Gemini-first, Groq fallback ─────────────────────────

  private groqModelFor(geminiModel: string): string {
    return GROQ_FALLBACK_MODEL[geminiModel] ?? GROQ_DEFAULT_FALLBACK;
  }

  /**
   * Stream Gemini-first. Fallback sang Groq CHỈ khi:
   * - không có ảnh (Groq Llama text-only — flatten ảnh sẽ trả lời sai), VÀ
   * - Gemini chưa yield token nào (FE đã nhận partial content thì retry
   *   từ đầu sẽ duplicate nội dung trên màn hình người dùng).
   */
  private async *executeLLMStream(
    options: LLMStreamOptions,
    hasImage: boolean,
  ): AsyncGenerator<string> {
    let yielded = false;
    try {
      for await (const token of this.gemini.stream(options)) {
        yielded = true;
        yield token;
      }
      return;
    } catch (err) {
      if (hasImage || yielded) throw err;
      this.logger.warn(`Gemini failed, falling back to Groq: ${(err as Error).message}`);
    }
    yield* this.groq.stream({ ...options, model: this.groqModelFor(options.model) });
  }

  /** Completion Gemini-first; text query lỗi → Groq, có ảnh thì throw. */
  private async executeLLMComplete(
    options: LLMStreamOptions,
    hasImage: boolean,
  ): Promise<LLMCompleteResult> {
    try {
      return await this.gemini.complete(options);
    } catch (err) {
      if (hasImage) throw err;
      this.logger.warn(`Gemini failed, falling back to Groq: ${(err as Error).message}`);
      return this.groq.complete({ ...options, model: this.groqModelFor(options.model) });
    }
  }

  /**
   * Tool detection cũng fallback (Groq Llama hỗ trợ tool calling) — không có
   * lớp này thì khi Gemini sập, tool loop break sớm → grounding rơi vào nhánh
   * NO DATA và user nhận "không có dữ liệu" thay vì câu trả lời từ Groq.
   */
  private async executeLLMCompleteWithTools(
    options: LLMCompleteWithToolsOptions,
    hasImage: boolean,
  ): Promise<LLMCompleteWithToolsResult> {
    try {
      return await this.gemini.completeWithTools(options);
    } catch (err) {
      if (hasImage) throw err;
      this.logger.warn(`Gemini failed, falling back to Groq: ${(err as Error).message}`);
      return this.groq.completeWithTools({ ...options, model: this.groqModelFor(options.model) });
    }
  }

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

    // ── 2c. Image moderation (Google Vision) — TRƯỚC mọi call Gemini ────────
    // Chặn NSFW + ảnh không phải nông sản ngay tại đây: vừa an toàn vừa khỏi
    // tốn token Gemini cho ảnh rác. Trả lời tĩnh như các nhánh block khác
    // (rate limit / injection) thay vì throw — user thấy tin nhắn thân thiện
    // trong khung chat, không phải error toast.
    if (hasImage) {
      const moderation = await this.visionModeration.moderateImage(imageBase64!);
      if (!moderation.isSafe || !moderation.isAgriculture) {
        this.logger.warn(
          `Image blocked by moderation (user=${userId}): ${moderation.reason ?? 'unknown'}`,
        );
        return this.staticResponse(
          '',
          'OFF_TOPIC',
          moderation.isSafe ? NON_AGRI_IMAGE_RESPONSE : UNSAFE_IMAGE_RESPONSE,
        );
      }
    }

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

    // Có ảnh → LUÔN dùng reasoning model: flash-lite nhận diện ảnh yếu, hay
    // trả lời "không thấy ảnh" dù inlineData đã gửi kèm.
    const model = hasImage || COMPLEX_INTENTS.includes(intent) ? REASONING_MODEL : FAST_MODEL;
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
   * Lỗi AI/parse trả về EMPTY_SUGGESTION để FE nhận HTTP 200 và fallback nhập tay.
   * NGOẠI LỆ: ảnh bị Vision moderation chặn (NSFW / không phải nông sản) →
   * throw BadRequestException 400 với message tiếng Việt — đây là lỗi của INPUT
   * chứ không phải lỗi hệ thống, FE phải báo user đổi ảnh thay vì nhập tay.
   */
  async suggestProductFromImage(base64: string, mime: string): Promise<ProductSuggestion> {
    // FE thường gửi nguyên data URI — strip prefix nếu có.
    const imageBase64 = base64.replace(/^data:[^;]+;base64,/, '');

    // Moderation chạy TRƯỚC Gemini — chặn sớm để không tốn token vision.
    const moderation = await this.visionModeration.moderateImage(imageBase64);
    if (!moderation.isSafe) {
      this.logger.warn(`suggestProductFromImage blocked: ${moderation.reason}`);
      throw new BadRequestException(UNSAFE_IMAGE_RESPONSE);
    }
    if (!moderation.isAgriculture) {
      this.logger.warn(`suggestProductFromImage blocked: ${moderation.reason}`);
      throw new BadRequestException(NON_AGRI_IMAGE_RESPONSE);
    }

    // Vision đi thẳng Gemini — Groq text-only nên không có fallback cho ảnh;
    // lỗi rơi xuống catch dưới → EMPTY_SUGGESTION, FE fallback nhập tay.
    if (!this.gemini.completeWithImage) {
      this.logger.warn('suggestProductFromImage: LLM provider has no vision support');
      return { ...EMPTY_SUGGESTION };
    }

    try {
      const result = await this.gemini.completeWithImage({
        model: VISION_MODEL,
        systemInstruction: SUGGEST_PRODUCT_PROMPT,
        imageBase64,
        mimeType: mime,
        jsonOutput: true,
        // gemini-2.5-pro is a thinking model — give thinking + JSON output room
        // (800 risked starving the answer to empty).
        maxTokens: 2048,
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

  // ─── Magic Fill cho SELLER: gợi ý đầy đủ name/description/price/unit/categoryId ──
  // Khác suggestProductFromImage (legacy, trả category_name): bản này INJECT danh
  // mục thật vào prompt để Gemini chọn categoryId hợp lệ + ước lượng giá VND.
  // KHÔNG lưu DB — chỉ trả gợi ý cho seller review.
  async suggestProductForSeller(base64: string, mime: string): Promise<SellerProductSuggestion> {
    const imageBase64 = base64.replace(/^data:[^;]+;base64,/, '');

    // Moderation TRƯỚC Gemini (chặn NSFW / không phải nông sản, tiết kiệm token).
    const moderation = await this.visionModeration.moderateImage(imageBase64);
    if (!moderation.isSafe) throw new BadRequestException(UNSAFE_IMAGE_RESPONSE);
    if (!moderation.isAgriculture) throw new BadRequestException(NON_AGRI_IMAGE_RESPONSE);

    if (!this.gemini.completeWithImage) return { ...EMPTY_SELLER_SUGGESTION };

    // Inject danh mục thật → Gemini chỉ được chọn categoryId trong danh sách này.
    const categories = await this.db.category.findMany({
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    const validIds = new Set(categories.map((c) => String(c.id)));
    const categoryList = categories.map((c) => `${c.id}=${c.name}`).join(', ');

    const prompt =
      'You are an agricultural expert in Vietnam. Analyze this image. ' +
      'Return ONLY a valid JSON object with the following schema: ' +
      '{ "name": "Short Vietnamese product name", ' +
      '"description": "Short sales description in Vietnamese", ' +
      '"suggestedPrice": integer (estimated retail price in VND), ' +
      `"unit": string (choose strictly from: ${SELLER_SUGGEST_UNITS.map((u) => `'${u}'`).join(', ')}), ` +
      `"categoryId": string (choose the best matching ID from this list: ${categoryList}), ` +
      '"confidence": float (0.0 to 1.0) }. ' +
      'All string values must be in Vietnamese. ' +
      'If the image is NOT an agricultural product, set confidence below 0.3.';

    try {
      const result = await this.gemini.completeWithImage({
        model: VISION_MODEL,
        systemInstruction: prompt,
        imageBase64,
        mimeType: mime,
        jsonOutput: true,
        maxTokens: 2048,
        temperature: 0.2,
      });
      return this.normalizeSellerSuggestion(JSON.parse(result.content), validIds);
    } catch (err) {
      // Gemini hallucinate JSON / lỗi mạng → trả rỗng, FE fallback nhập tay (vẫn 200).
      this.logger.warn(`suggestProductForSeller failed: ${(err as Error).message}`);
      return { ...EMPTY_SELLER_SUGGESTION };
    }
  }

  /** Coerce + validate output của Gemini về SellerProductSuggestion (chống hallucination). */
  private normalizeSellerSuggestion(raw: unknown, validIds: Set<string>): SellerProductSuggestion {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...EMPTY_SELLER_SUGGESTION };
    }
    const obj = raw as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim() : '');

    let confidence = 0;
    if (typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)) {
      confidence = Math.min(1, Math.max(0, obj.confidence));
    }

    let suggestedPrice: number | null = null;
    const priceRaw = typeof obj.suggestedPrice === 'string' ? Number(obj.suggestedPrice) : obj.suggestedPrice;
    if (typeof priceRaw === 'number' && Number.isFinite(priceRaw) && priceRaw > 0) {
      suggestedPrice = Math.round(priceRaw);
    }

    const unitStr = str(obj.unit);
    const unit = (SELLER_SUGGEST_UNITS as readonly string[]).includes(unitStr) ? unitStr : '';

    // categoryId chỉ nhận khi khớp ID có thật trong DB — chặn Gemini bịa id.
    const categoryId =
      obj.categoryId != null && validIds.has(String(obj.categoryId)) ? String(obj.categoryId) : null;

    return { name: str(obj.name), description: str(obj.description), suggestedPrice, unit, categoryId, confidence };
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
  ): AsyncGenerator<string | ToolStatusEvent | ActionableDataEvent> {
    const workingMessages: LLMConversationMessage[] = [...initialMessages];
    // Có ảnh trong lượt hỏi này → không được fallback Groq (text-only)
    const hasImage = messagesContainImage(initialMessages);
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
    // Text-only: FAST_MODEL là đủ — chỉ cần nhận diện tool/argument, không cần
    // reasoning sâu, tiết kiệm 500-1500ms/round. CÓ ẢNH: phải dùng model đã
    // chọn (reasoning) — argument của tool (vd từ khóa search_products) phải
    // suy ra TỪ ẢNH, flash-lite nhận diện ảnh yếu sẽ gọi tool với keyword sai.
    for (let round = 0; round < roundBudget; round++) {
      let toolResponse: Awaited<ReturnType<ILLMProvider['completeWithTools']>>;
      try {
        toolResponse = await this.executeLLMCompleteWithTools(
          {
            model: hasImage ? model : FAST_MODEL,
            // Strip ảnh khỏi history — chỉ user message cuối được giữ image part
            messages: this.sanitizeHistoryImages(workingMessages),
            tools: AGRI_TOOLS,
            // Image path dùng 2.5-flash (thinking model) — thought tokens tính
            // vào maxOutputTokens, 256 dễ bị thinking nuốt sạch → response rỗng,
            // loop break round 0 và user nhận "chưa có sản phẩm" oan. Text path
            // dùng flash-lite (thinking off mặc định) nên 256 vẫn đủ.
            maxTokens: hasImage ? 1024 : 256,
            temperature: 0.1,
          },
          hasImage,
        );
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

      // Tool trả entity thật (sản phẩm/shop) → đẩy card data về FE để render
      // UI clickable. Link/ảnh build từ DB tại đây — KHÔNG để LLM tự sinh.
      for (const outcome of outcomes) {
        const actionable = await this.buildActionableEvent(outcome.toolName, outcome.result);
        if (actionable) yield actionable;
      }

      this.logger.log(
        `Tool round ${round + 1}: called [${outcomes.map((o) => o.toolName).join(', ')}], entities=${validEntities.size}`,
      );
    }

    // ── Grounding selection ──────────────────────────────────────────────
    // Four cases, in priority order:
    //   (a) Knowledge tool ran → tool body is the source of truth (no entity list).
    //   (b) Retrieval tools returned entities → whitelist them by name.
    //   (c) Retrieval tool RAN but returned [] → no-data response.
    //   (d) NO tool ran (Gemini lỗi / model không gọi tool / whitelist chặn)
    //       → KHÔNG được khẳng định "chưa có sản phẩm" — bot chưa hề tra cứu.
    //       Trước đây (c) và (d) gộp chung → user bị trả lời sai "hệ thống
    //       chưa có mặt hàng" dù tool chưa chạy.
    const hadKnowledgeTool = toolsCalled.some((n) => KNOWLEDGE_TOOLS.has(n));
    const hadRetrievalTool = toolsCalled.some((n) => !KNOWLEDGE_TOOLS.has(n));

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
        : hadRetrievalTool
          ? `[GROUNDING — KẾT QUẢ RỖNG]
Tool đã chạy và KHÔNG tìm thấy sản phẩm/cửa hàng nào khớp trong hệ thống.
Hãy trả lời TỰ NHIÊN (quy tắc "KHI KHÔNG ĐỦ DỮ LIỆU" KHÔNG áp dụng cho lượt này):
1. Nếu user đính kèm ảnh: nói rõ trong ảnh là gì (vd "Đây là quả mận hậu").
2. Thông báo hệ thống hiện CHƯA có mặt hàng/cửa hàng phù hợp với yêu cầu.
3. Gợi ý 1 hành động tiếp theo (thử từ khóa khác / xem mục Cửa hàng / Sản phẩm).

Trả lời dạng đoạn văn ngắn, KHÔNG dùng danh sách gạch đầu dòng.

VẪN TUYỆT ĐỐI CẤM (anti-hallucination):
- Bịa tên shop/sản phẩm/seller nghe như có thật trên sàn
- Nêu giá, tồn kho, đánh giá sao, địa chỉ, số điện thoại, link, mã giảm giá
- Lấp chỗ trống bằng "giá thị trường khoảng...", "thường thì...", kiến thức bên ngoài`
          : `[GROUNDING — CHƯA TRA CỨU ĐƯỢC]
Lượt này KHÔNG có dữ liệu tool nào (công cụ tra cứu chưa chạy được).
Bạn CHƯA tra cứu hệ thống → TUYỆT ĐỐI KHÔNG khẳng định "hệ thống chưa có sản phẩm/cửa hàng"
hay "không tìm thấy" — bạn không biết điều đó.

Hãy trả lời tự nhiên, ngắn gọn theo ngữ cảnh hội thoại. Nếu user cần dữ liệu cụ thể
(sản phẩm / giá / cửa hàng), nói rằng bạn chưa tra cứu được ngay lúc này và mời họ
hỏi lại hoặc xem trực tiếp mục Sản phẩm / Cửa hàng.

VẪN TUYỆT ĐỐI CẤM (anti-hallucination):
- Bịa tên shop/sản phẩm/seller, giá, tồn kho, đánh giá, địa chỉ, số điện thoại, link, mã giảm giá
- Trả lời bằng kiến thức thị trường bên ngoài Agri-Connect`;

    workingMessages.push({ role: 'system', content: groundingContent });

    // Knowledge-tool answers shouldn't run the entity-whitelist validator —
    // pass undefined so OutputValidator falls into knowledge mode (PII / leak
    // / price guards still run unconditionally). Tương tự khi KHÔNG tool nào
    // chạy: validEntities rỗng không có nghĩa "tool trả rỗng" — bullet check
    // của validator sẽ thay nhầm câu trả lời hợp lệ bằng SAFE_FALLBACK.
    yield* this.streamAndSave(sessionId, workingMessages, model, intent, toolsCalled, {
      validEntities: hadKnowledgeTool || !hadRetrievalTool ? undefined : validEntities,
      toolItemCount: totalToolItems,
    });
  }

  /**
   * Chống token explosion: CHỈ user message cuối cùng được phép mang image part.
   * Mọi image part ở các message trước đó bị thay bằng text placeholder.
   *
   * Hiện tại history không thể chứa ảnh (buildContextMessages đọc từ DB —
   * content là string, ảnh chỉ lưu marker "[📷 kèm ảnh]"), nên đây là
   * defense-in-depth: nếu sau này có chỗ nhét ảnh vào history (persist ảnh,
   * replay session...), mỗi ảnh ~340KB base64 sẽ nhân lên theo số lượt chat
   * và phá vỡ context window + payload limit của Gemini.
   *
   * Lưu ý: mốc là user message CUỐI chứ không phải phần tử cuối của mảng —
   * trong tool loop, tool result + grounding system message nằm SAU user
   * message hiện tại, strip "tất cả trừ phần tử cuối" sẽ xoá nhầm ảnh của
   * chính lượt hỏi này.
   */
  private sanitizeHistoryImages(messages: LLMConversationMessage[]): LLMConversationMessage[] {
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    return messages.map((msg, idx) => {
      if (idx === lastUserIdx || msg.role === 'tool') return msg;
      const content = (msg as LLMMessage).content;
      if (!Array.isArray(content) || !content.some((p) => p.type === 'image')) return msg;
      return {
        ...msg,
        content: content.map((p) =>
          p.type === 'image'
            ? { type: 'text' as const, text: '[User uploaded an image previously]' }
            : p,
        ),
      } as LLMConversationMessage;
    });
  }

  /**
   * Build ActionableDataEvent từ tool result để FE render card clickable.
   * - search_products → product cards (kèm ảnh đầu tiên từ Attachment PRODUCT)
   * - recommend_sellers → shop cards (kèm avatar từ Attachment AVATAR)
   * Tool khác / result rỗng / lỗi enrich → null (stream không bị ảnh hưởng).
   */
  private async buildActionableEvent(
    toolName: string,
    result: unknown,
  ): Promise<ActionableDataEvent | null> {
    const res = result as { success?: boolean; data?: unknown } | null | undefined;
    if (!res?.success || !Array.isArray(res.data) || res.data.length === 0) return null;

    try {
      if (toolName === 'search_products') {
        const products = (res.data as ProductSummary[]).filter((p) => p?.id).slice(0, 6);
        if (products.length === 0) return null;

        // Ảnh không có trong ProductSummary (tool trả gọn cho LLM) — lấy từ
        // Attachment như products.service, mỗi sản phẩm 1 ảnh đầu tiên là đủ.
        const images = await this.db.attachment.findMany({
          where: { target_id: { in: products.map((p) => p.id) }, target_type: 'PRODUCT' },
          select: { target_id: true, url: true },
        });
        const imageMap = new Map<string, string>();
        for (const img of images) {
          if (!imageMap.has(img.target_id)) imageMap.set(img.target_id, img.url);
        }

        const data: ProductCard[] = products.map((p) => ({
          id: p.id,
          name: p.name,
          price: Number(p.reference_price),
          unit: p.unit ?? null,
          image_url: imageMap.get(p.id) ?? null,
        }));
        return { __actionable_data__: true, type: 'products', data: data as unknown as Array<Record<string, unknown>> };
      }

      if (toolName === 'recommend_sellers') {
        const sellers = (res.data as SellerScore[]).filter((s) => s?.seller_id).slice(0, 6);
        if (sellers.length === 0) return null;

        const avatars = await this.db.attachment.findMany({
          where: { target_id: { in: sellers.map((s) => s.seller_id) }, target_type: 'AVATAR' },
          select: { target_id: true, url: true },
        });
        const avatarMap = new Map(avatars.map((a) => [a.target_id, a.url]));

        const data: ShopCard[] = sellers.map((s) => ({
          seller_id: s.seller_id,
          shop_name: s.store_name ?? null,
          avatar_url: avatarMap.get(s.seller_id) ?? null,
          avg_rating: s.stats?.avg_rating ?? null,
          verdict: s.verdict ?? null,
        }));
        return { __actionable_data__: true, type: 'shops', data: data as unknown as Array<Record<string, unknown>> };
      }
    } catch (err) {
      // Enrich fail (DB lỗi...) → bỏ card, KHÔNG làm gãy stream trả lời
      this.logger.warn(`buildActionableEvent(${toolName}) failed: ${(err as Error).message}`);
    }
    return null;
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
    rawMessages: LLMConversationMessage[],
    model: string,
    intent: IntentLabel,
    toolsCalled: string[] = [],
    validation?: { validEntities?: Set<string>; toolItemCount: number },
  ): AsyncGenerator<string> {
    // Strip ảnh khỏi history trước khi gửi LLM — chỉ user message cuối giữ ảnh.
    // Token estimate + summarization phía dưới cũng dùng bản đã sanitize.
    const messages = this.sanitizeHistoryImages(rawMessages);
    // Ảnh còn lại (lượt hỏi hiện tại) → chặn fallback Groq trong executeLLMStream
    const hasImage = messagesContainImage(messages);

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
      for await (const token of this.executeLLMStream(
        { model, messages, maxTokens, temperature: 0.3 },
        hasImage,
      )) {
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

      // Summary luôn là text thuần (textOfContent đã bỏ ảnh) → fallback được
      const result = await this.executeLLMComplete(
        {
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
        },
        false,
      );

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

/** True nếu có bất kỳ message nào mang image part — quyết định cho phép fallback Groq hay không. */
function messagesContainImage(messages: LLMConversationMessage[]): boolean {
  return messages.some((m) => {
    const c = (m as LLMMessage).content;
    return Array.isArray(c) && c.some((p) => p.type === 'image');
  });
}

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
