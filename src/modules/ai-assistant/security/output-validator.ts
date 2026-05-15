import { Injectable, Logger } from '@nestjs/common';

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
  /** Tên các entity (store_name, product name, seller full_name) hợp lệ từ tool results */
  validEntities?: Set<string>;
  /** Intent dùng để quyết định độ chặt — chỉ entity-strict cho seller/product */
  intent?: string;
}

@Injectable()
export class OutputValidator {
  private readonly logger = new Logger(OutputValidator.name);

  /**
   * Validates LLM output before sending to client.
   * Returns sanitized content or a fallback if content is unsafe / hallucinated.
   */
  validate(content: string, opts: ValidateOptions = {}): string {
    if (!content?.trim()) return '';

    // ── 1. Secret leak guard ───────────────────────────────────────────────
    for (const pattern of LEAK_PATTERNS) {
      if (pattern.test(content)) {
        return 'Xin lỗi, tôi gặp lỗi khi xử lý yêu cầu. Vui lòng thử lại.';
      }
    }

    // ── 2. Phone number hallucination ──────────────────────────────────────
    // BE tools không expose phone — luôn coi là bịa. Strip thẳng.
    if (VIETNAMESE_PHONE.test(content)) {
      this.logger.warn(`[HALLUCINATION] Phone number detected → fallback. Content: ${content.slice(0, 200)}`);
      return SAFE_FALLBACK;
    }

    // ── 3. Vietnamese address hallucination ────────────────────────────────
    // Tương tự, tool không trả address. Detect "123 Nguyễn..." pattern.
    if (VIETNAMESE_ADDRESS.test(content)) {
      this.logger.warn(`[HALLUCINATION] Street address detected → fallback. Content: ${content.slice(0, 200)}`);
      return SAFE_FALLBACK;
    }

    // ── 4. Entity whitelist check (cho seller/product intent) ──────────────
    if (
      opts.validEntities &&
      opts.validEntities.size > 0 &&
      (opts.intent === 'SELLER_RECOMMENDATION' || opts.intent === 'PRODUCT_SEARCH')
    ) {
      const fakeName = this.findFabricatedProperNoun(content, opts.validEntities);
      if (fakeName) {
        this.logger.warn(`[HALLUCINATION] Fake entity "${fakeName}" not in whitelist → fallback`);
        return SAFE_FALLBACK;
      }
    } else if (
      opts.validEntities &&
      opts.validEntities.size === 0 &&
      (opts.intent === 'SELLER_RECOMMENDATION' || opts.intent === 'PRODUCT_SEARCH')
    ) {
      // Tool trả rỗng nhưng response có vẻ liệt kê → kiểm tra bullet pattern
      const bulletCount = (content.match(/(?:^|\n)\s*[-*•]/g) ?? []).length;
      if (bulletCount >= 2) {
        this.logger.warn(`[HALLUCINATION] Empty tool result but response has ${bulletCount} bullets → fallback`);
        return SAFE_FALLBACK;
      }
    }

    // ── 5. Price sanity check (giữ logic cũ) ───────────────────────────────
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
