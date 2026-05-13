import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import { SemanticSearchService } from '../services/semantic-search.service';
import { ToolResult } from './types';

export interface SearchProductsInput {
  query: string;
  max_price?: number;
  min_price?: number;
  location?: string;
  category?: string;
  limit?: number;
}

export interface GetProductDetailsInput {
  product_id: string;
}

export interface ProductSummary {
  id: string;
  name: string;
  reference_price: number;
  unit: string;
  location: string | null;
  stock_quantity: number;
  is_negotiable: boolean;
  min_negotiation_qty: number | null;
  certification: string | null;
  seller: { id: string; store_name: string | null };
  category: string | null;
  description: string | null;
  /** Present when semantic search was used. Null for pure full-text results. */
  similarity?: number | null;
}

export interface ProductDetails extends ProductSummary {
  recent_transactions: { avg_price: number; min_price: number; max_price: number; count: number } | null;
}

/**
 * Hybrid search strategy:
 *
 * 1. Always run full-text search first (instant, always available).
 * 2. If full-text returns fewer than SEMANTIC_FALLBACK_THRESHOLD results:
 *    → Run hybrid search (full-text + vector via RRF).
 *    This covers cases where the user's query uses synonyms, different language,
 *    or semantic descriptions that don't keyword-match ("gạo thơm cao cấp" vs "ST25").
 *
 * Tradeoff: semantic search adds ~200-500ms latency (HuggingFace API call).
 * We only pay this cost when full-text fails — not on every request.
 */
const SEMANTIC_FALLBACK_THRESHOLD = 3;

@Injectable()
export class ProductSearchTool {
  private readonly logger = new Logger(ProductSearchTool.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly semanticSearch: SemanticSearchService,
  ) {}

  async searchProducts(input: SearchProductsInput): Promise<ToolResult<ProductSummary[]>> {
    try {
      const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
      const searchOptions = {
        priceMax: input.max_price,
        priceMin: input.min_price,
        location: input.location,
        category: input.category,
      };

      // Phase 1: Full-text search (always fast, no external API)
      const fulltextResults = await this.semanticSearch.fulltextSearch(
        input.query,
        limit,
        searchOptions,
      );

      // Phase 2: Semantic fallback when keyword match is weak
      if (fulltextResults.length < SEMANTIC_FALLBACK_THRESHOLD) {
        const pgvectorOn = await this.semanticSearch.checkPgvector();

        if (pgvectorOn) {
          this.logger.debug(
            `Full-text returned ${fulltextResults.length} results — trying hybrid search`,
          );

          const hybridResults = await this.semanticSearch.hybridSearch(
            input.query,
            limit,
            searchOptions,
          );

          if (hybridResults.length > 0) {
            return {
              success: true,
              data: hybridResults.map(toProductSummary),
            };
          }
        }
      }

      return { success: true, data: fulltextResults.map(toProductSummary) };
    } catch (err) {
      this.logger.error('ProductSearchTool.searchProducts error', err);
      return { success: false, error: 'Lỗi tìm kiếm sản phẩm' };
    }
  }

  async getProductDetails(input: GetProductDetailsInput): Promise<ToolResult<ProductDetails>> {
    try {
      const product = await this.db.product.findUnique({
        where: { id: input.product_id },
        include: {
          seller: {
            select: {
              id: true,
              profile: { select: { store_name: true } },
            },
          },
          category: { select: { name: true } },
          order_items: {
            where: { order: { status: 'COMPLETED' } },
            select: { negotiated_price: true },
            take: 50,
            orderBy: { order: { created_at: 'desc' } },
          },
        },
      });

      if (!product) {
        return { success: false, error: 'Không tìm thấy sản phẩm' };
      }

      const prices = product.order_items.map((i) => Number(i.negotiated_price));
      const recent_transactions =
        prices.length > 0
          ? {
              avg_price: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
              min_price: Math.min(...prices),
              max_price: Math.max(...prices),
              count: prices.length,
            }
          : null;

      const data: ProductDetails = {
        id: product.id,
        name: product.name,
        reference_price: Number(product.reference_price),
        unit: product.unit,
        location: product.location,
        stock_quantity: Number(product.stock_quantity),
        is_negotiable: product.min_negotiation_qty !== null,
        min_negotiation_qty: product.min_negotiation_qty ? Number(product.min_negotiation_qty) : null,
        certification: product.certification,
        seller: {
          id: product.seller.id,
          store_name: product.seller.profile?.store_name ?? null,
        },
        category: product.category?.name ?? null,
        description: product.description,
        recent_transactions,
      };

      return { success: true, data };
    } catch (err) {
      this.logger.error('ProductSearchTool.getProductDetails error', err);
      return { success: false, error: 'Lỗi lấy chi tiết sản phẩm' };
    }
  }
}

// ─── Converter ───────────────────────────────────────────────────────────────

function toProductSummary(r: ReturnType<typeof Object.assign> & ProductSummary): ProductSummary {
  return {
    id: r.id,
    name: r.name,
    reference_price: r.reference_price,
    unit: r.unit,
    location: r.location,
    stock_quantity: r.stock_quantity,
    is_negotiable: r.is_negotiable,
    min_negotiation_qty: r.min_negotiation_qty,
    certification: r.certification,
    seller: r.seller,
    category: r.category,
    description: r.description,
    ...(r.similarity !== undefined && { similarity: r.similarity }),
  };
}
