import { Injectable, Logger } from '@nestjs/common';

const MAX_INPUT_LENGTH = 500;

/**
 * Patterns that indicate prompt injection attempts.
 * Regex-based so zero LLM cost — runs before any API call.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(previous|all|above|prior)\s+instructions?/i,
  /bỏ\s*qua\s*(các\s*)?(quy\s*tắc|hướng\s*dẫn|lệnh)/i,
  /act\s+as\s+(a\s+)?(?!buyer|seller)/i,  // "act as" non-role entities
  /pretend\s+(you\s+are|to\s+be)/i,
  /giả\s*vờ\s*(bạn\s*là|là)/i,
  /you\s+are\s+now\s+(?!a\s+(buyer|seller))/i,
  /system\s*prompt/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /\[INST\]|\[\/INST\]/,  // Llama instruction injection
  /<\|.*?\|>/,            // Special token injection
];

/**
 * Keywords that are definitely off-topic — caught before hitting the LLM classifier.
 * Cheap O(n) check that saves ~$0.0001/request for obvious cases.
 */
const OFFTOPIC_KEYWORD_BLACKLIST: string[] = [
  'python', 'javascript', 'typescript', 'java', 'golang', 'rust', 'c++', 'ruby',
  'hack', 'hacking', 'crack', 'exploit', 'malware', 'virus', 'ddos', 'sql injection',
  'wifi', 'mật khẩu wifi',
  'viết thơ', 'làm thơ', 'bài thơ',
  'giải toán', 'tính tích phân', 'đạo hàm', 'phương trình',
  'lịch sử việt nam', 'địa lý', 'sinh học', 'hóa học', 'vật lý',
  'trò chuyện', 'kể chuyện', 'chuyện cười',
  'thời tiết hôm nay',
  'bóng đá', 'thể thao',
  'nấu ăn', 'công thức nấu',  // not agri trading context
  'y tế', 'bệnh viện', 'thuốc', 'chẩn đoán',
  'pháp luật', 'luật sư', 'tòa án',
  'tâm lý', 'tư vấn tâm lý',
  'translate', 'dịch thuật', 'dịch văn bản',
  'write a', 'write me', 'generate a poem', 'write code',
  'chatgpt', 'openai', 'gemini', 'bard',
];

export interface SanitizeResult {
  sanitized: string;
  blocked: boolean;
  reason?: 'injection' | 'too_long' | 'empty';
}

@Injectable()
export class InputSanitizer {
  private readonly logger = new Logger(InputSanitizer.name);

  sanitize(input: string): SanitizeResult {
    if (!input?.trim()) {
      return { sanitized: '', blocked: true, reason: 'empty' };
    }

    if (input.length > MAX_INPUT_LENGTH) {
      return { sanitized: '', blocked: true, reason: 'too_long' };
    }

    // Strip HTML/script tags — prevents XSS in stored messages
    const stripped = input.replace(/<[^>]*>/g, '').trim();

    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(stripped)) {
        this.logger.warn(`Injection attempt blocked: "${stripped.substring(0, 80)}..."`);
        return { sanitized: '', blocked: true, reason: 'injection' };
      }
    }

    return { sanitized: stripped, blocked: false };
  }

  /**
   * Fast keyword check — runs BEFORE LLM intent classification.
   * Returns true if the message is obviously off-topic (0 LLM cost).
   */
  isObviouslyOffTopic(input: string): boolean {
    const lower = input.toLowerCase();
    return OFFTOPIC_KEYWORD_BLACKLIST.some((kw) => lower.includes(kw));
  }
}
