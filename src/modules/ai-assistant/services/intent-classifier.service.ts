import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  INTENT_CLASSIFIER_SYSTEM_PROMPT,
  INTENT_LABELS,
  IntentLabel,
} from '../prompts/intent-classifier.prompt';
import { LLM_PROVIDER } from '../providers/llm.interface';
import type { ILLMProvider } from '../providers/llm.interface';
import { InputSanitizer } from '../security/input-sanitizer';

// Fast model — cheap, deterministic classification
const CLASSIFIER_MODEL = 'gemini-2.5-flash-lite';

// Keyword regex fast-path — bắt ~50-60% câu hỏi mà không cần gọi LLM (tiết kiệm 500-800ms)
const FAST_PATH_PATTERNS: Array<{ pattern: RegExp; label: IntentLabel }> = [
  // SELLER_ANALYTICS — đặt TRƯỚC SELLER_RECOMMENDATION để "bán chạy của tôi",
  // "doanh thu", "chuyển đổi"... không bị bắt nhầm thành gợi-ý-shop.
  { pattern: /\bdoanh\s*(thu|số)\b/i, label: 'SELLER_ANALYTICS' },
  { pattern: /\b(tỷ\s*lệ\s*chuyển\s*đổi|tồn\s*kho\s*lâu|cần\s*cải\s*thiện|bán\s*chạy\s*nhất)\b/i, label: 'SELLER_ANALYTICS' },
  { pattern: /\btop\s*(khách\s*hàng|sản\s*phẩm)\b/i, label: 'SELLER_ANALYTICS' },

  // ADMIN_ANALYTICS — câu hỏi toàn sàn (đặt trước để không lẫn với phân tích seller).
  { pattern: /\b(toàn\s*sàn|toàn\s*hệ\s*thống|top\s*seller)\b/i, label: 'ADMIN_ANALYTICS' },
  { pattern: /\b(shop|cửa\s*hàng)\b.*\b(cảnh\s*báo|warning|bị\s*hạn\s*chế)\b/i, label: 'ADMIN_ANALYTICS' },
  { pattern: /\b(user|người\s*dùng|tài\s*khoản)\b.*\b(bị\s*khóa|khoá|khóa)\b/i, label: 'ADMIN_ANALYTICS' },

  // SELLER_RECOMMENDATION
  { pattern: /\b(shop|cửa\s*hàng|seller|nhà\s*bán|người\s*bán)\b.*\b(nào|gì|uy\s*tín|tốt|nên|đề\s*xuất|gợi\s*ý|đáng\s*tin)\b/i, label: 'SELLER_RECOMMENDATION' },
  { pattern: /(gợi\s*ý|tìm|tìm\s*giúp|cho\s*tôi)\s+(shop|cửa\s*hàng|seller|nhà\s*bán)\b/i, label: 'SELLER_RECOMMENDATION' },

  // PRICE_ANALYSIS
  { pattern: /\b(giá|xu\s*hướng\s*giá|so\s*sánh\s*giá|biến\s*động\s*giá|giá\s*thị\s*trường|giá\s*trung\s*bình)\b/i, label: 'PRICE_ANALYSIS' },

  // NEGOTIATION_SUPPORT
  { pattern: /\b(thương\s*lượng|đàm\s*phán|trả\s*giá|mặc\s*cả|giá\s*hợp\s*lý.*\d+\s*(kg|tấn))\b/i, label: 'NEGOTIATION_SUPPORT' },

  // PRODUCT_SEARCH
  { pattern: /\b(tìm|kiếm|có\s*bán|còn|đang\s*bán|mua)\b.*\b(gạo|rau|trái\s*cây|hoa\s*quả|nông\s*sản|sản\s*phẩm|cà\s*phê|dâu|cam|xoài|chuối|nhãn|vải|tiêu|điều)\b/i, label: 'PRODUCT_SEARCH' },
  { pattern: /\b(gạo|cà\s*phê|tiêu|điều|hạt|rau\s*sạch|trái\s*cây)\b.*\b(dưới|trên|khoảng|chỉ|bao\s*nhiêu|giá)\b/i, label: 'PRICE_ANALYSIS' },

  // FAQ
  { pattern: /\b(đặt\s*hàng|thanh\s*toán|vận\s*chuyển|hoàn\s*tiền|chính\s*sách|quy\s*trình|làm\s*sao|làm\s*thế\s*nào|cách\s*thức)\b/i, label: 'FAQ' },
];

@Injectable()
export class IntentClassifierService {
  private readonly logger = new Logger(IntentClassifierService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: ILLMProvider,
    private readonly sanitizer: InputSanitizer,
  ) {}

  async classify(userMessage: string): Promise<IntentLabel> {
    // Layer 1: keyword blacklist — 0ms, 0 cost
    if (this.sanitizer.isObviouslyOffTopic(userMessage)) {
      this.logger.debug(`[Keyword block] "${userMessage.substring(0, 60)}"`);
      return 'OFF_TOPIC';
    }

    // Layer 1.5: regex fast-path — tiết kiệm 500-800ms cho câu hỏi rõ ý định
    for (const { pattern, label } of FAST_PATH_PATTERNS) {
      if (pattern.test(userMessage)) {
        this.logger.debug(`[Fast-path] "${userMessage.substring(0, 60)}" → ${label}`);
        return label;
      }
    }

    // Layer 2: LLM classifier with small fast model
    try {
      const result = await this.llm.complete({
        model: CLASSIFIER_MODEL,
        messages: [
          { role: 'system', content: INTENT_CLASSIFIER_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        maxTokens: 20,
        temperature: 0.1,
      });

      const label = result.content.trim().toUpperCase() as IntentLabel;

      if (INTENT_LABELS.includes(label as IntentLabel)) {
        this.logger.debug(`[Intent] "${userMessage.substring(0, 60)}" → ${label}`);
        return label;
      }

      // Model returned garbage — default to OFF_TOPIC for safety
      this.logger.warn(`[Intent] Unrecognized label "${result.content}" — defaulting OFF_TOPIC`);
      return 'OFF_TOPIC';
    } catch (err: unknown) {
      this.logger.error(`Intent classification failed: ${(err as Error).message}`);
      // Fail open: treat as FAQ (safest fallback — LLM will still apply domain constraints)
      return 'FAQ';
    }
  }
}
