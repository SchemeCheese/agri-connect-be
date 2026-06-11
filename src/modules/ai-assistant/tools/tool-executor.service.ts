import { Injectable, Logger } from '@nestjs/common';
import { ToolCall } from '../providers/llm.interface';
import {
  MAX_TOOL_CALLS_PER_REQUEST,
  TOOL_EXECUTION_TIMEOUT_MS,
  TOOL_WHITELIST,
  ToolExecutionContext,
  ToolName,
  ToolResult,
} from './types';
import { ProductSearchTool } from './product-search.tool';
import { PriceAnalysisTool } from './price-analysis.tool';
import { NegotiationGuideTool } from './negotiation-guide.tool';
import { SellerRecommendationTool } from './seller-recommendation.tool';
import { PlatformFaqTool } from './platform-faq.tool';
import { SellerAnalyticsTool } from './seller-analytics.tool';
import { SimilarProductsTool } from './similar-products.tool';
import { DiscountedProductsTool } from './discounted-products.tool';
import { AdminOverviewTool } from './admin-overview.tool';

interface CacheEntry {
  result: ToolResult;
  expiresAt: number;
}

interface ToolCallOutcome {
  toolName: string;
  callId: string;
  result: ToolResult;
}

// Cache TTLs: FAQ/static longer, data queries shorter
const CACHE_TTL_MS: Record<ToolName, number> = {
  search_products: 5 * 60_000,
  get_product_details: 5 * 60_000,
  analyze_price_trends: 10 * 60_000,
  recommend_sellers: 10 * 60_000,
  get_negotiation_guidance: 3 * 60_000,
  get_platform_policy: 60 * 60_000, // 1 hour — static content
  get_seller_analytics: 3 * 60_000, // seller's own data — refresh fairly often
  get_similar_products: 5 * 60_000,
  get_discounted_products: 5 * 60_000,
  get_admin_overview: 3 * 60_000,
};

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly productSearch: ProductSearchTool,
    private readonly priceAnalysis: PriceAnalysisTool,
    private readonly negotiationGuide: NegotiationGuideTool,
    private readonly sellerRecommendation: SellerRecommendationTool,
    private readonly platformFaq: PlatformFaqTool,
    private readonly sellerAnalytics: SellerAnalyticsTool,
    private readonly similarProducts: SimilarProductsTool,
    private readonly discountedProducts: DiscountedProductsTool,
    private readonly adminOverview: AdminOverviewTool,
  ) {
    // Evict stale entries every 15 minutes
    setInterval(() => this.evictStaleCache(), 15 * 60_000);
  }

  /**
   * Execute a batch of tool calls from an LLM response.
   * Applies security checks, deduplication, parallel execution, and caching.
   */
  async executeAll(
    calls: ToolCall[],
    ctx: ToolExecutionContext,
  ): Promise<ToolCallOutcome[]> {
    // Security: enforce whitelist and max call count
    const validatedCalls = this.validateCalls(calls);

    if (validatedCalls.length === 0) {
      return [];
    }

    // Execute in parallel (each call has its own timeout)
    const outcomes = await Promise.allSettled(
      validatedCalls.map(async (tc) => {
        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs = JSON.parse(tc.function.arguments);
        } catch {
          return {
            toolName: tc.function.name,
            callId: tc.id,
            result: { success: false, error: 'Invalid JSON arguments from LLM' },
          };
        }

        const result = await this.execute(tc.function.name as ToolName, parsedArgs, ctx);
        return { toolName: tc.function.name, callId: tc.id, result };
      }),
    );

    return outcomes
      .filter((o): o is PromiseFulfilledResult<ToolCallOutcome> => o.status === 'fulfilled')
      .map((o) => o.value);
  }

  async execute(
    toolName: ToolName,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    // Cache lookup
    const cacheKey = `${toolName}:${this.stableStringify(args)}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit: ${toolName}`);
      return { ...cached, cached: true };
    }

    // Execute with timeout
    const result = await Promise.race([
      this.dispatch(toolName, args, ctx),
      this.timeoutError(TOOL_EXECUTION_TIMEOUT_MS, toolName),
    ]);

    // Cache successful results
    if (result.success) {
      this.setCache(cacheKey, result, CACHE_TTL_MS[toolName]);
    }

    this.logger.log(
      `Tool executed: ${toolName} | user=${ctx.userId} | success=${result.success}` +
        (result.cached ? ' [cached]' : ''),
    );

    return result;
  }

  private async dispatch(
    toolName: ToolName,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    // Cast via unknown: args come from JSON.parse so shape is validated by the LLM/schema,
    // not by TypeScript. Each tool should gracefully handle missing/wrong fields.
    const a = args as unknown;
    switch (toolName) {
      case 'search_products':
        return this.productSearch.searchProducts(a as Parameters<ProductSearchTool['searchProducts']>[0]);

      case 'get_product_details':
        return this.productSearch.getProductDetails(
          a as Parameters<ProductSearchTool['getProductDetails']>[0],
        );

      case 'analyze_price_trends':
        return this.priceAnalysis.analyzePriceTrends(
          a as Parameters<PriceAnalysisTool['analyzePriceTrends']>[0],
        );

      case 'recommend_sellers':
        return this.sellerRecommendation.recommendSellers(
          a as Parameters<SellerRecommendationTool['recommendSellers']>[0],
        );

      case 'get_negotiation_guidance':
        return this.negotiationGuide.getNegotiationGuidance(
          a as Parameters<NegotiationGuideTool['getNegotiationGuidance']>[0],
        );

      case 'get_platform_policy':
        return this.platformFaq.getPlatformPolicy(
          a as Parameters<PlatformFaqTool['getPlatformPolicy']>[0],
        );

      case 'get_seller_analytics':
        // sellerId LẤY TỪ ctx.userId (người đăng nhập) — KHÔNG từ tham số LLM.
        return this.sellerAnalytics.run(
          a as Parameters<SellerAnalyticsTool['run']>[0],
          ctx.userId,
        );

      case 'get_similar_products':
        return this.similarProducts.run(a as Parameters<SimilarProductsTool['run']>[0]);

      case 'get_discounted_products':
        return this.discountedProducts.run(a as Parameters<DiscountedProductsTool['run']>[0]);

      case 'get_admin_overview':
        // isAdmin LẤY TỪ ctx (DB), KHÔNG từ LLM — chặn lộ dữ liệu toàn sàn.
        return this.adminOverview.run(
          a as Parameters<AdminOverviewTool['run']>[0],
          ctx.isAdmin === true,
        );

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  }

  private validateCalls(calls: ToolCall[]): ToolCall[] {
    const allowed: ToolCall[] = [];

    for (const call of calls) {
      if (!TOOL_WHITELIST.has(call.function.name as ToolName)) {
        this.logger.warn(`Blocked unauthorized tool: ${call.function.name}`);
        continue;
      }
      allowed.push(call);
    }

    // Enforce max calls per request to prevent runaway tool loops
    if (allowed.length > MAX_TOOL_CALLS_PER_REQUEST) {
      this.logger.warn(
        `Capping tool calls from ${allowed.length} to ${MAX_TOOL_CALLS_PER_REQUEST}`,
      );
      return allowed.slice(0, MAX_TOOL_CALLS_PER_REQUEST);
    }

    return allowed;
  }

  private timeoutError(ms: number, toolName: string): Promise<ToolResult> {
    return new Promise((resolve) =>
      setTimeout(
        () => resolve({ success: false, error: `Tool ${toolName} timed out after ${ms}ms` }),
        ms,
      ),
    );
  }

  private stableStringify(obj: unknown): string {
    // Deterministic key for cache — sort keys
    return JSON.stringify(obj, Object.keys(obj as object).sort());
  }

  private getFromCache(key: string): ToolResult | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.result;
  }

  private setCache(key: string, result: ToolResult, ttlMs: number): void {
    this.cache.set(key, { result, expiresAt: Date.now() + ttlMs });
  }

  private evictStaleCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
  }
}
