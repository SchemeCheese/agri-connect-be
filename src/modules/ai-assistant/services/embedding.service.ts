import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../../database/database.service';

/**
 * Text representation used for embedding generation.
 * We only need name/description/location/unit/category — no DB-specific types.
 */
export interface ProductEmbeddingInput {
  id: string;
  name: string;
  description?: string | null;
  location?: string | null;
  certification?: string | null;
  unit: string;
  category?: { name: string } | null;
}

export interface BatchReindexResult {
  processed: number;
  success: number;
  failed: number;
  skipped: number;
}

// ─── Embedding Provider Abstraction ─────────────────────────────────────────
// Reason: allows swapping HuggingFace → OpenAI → local model without touching
// the service logic. Only the provider needs to change.

interface IEmbeddingProvider {
  embed(text: string): Promise<number[] | null>;
  embedBatch(texts: string[]): Promise<(number[] | null)[]>;
  readonly model: string;
  readonly dimension: number;
}

class HuggingFaceProvider implements IEmbeddingProvider {
  private readonly client: AxiosInstance;
  readonly model: string;
  readonly dimension: number;

  constructor(
    model: string,
    dimension: number,
    apiKey: string,
    private readonly logger: Logger,
  ) {
    this.model = model;
    this.dimension = dimension;
    this.client = axios.create({
      baseURL: `https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/${model}`,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      timeout: 40_000, // HF cold-start can take up to 30s on free tier
    });
  }

  async embed(text: string): Promise<number[] | null> {
    try {
      const raw = await this.callWithRetry({ inputs: text });
      // Single input: HF returns [[float...]] (one array wrapped in outer array)
      const vector: number[] = Array.isArray(raw[0]) ? (raw as number[][])[0] : (raw as number[]);
      return normalizeL2(vector);
    } catch (err) {
      this.logger.warn(`HF embed failed: ${(err as Error).message}`);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];
    try {
      // Batch: HF returns [[...], [...]] for {"inputs": ["t1", "t2"]}
      const raw = await this.callWithRetry({ inputs: texts });
      return (raw as number[][]).map((v) => normalizeL2(v));
    } catch {
      // Fallback: embed one at a time
      return Promise.all(texts.map((t) => this.embed(t)));
    }
  }

  private async callWithRetry(body: object, maxRetries = 2): Promise<number[][] | number[]> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { data } = await this.client.post('', body);
        return data;
      } catch (err: unknown) {
        const axiosErr = err as { response?: { status: number; data?: { estimated_time?: number } } };
        if (axiosErr.response?.status === 503 && attempt < maxRetries) {
          // Model is loading on HF free tier — wait and retry
          const waitMs = Math.min((axiosErr.response.data?.estimated_time ?? 20) * 1000, 35_000);
          this.logger.log(`HuggingFace model loading — waiting ${waitMs / 1000}s (attempt ${attempt + 1})`);
          await sleep(waitMs);
          continue;
        }
        throw err;
      }
    }
    throw new Error('HuggingFace API: max retries exceeded');
  }
}

// ─── EmbeddingService ────────────────────────────────────────────────────────

@Injectable()
export class EmbeddingService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingService.name);
  private provider!: IEmbeddingProvider;
  private ready = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const model = this.config.get<string>(
      'EMBEDDING_MODEL',
      'paraphrase-multilingual-MiniLM-L12-v2',
    );
    const dimension = this.config.get<number>('EMBEDDING_DIM', 384);
    const apiKey = this.config.get<string>('HF_API_KEY', '');

    this.provider = new HuggingFaceProvider(model, dimension, apiKey, this.logger);

    if (!apiKey) {
      this.logger.warn(
        'HF_API_KEY not set — semantic search will use public HuggingFace endpoints (rate-limited)',
      );
    }

    this.ready = true;
    this.logger.log(`EmbeddingService ready: model=${model}, dim=${dimension}`);
  }

  get dimension(): number {
    return this.provider.dimension;
  }

  get modelName(): string {
    return this.provider.model;
  }

  /**
   * Generate a normalized L2 embedding for a single text string.
   * Returns null if embedding fails (network error, API down, etc.).
   */
  async generateEmbedding(text: string): Promise<number[] | null> {
    if (!this.ready) return null;
    const normalized = this.prepareText(text);
    if (!normalized) return null;
    return this.provider.embed(normalized);
  }

  /**
   * Build a rich semantic text representation for a product.
   * Includes all searchable attributes in natural language form.
   *
   * Chunking strategy: single chunk per product (fits within 512-token limit
   * of sentence-transformers models). For very long descriptions, truncate.
   */
  buildProductText(product: ProductEmbeddingInput): string {
    const parts: string[] = [product.name];

    if (product.category?.name) {
      parts.push(`Danh mục: ${product.category.name}`);
    }
    if (product.location) {
      parts.push(`Xuất xứ: ${product.location}`);
    }
    if (product.certification) {
      parts.push(`Chứng nhận: ${product.certification}`);
    }
    if (product.unit) {
      parts.push(`Đơn vị: ${product.unit}`);
    }
    if (product.description) {
      // Truncate description to 300 chars to stay within model token limit
      const desc = product.description.slice(0, 300);
      parts.push(desc);
    }

    return parts.join('. ');
  }

  /**
   * Generate and upsert the embedding for a single product into ProductEmbedding.
   * Idempotent — safe to call multiple times.
   */
  async upsertProductEmbedding(productId: string): Promise<boolean> {
    const product = await this.db.product.findUnique({
      where: { id: productId },
      include: { category: { select: { name: true } } },
    });

    if (!product || !product.is_active) {
      this.logger.debug(`Skipping product ${productId}: not found or inactive`);
      return false;
    }

    const content = this.buildProductText(product);
    const embedding = await this.generateEmbedding(content);

    if (!embedding) {
      this.logger.warn(`Failed to generate embedding for product ${productId}`);
      return false;
    }

    try {
      const vectorStr = `[${embedding.join(',')}]`;
      await this.db.$executeRawUnsafe(
        `INSERT INTO "ProductEmbedding" (id, product_id, embedding, content, model_version, updated_at)
         VALUES ($1, $2, $3::vector, $4, $5, NOW())
         ON CONFLICT (product_id)
         DO UPDATE SET
           embedding     = EXCLUDED.embedding,
           content       = EXCLUDED.content,
           model_version = EXCLUDED.model_version,
           updated_at    = NOW()`,
        uuidv4(),
        productId,
        vectorStr,
        content,
        this.provider.model,
      );
      return true;
    } catch (err) {
      // pgvector extension not installed — expected before migration is run
      this.logger.warn(`upsertProductEmbedding failed (pgvector not available?): ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Batch reindex all active products.
   * Processes in small batches to avoid HuggingFace rate limits.
   * Safe to call from a REST endpoint or a cron job.
   */
  async batchReindexProducts(limit = 100): Promise<BatchReindexResult> {
    const products = await this.db.product.findMany({
      where: { is_active: true },
      include: { category: { select: { name: true } } },
      take: limit,
      orderBy: { updated_at: 'desc' },
    });

    let success = 0;
    let failed = 0;
    const skipped = 0;

    // Process in batches of 5 (HuggingFace free tier: ~10 req/sec)
    const BATCH_SIZE = 5;
    for (let i = 0; i < products.length; i += BATCH_SIZE) {
      const batch = products.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map((p) => this.upsertProductEmbedding(p.id)),
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) success++;
        else failed++;
      }

      // Brief delay between batches to respect rate limits
      if (i + BATCH_SIZE < products.length) {
        await sleep(500);
      }
    }

    this.logger.log(
      `Batch reindex complete: ${success} success, ${failed} failed, ${skipped} skipped`,
    );

    return { processed: products.length, success, failed, skipped };
  }

  private prepareText(text: string): string {
    return text.trim().slice(0, 512); // sentence-transformers max input length
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function normalizeL2(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (magnitude === 0) return vector;
  return vector.map((x) => x / magnitude);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
