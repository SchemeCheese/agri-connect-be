import { Injectable, Logger } from '@nestjs/common';
import { IntentLabel } from '../prompts/intent-classifier.prompt';

// Intents whose grounding source is prose (get_platform_policy), not entity rows.
// Entity whitelist + empty-tool bullet checks MUST NOT fire for these.
const KNOWLEDGE_INTENTS = new Set<IntentLabel>(['PLATFORM_GUIDE', 'FAQ']);

// Only these intents are subject to the strict entity whitelist.
const ENTITY_GROUNDED_INTENTS = new Set<IntentLabel>([
  'SELLER_RECOMMENDATION',
  'PRODUCT_SEARCH',
]);

/**
 * Patterns that should never appear in AI output.
 * Prevents accidental data leaks through LLM hallucination.
 */
const LEAK_PATTERNS: RegExp[] = [
  /password_hash/i,
  /jwt_secret/i,
  /api_key/i,
  /database_url/i,
  /\bsk-[a-zA-Z0-9]{20,}\b/, // API key shapes
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
];

// Tool result của BE không bao giờ trả về số điện thoại/địa chỉ chi tiết
// (SellerRecommendationTool chỉ trả store_name + stats). Nếu LLM tự sinh ra
// → 100% là bịa.
const VIETNAMESE_PHONE = /\b(?:0|\+84)(?:\s|-)?(?:\d(?:\s|-)?){9,10}\b/g;
const VIETNAMESE_ADDRESS = /\b\d{1,4}\s+(?:Nguyễn|Trần|Lê|Phạm|Hoàng|Phan|Đặng|Bùi|Đỗ|Hồ|Ngô|Dương|Vũ|Đinh|Đường|Đại\s+lộ)[^,\n.]{3,50}/gi;
const SAFE_FALLBACK =
  'Hệ thống chưa có đủ dữ liệu để trả lời chính xác câu hỏi này. ' +
  'Bạn có thể thử lại với từ khóa khác, hoặc xem danh sách shop tại mục "Cửa hàng".';

export interface ValidateOptions {
  /** Whitelist từ tool result (store_name / product name / seller full_name).
   *  Truyền `undefined` để báo "knowledge mode" — bỏ qua hoàn toàn entity rules. */
  validEntities?: Set<string>;
  /** Intent của câu hỏi — quyết định nhóm rule entity được áp dụng. */
  intent?: IntentLabel;
}

@Injectable()
export class OutputValidator {
  private readonly logger = new Logger(OutputValidator.name);

  /**
   * Validates LLM output before sending to client.
   * Safety filters (secrets, PII, price) chạy unconditional cho mọi intent.
   * Entity rules chỉ chạy khi intent ∈ ENTITY_GROUNDED_INTENTS VÀ caller truyền
   * một Set rõ ràng. Knowledge mode (validEntities === undefined hoặc intent ∈
   * KNOWLEDGE_INTENTS) bỏ qua entity rules để câu trả lời platform-guide không
   * bị chặn oan vì danh từ riêng / bullet count.
   */
  validate(
    content: string,
    options: ValidateOptions = {},
  ): string {
    if (!content?.trim()) return '';

    // ── 1. Secret leak guard (always on) ───────────────────────────────────
    for (const pattern of LEAK_PATTERNS) {
      if (pattern.test(content)) {
        return 'Xin lỗi, tôi gặp lỗi khi xử lý yêu cầu. Vui lòng thử lại.';
      }
    }

    // ── 2. Phone number hallucination (always on) ──────────────────────────
    if (VIETNAMESE_PHONE.test(content)) {
      this.logger.warn(`[HALLUCINATION] Phone number detected → fallback. Content: ${content.slice(0, 200)}`);
      return SAFE_FALLBACK;
    }

    // ── 3. Vietnamese street-address hallucination (always on) ─────────────
    if (VIETNAMESE_ADDRESS.test(content)) {
      this.logger.warn(`[HALLUCINATION] Street address detected → fallback. Content: ${content.slice(0, 200)}`);
      return SAFE_FALLBACK;
    }

    // ── 4. Entity-whitelist & empty-tool bullet checks (intent-gated) ──────
    const intent = options.intent;
    const isKnowledgeMode =
      options.validEntities === undefined ||
      (intent !== undefined && KNOWLEDGE_INTENTS.has(intent));

    if (
      !isKnowledgeMode &&
      intent !== undefined &&
      ENTITY_GROUNDED_INTENTS.has(intent)
    ) {
      if (options.validEntities && options.validEntities.size > 0) {
        const fakeName = this.findFabricatedProperNoun(content, options.validEntities);
        if (fakeName) {
          this.logger.warn(`[HALLUCINATION] Fake entity "${fakeName}" not in whitelist → fallback`);
          return SAFE_FALLBACK;
        }
      } else if (options.validEntities && options.validEntities.size === 0) {
        // Tool ran but returned nothing — a bulleted list is therefore fabricated.
        const bulletCount = (content.match(/(?:^|\n)\s*[-*•]/g) ?? []).length;
        if (bulletCount >= 2) {
          this.logger.warn(`[HALLUCINATION] Empty tool result but response has ${bulletCount} bullets → fallback`);
          return SAFE_FALLBACK;
        }
      }
    }

    // ── 5. Price sanity check (always on) ──────────────────────────────────
    const priceMatches = content.match(/[\d,]+(?:\.\d+)?\s*(?:đồng|VND|vnđ)/gi);
    if (priceMatches) {
      for (const match of priceMatches) {
        const numeric = parseFloat(match.replace(/[,\s]/g, '').replace(/[^\d.]/g, ''));
        if (numeric > 100_000_000_000) {
          return content.replace(match, '[giá không hợp lệ]');
        }
      }
    }

    return content;
  }

  /**
   * Tìm cụm danh từ riêng (chữ cái đầu viết hoa) trong response mà KHÔNG có
   * trong whitelist tool result. Bỏ qua một số stop-words tiếng Việt phổ biến
   * (tên thành phố / từ chung) để tránh false positive.
   */
  private findFabricatedProperNoun(
    content: string,
    valid: Set<string>,
  ): string | null {
    // Regex: 2+ từ liên tiếp bắt đầu chữ hoa (kể cả tiếng Việt có dấu)
    // Bao phủ "Green Farm", "Tân Hóa", "Nông Trại Cầu Đất", v.v.
    const candidateRegex = /\b[A-ZĐ][a-zà-ỹ]+(?:\s+[A-ZĐĐ][a-zà-ỹ]+){1,4}\b/gu;
    const matches = content.match(candidateRegex) ?? [];

    const STOP = new Set([
      'Agri-Connect', 'Agri Connect', 'Việt Nam', 'TP HCM', 'TP.HCM', 'Hà Nội',
      'Đà Nẵng', 'Nha Trang', 'Cần Thơ', 'Sài Gòn', 'Hồ Chí Minh',
      'Quận 1', 'Quận 2', 'Quận 3', 'Bình Thạnh', 'Tân Bình', 'Phú Nhuận',
      'Bạn', 'Tôi', 'Sản phẩm', 'Cửa hàng', 'Người mua', 'Người bán',
    ]);

    const lowerValid = new Set([...valid].map((v) => v.toLowerCase()));
    for (const m of matches) {
      const normalized = m.trim();
      if (STOP.has(normalized)) continue;
      if (lowerValid.has(normalized.toLowerCase())) continue;
      // Cho phép nếu nằm trong 1 cụm valid lớn hơn ("Nông Trại" trong "Nông Trại Cầu Đất")
      let isSubstring = false;
      for (const v of lowerValid) {
        if (v.includes(normalized.toLowerCase()) || normalized.toLowerCase().includes(v)) {
          isSubstring = true;
          break;
        }
      }
      if (!isSubstring) return normalized;
    }
    return null;
  }
}
