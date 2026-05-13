import { Injectable } from '@nestjs/common';

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

@Injectable()
export class OutputValidator {
  /**
   * Validates LLM output before sending to client.
   * Returns sanitized content or a fallback if content is unsafe.
   */
  validate(content: string): string {
    if (!content?.trim()) return '';

    for (const pattern of LEAK_PATTERNS) {
      if (pattern.test(content)) {
        return 'Xin lỗi, tôi gặp lỗi khi xử lý yêu cầu. Vui lòng thử lại.';
      }
    }

    // Price sanity check: flag if a price-like number is wildly out of range
    // (> 100 tỷ đồng/kg is clearly hallucinated)
    const priceMatches = content.match(/[\d,]+(?:\.\d+)?\s*(?:đồng|VND|vnđ)/gi);
    if (priceMatches) {
      for (const match of priceMatches) {
        const numeric = parseFloat(match.replace(/[,\s]/g, '').replace(/[^\d.]/g, ''));
        if (numeric > 100_000_000_000) {
          // Replace hallucinated prices with a disclaimer
          return content.replace(match, '[giá không hợp lệ]');
        }
      }
    }

    return content;
  }
}
