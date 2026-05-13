import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import { EmbeddingService } from './embedding.service';
import { ProductSummary } from '../tools/product-search.tool';

// ─── Result types ─────────────────────────────────────────────────────────────

export interface SemanticSearchResult extends ProductSummary {
  /** Cosine similarity score: 1.0 = identical, 0.0 = unrelated (null for full-text results). */
  similarity: number | null;
  /** Reciprocal Rank Fusion score when hybrid search is used. */
  rrf_score?: number;
  /** Which retrieval path found this result. */
  source: 'vector' | 'fulltext' | 'hybrid';
}

interface RawVectorRow {
  id: string;
  name: string;
  reference_price: string; // Postgres returns Decimal as string in raw queries
  unit: string;
  location: string | null;
  stock_quantity: string;
  min_negotiation_qty: string | null;
  certification: string | null;
  description: string | null;
  is_negotiable: boolean;
  seller_id: string;
  store_name: string | null;
  category_name: string | null;
  similarity: string; // float comes as string from $queryRawUnsafe
}

// ─── SemanticSearchService ────────────────────────────────────────────────────
/**
 * Architecture decision: Two-tier retrieval
 *
 * Tier 1 — Full-text (always available):
 *   PostgreSQL ILIKE matching on name + description.
 *   Precision: high for exact keyword match.
 *   Recall: low for synonyms, typos, semantic variants.
 *
 * Tier 2 — Vector similarity (requires pgvector):
 *   Cosine distance on 384-dim sentence-transformer embeddings.
 *   Precision: moderate (may surface related but not matching items).
 *   Recall: high — catches "gạo thơm" for query "jasmine rice".
 *
 * Hybrid = RRF(tier1, tier2):
 *   Reciprocal Rank Fusion re-ranks by combining both rank lists.
 *   Items appearing in both lists rank highest.
 *   Tradeoff: 2 queries instead of 1, ~50ms extra latency.
 */
@Injectable()
export class SemanticSearchService {
  private readonly logger = new Logger(SemanticSearchService.name);
  private pgvectorAvailable: boolean | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly embedding: EmbeddingService,
  ) {}

  /**
   * Pure vector similarity search.
   * Returns null/empty if pgvector extension is not installed.
   */
  async vectorSearch(query: string, limit = 5): Promise<SemanticSearchResult[]> {
    if (!(await this.checkPgvector())) return [];

    const vector = await this.embedding.generateEmbedding(query);
    if (!vector) return [];

    return this.runVectorQuery(vector, limit);
  }

  /**
   * Hybrid search: full-text + vector, fused via Reciprocal Rank Fusion.
   *
   * RRF formula: score(d) = Σ 1 / (k + rank_i(d))   where k=60 (standard constant).
   * Why k=60: empirically optimal — prevents top-ranked items in one list from
   * dominating too strongly, giving a balanced fusion.
   *
   * Falls back to pure full-text if pgvector is not available.
   */
  async hybridSearch(
    query: string,
    limit = 8,
    options: { priceMax?: number; priceMin?: number; location?: string; category?: string } = {},
  ): Promise<SemanticSearchResult[]> {
    // Run full-text and vector in parallel
    const [fulltextResults, vectorAvailable] = await Promise.all([
      this.fulltextSearch(query, limit * 2, options),
      this.checkPgvector(),
    ]);

    if (!vectorAvailable) {
      return fulltextResults.slice(0, limit);
    }

    const vector = await this.embedding.generateEmbedding(query);
    if (!vector) {
      return fulltextResults.slice(0, limit);
    }

    const vectorResults = await this.runVectorQuery(vector, limit * 2);

    const fused = reciprocalRankFusion(fulltextResults, vectorResults, limit);
    this.logger.debug(
      `Hybrid search "${query}": FT=${fulltextResults.length}, VEC=${vectorResults.length}, FUSED=${fused.length}`,
    );
    return fused;
  }

  /**
   * Standard Prisma full-text search — the Phase 2 baseline.
   * Exposed here so tools can use it directly without importing DatabaseService.
   */
  async fulltextSearch(
    query: string,
    limit = 8,
    options: { priceMax?: number; priceMin?: number; location?: string; category?: string } = {},
  ): Promise<SemanticSearchResult[]> {
    const products = await this.db.product.findMany({
      where: {
        is_active: true,
        stock_quantity: { gt: 0 },
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
        ],
        ...(options.priceMax !== undefined && { reference_price: { lte: options.priceMax } }),
        ...(options.priceMin !== undefined && { reference_price: { gte: options.priceMin } }),
        ...(options.location && { location: { contains: options.location, mode: 'insensitive' } }),
        ...(options.category && {
          category: { name: { contains: options.category, mode: 'insensitive' } },
        }),
      },
      include: {
        seller: { select: { id: true, profile: { select: { store_name: true } } } },
        category: { select: { name: true } },
      },
      orderBy: [{ is_active: 'desc' }, { updated_at: 'desc' }],
      take: limit,
    });

    return products.map((p) => ({
      id: p.id,
      name: p.name,
      reference_price: Number(p.reference_price),
      unit: p.unit,
      location: p.location,
      stock_quantity: Number(p.stock_quantity),
      is_negotiable: p.min_negotiation_qty !== null,
      min_negotiation_qty: p.min_negotiation_qty ? Number(p.min_negotiation_qty) : null,
      certification: p.certification,
      seller: { id: p.seller.id, store_name: p.seller.profile?.store_name ?? null },
      category: p.category?.name ?? null,
      description: p.description ? p.description.slice(0, 150) : null,
      similarity: null,
      source: 'fulltext' as const,
    }));
  }

  /** Lazy pgvector availability check — result is cached for process lifetime. */
  async checkPgvector(): Promise<boolean> {
    if (this.pgvectorAvailable !== null) return this.pgvectorAvailable;

    try {
      // Probe: if the extension or table doesn't exist, this throws
      await this.db.$queryRaw`SELECT 1 FROM "ProductEmbedding" LIMIT 0`;
      this.pgvectorAvailable = true;
      this.logger.log('pgvector is available — semantic search enabled');
    } catch {
      this.pgvectorAvailable = false;
      this.logger.log('pgvector not available — using full-text search only');
    }

    return this.pgvectorAvailable;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async runVectorQuery(embedding: number[], limit: number): Promise<SemanticSearchResult[]> {
    const vectorStr = `[${embedding.join(',')}]`;

    try {
      // Cosine distance: <=> returns 0.0 (identical) to 2.0 (opposite).
      // We convert to cosine similarity: 1 - distance.
      // HNSW index accelerates this from O(n) to O(log n).
      const rows = await this.db.$queryRawUnsafe<RawVectorRow[]>(
        `SELECT
           p.id,
           p.name,
           p.reference_price::float::text  AS reference_price,
           p.unit,
           p.location,
           p.stock_quantity::float::text   AS stock_quantity,
           p.min_negotiation_qty::float::text AS min_negotiation_qty,
           p.certification,
           p.description,
           (p.min_negotiation_qty IS NOT NULL) AS is_negotiable,
           p.seller_id,
           prof.store_name,
           cat.name                        AS category_name,
           (1 - (pe.embedding <=> $1::vector))::text AS similarity
         FROM "Product" p
         JOIN "ProductEmbedding" pe ON pe.product_id = p.id
         LEFT JOIN "Profile"   prof ON prof.user_id  = p.seller_id
         LEFT JOIN "Category"  cat  ON cat.id        = p.category_id
         WHERE p.is_active = true
           AND p.stock_quantity > 0
         ORDER BY pe.embedding <=> $1::vector
         LIMIT $2`,
        vectorStr,
        limit,
      );

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        reference_price: parseFloat(row.reference_price),
        unit: row.unit,
        location: row.location,
        stock_quantity: parseFloat(row.stock_quantity),
        is_negotiable: row.is_negotiable,
        min_negotiation_qty: row.min_negotiation_qty ? parseFloat(row.min_negotiation_qty) : null,
        certification: row.certification,
        seller: { id: row.seller_id, store_name: row.store_name },
        category: row.category_name,
        description: row.description ? row.description.slice(0, 150) : null,
        similarity: parseFloat(row.similarity),
        source: 'vector' as const,
      }));
    } catch (err) {
      this.logger.error('Vector search query failed', err);
      return [];
    }
  }
}

// ─── Reciprocal Rank Fusion ───────────────────────────────────────────────────
/**
 * Combines two ranked lists without knowing individual relevance scores.
 *
 * Formula: RRF(d) = Σ_i  1 / (k + rank_i(d))
 *   k = 60: prevents very-top items from dominating (Cormack et al. 2009)
 *
 * Why RRF over score-based fusion:
 *   - Full-text returns boolean relevance (no score in Prisma ILIKE)
 *   - Vector scores are not calibrated to the same scale as BM25
 *   - RRF only uses rank positions → scale-independent
 */
function reciprocalRankFusion(
  list1: SemanticSearchResult[],
  list2: SemanticSearchResult[],
  topK: number,
  k = 60,
): SemanticSearchResult[] {
  const scores = new Map<string, { score: number; item: SemanticSearchResult }>();

  const applyRanks = (list: SemanticSearchResult[], weight: number) => {
    for (let i = 0; i < list.length; i++) {
      const { id } = list[i];
      const existing = scores.get(id) ?? { score: 0, item: list[i] };
      scores.set(id, {
        score: existing.score + weight / (k + i + 1),
        item: existing.item,
      });
    }
  };

  // Equal weight to both retrieval paths
  applyRanks(list1, 1);
  applyRanks(list2, 1);

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ item, score }) => ({ ...item, rrf_score: score, source: 'hybrid' as const }));
}
