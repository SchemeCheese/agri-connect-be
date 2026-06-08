import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImageAnnotatorClient, protos } from '@google-cloud/vision';

/**
 * Kết quả kiểm duyệt ảnh trước khi gửi vào Gemini.
 * - isSafe=false   → ảnh chứa nội dung nhạy cảm (adult / violence / racy)
 * - isAgriculture=false → label detection không thấy dấu hiệu nông sản
 * - reason         → lý do chi tiết (log/debug, KHÔNG hiển thị cho user)
 */
export interface ModerationResult {
  isSafe: boolean;
  isAgriculture: boolean;
  reason?: string;
}

type Likelihood = protos.google.cloud.vision.v1.Likelihood | keyof typeof protos.google.cloud.vision.v1.Likelihood | null | undefined;

/** SafeSearch ngưỡng chặn: LIKELY trở lên. Vision trả enum dạng string khi dùng REST/gRPC JSON. */
const BLOCKED_LIKELIHOODS = new Set(['LIKELY', 'VERY_LIKELY']);

/**
 * Từ khóa nông nghiệp — match substring (lowercase) trên label tiếng Anh của
 * Vision. Cố tình rộng (food, nature, ingredient...) vì label detection hay
 * trả nhãn tổng quát ("Natural foods", "Staple food") thay vì tên loài cụ thể;
 * mục tiêu là CHẶN ảnh rõ ràng không liên quan (selfie, xe cộ, screenshot...)
 * chứ không phải phân loại chính xác — việc đó Gemini làm ở bước sau.
 */
const AGRI_KEYWORDS = [
  'plant',
  'fruit',
  'vegetable',
  'food',
  'produce',
  'agriculture',
  'farm',
  'crop',
  'harvest',
  'leaf',
  'flower',
  'tree',
  'seed',
  'grain',
  'rice',
  'nut',
  'berry',
  'herb',
  'spice',
  'mushroom',
  'root',
  'ingredient',
  'cuisine',
  'dish',
  'livestock',
  'poultry',
  'fish',
  'seafood',
  'egg',
  'honey',
  'dairy',
  'garden',
  'soil',
  'organic',
  'nature',
];

/** Số label tối đa lấy từ labelDetection để đối chiếu từ khóa nông nghiệp. */
const MAX_LABELS = 10;

/**
 * Tầng kiểm duyệt ảnh bằng Google Cloud Vision, chạy TRƯỚC Gemini:
 * 1. safeSearchDetection — chặn NSFW / bạo lực
 * 2. labelDetection — chặn ảnh không phải nông sản (đỡ tốn token Gemini vô ích)
 *
 * Credentials (theo thứ tự ưu tiên):
 * - GOOGLE_APPLICATION_CREDENTIALS (đường dẫn file service account — chuẩn GCP)
 * - FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY + FIREBASE_PROJECT_ID — tái dùng
 *   service account Firebase Admin sẵn có (cùng GCP project, chỉ cần bật Vision API)
 *
 * Fail-open: chưa cấu hình credentials hoặc Vision API lỗi (quota, mạng...) →
 * cho ảnh đi qua + log warning. Kiểm duyệt là tầng tiết kiệm chi phí / an toàn
 * bổ sung, không được làm gãy luồng chính khi hạ tầng Vision trục trặc.
 */
@Injectable()
export class VisionModerationService implements OnModuleInit {
  private readonly logger = new Logger(VisionModerationService.name);
  private client: ImageAnnotatorClient | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    try {
      if (this.config.get<string>('GOOGLE_APPLICATION_CREDENTIALS')) {
        // SDK tự đọc file từ env var — không cần truyền gì thêm
        this.client = new ImageAnnotatorClient();
        this.logger.log('Vision moderation enabled (GOOGLE_APPLICATION_CREDENTIALS)');
        return;
      }

      const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL');
      const privateKey = this.config
        .get<string>('FIREBASE_PRIVATE_KEY')
        ?.replace(/\\n/g, '\n');
      const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');

      if (clientEmail && privateKey && projectId) {
        this.client = new ImageAnnotatorClient({
          projectId,
          credentials: { client_email: clientEmail, private_key: privateKey },
        });
        this.logger.log('Vision moderation enabled (Firebase service account)');
        return;
      }

      this.logger.warn(
        'Vision moderation DISABLED — no Google credentials configured (images pass through unmoderated)',
      );
    } catch (err) {
      this.client = null;
      this.logger.error(`Vision client init failed: ${(err as Error).message}`);
    }
  }

  /**
   * Kiểm duyệt 1 ảnh base64 (đã strip data-URI prefix hoặc chưa đều được).
   * 1 request annotateImage duy nhất gộp cả SAFE_SEARCH_DETECTION + LABEL_DETECTION
   * — rẻ và nhanh hơn 2 call riêng.
   *
   * Không bao giờ throw — lỗi Vision → fail-open (isSafe + isAgriculture đều true).
   */
  async moderateImage(base64: string): Promise<ModerationResult> {
    if (!this.client) {
      return { isSafe: true, isAgriculture: true, reason: 'moderation_disabled' };
    }

    const content = base64.replace(/^data:[^;]+;base64,/, '');

    let response: protos.google.cloud.vision.v1.IAnnotateImageResponse;
    try {
      [response] = await this.client.annotateImage({
        image: { content },
        features: [
          { type: 'SAFE_SEARCH_DETECTION' },
          { type: 'LABEL_DETECTION', maxResults: MAX_LABELS },
        ],
      });
    } catch (err) {
      this.logger.warn(`Vision API call failed (fail-open): ${(err as Error).message}`);
      return { isSafe: true, isAgriculture: true, reason: 'vision_api_error' };
    }

    // ── 1. SafeSearch: adult / violence / racy ≥ LIKELY → chặn ──────────────
    const ss = response.safeSearchAnnotation;
    if (ss) {
      const flagged = (['adult', 'violence', 'racy'] as const).filter((field) =>
        this.isBlocked(ss[field]),
      );
      if (flagged.length > 0) {
        const reason = flagged.map((f) => `${f}=${String(ss[f])}`).join(', ');
        this.logger.warn(`Image blocked by SafeSearch: ${reason}`);
        return { isSafe: false, isAgriculture: false, reason: `nsfw: ${reason}` };
      }
    }

    // ── 2. Labels: phải có ít nhất 1 nhãn khớp từ khóa nông nghiệp ──────────
    const labels = (response.labelAnnotations ?? [])
      .slice(0, MAX_LABELS)
      .map((l) => l.description?.toLowerCase() ?? '')
      .filter(Boolean);

    const isAgriculture = labels.some((label) =>
      AGRI_KEYWORDS.some((kw) => label.includes(kw)),
    );

    if (!isAgriculture) {
      this.logger.warn(`Image rejected as non-agricultural. Labels: [${labels.join(', ')}]`);
      return {
        isSafe: true,
        isAgriculture: false,
        reason: `non_agriculture: ${labels.join(', ') || 'no labels detected'}`,
      };
    }

    return { isSafe: true, isAgriculture: true };
  }

  /** Vision trả Likelihood dạng string ('LIKELY') hoặc số enum tùy transport — normalize cả 2. */
  private isBlocked(value: Likelihood): boolean {
    if (value == null) return false;
    const name =
      typeof value === 'number'
        ? protos.google.cloud.vision.v1.Likelihood[value]
        : String(value);
    return BLOCKED_LIKELIHOODS.has(name);
  }
}
