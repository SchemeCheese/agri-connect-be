import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  DefaultValuePipe,
  Query,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';
import { SessionService } from './services/session.service';
import { EmbeddingService } from './services/embedding.service';
import { SemanticSearchService } from './services/semantic-search.service';

interface AuthenticatedRequest {
  user: { sub: string; email?: string; is_buyer?: boolean; is_seller?: boolean; is_admin?: boolean };
}

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AIAssistantController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly embeddingService: EmbeddingService,
    private readonly semanticSearch: SemanticSearchService,
  ) {}

  /** List the current user's AI sessions. */
  @Get('sessions')
  async getSessions(@Request() req: AuthenticatedRequest) {
    return this.sessionService.getUserSessions(req.user.sub);
  }

  /** Get a specific session with its full message history. */
  @Get('sessions/:id')
  async getSession(
    @Request() req: AuthenticatedRequest,
    @Param('id') sessionId: string,
  ) {
    return this.sessionService.getSessionForUser(sessionId, req.user.sub);
  }

  /**
   * Trigger a product embedding reindex.
   * Generates HuggingFace embeddings and stores them in ProductEmbedding via pgvector.
   *
   * Use case: run after enabling pgvector, or after bulk product imports.
   * This is intentionally exposed as a REST endpoint (not a cron job) so the
   * thesis demo can trigger it manually.
   */
  @Post('reindex')
  @HttpCode(HttpStatus.ACCEPTED)
  async reindexEmbeddings(
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ) {
    const pgvectorReady = await this.semanticSearch.checkPgvector();
    if (!pgvectorReady) {
      return {
        success: false,
        message:
          'pgvector extension not available. Run prisma/migrations/manual_add_pgvector.sql first.',
      };
    }

    // Fire-and-forget (returns immediately, processing continues in background)
    this.embeddingService
      .batchReindexProducts(Math.min(limit, 500))
      .then((result) => {
        // Result is logged by EmbeddingService internally
        return result;
      })
      .catch(() => {
        // Logged by EmbeddingService
      });

    return {
      success: true,
      message: `Reindex started for up to ${limit} products. Check server logs for progress.`,
    };
  }

  /** Reindex a single product — useful during development/testing. */
  @Post('reindex/:productId')
  @HttpCode(HttpStatus.OK)
  async reindexProduct(@Param('productId') productId: string) {
    const pgvectorReady = await this.semanticSearch.checkPgvector();
    if (!pgvectorReady) {
      return {
        success: false,
        message: 'pgvector not available. Run the manual migration first.',
      };
    }

    const ok = await this.embeddingService.upsertProductEmbedding(productId);
    return { success: ok, productId };
  }

  /** Health check: reports pgvector availability + embedding model info. */
  @Get('semantic-status')
  async semanticStatus() {
    const pgvectorReady = await this.semanticSearch.checkPgvector();
    return {
      pgvector_available: pgvectorReady,
      embedding_model: this.embeddingService.modelName,
      embedding_dimension: this.embeddingService.dimension,
      status: pgvectorReady ? 'semantic search enabled' : 'full-text only mode',
    };
  }

  /**
   * Test semantic search directly (useful for thesis demo).
   * Example: GET /ai/search?q=gạo thơm cao cấp&limit=5
   */
  @Get('search')
  async testSearch(
    @Query('q') query: string,
    @Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit: number,
    @Query('mode') mode: 'hybrid' | 'vector' | 'fulltext' = 'hybrid',
  ) {
    if (!query) return { results: [], mode, query };

    let results: Awaited<ReturnType<SemanticSearchService['hybridSearch']>>;

    switch (mode) {
      case 'vector':
        results = await this.semanticSearch.vectorSearch(query, limit);
        break;
      case 'fulltext':
        results = await this.semanticSearch.fulltextSearch(query, limit);
        break;
      default:
        results = await this.semanticSearch.hybridSearch(query, limit);
    }

    return { results, mode, query, count: results.length };
  }
}
