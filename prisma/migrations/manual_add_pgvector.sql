-- =============================================================================
-- Phase 3: pgvector Semantic Search Migration
-- Run this ONCE on a PostgreSQL instance that supports the vector extension.
--
-- Railway:  Enable pgvector from the Dashboard → Database → Extensions tab
-- Neon:     pgvector is available by default
-- Supabase: pgvector is available by default
-- Local:    docker run -p 5432:5432 ankane/pgvector
--
-- Run with: psql $DATABASE_URL -f prisma/migrations/manual_add_pgvector.sql
-- =============================================================================

-- Step 1: Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Step 2: Create ProductEmbedding table
CREATE TABLE IF NOT EXISTS "ProductEmbedding" (
  "id"            TEXT          NOT NULL,
  "product_id"    TEXT          NOT NULL UNIQUE,
  "embedding"     vector(384)   NOT NULL,   -- sentence-transformers dim=384
  "content"       TEXT          NOT NULL,
  "model_version" TEXT          NOT NULL DEFAULT 'paraphrase-multilingual-MiniLM-L12-v2',
  "updated_at"    TIMESTAMP(3)  NOT NULL DEFAULT NOW(),

  CONSTRAINT "ProductEmbedding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductEmbedding_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE
);

-- Step 3: B-tree index on product_id for ORM join lookups
CREATE INDEX IF NOT EXISTS "ProductEmbedding_product_id_idx"
  ON "ProductEmbedding" ("product_id");

-- Step 4: HNSW index for fast approximate nearest-neighbour search
-- HNSW parameters: m=16 (connections per layer), ef_construction=64 (build quality)
-- Tradeoff: higher m/ef_construction → better recall, slower build, more memory.
-- For production with >10k products: consider m=32, ef_construction=128.
CREATE INDEX IF NOT EXISTS "ProductEmbedding_embedding_hnsw_idx"
  ON "ProductEmbedding"
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Verify installation
DO $$
BEGIN
  RAISE NOTICE 'pgvector version: %', (SELECT extversion FROM pg_extension WHERE extname = 'vector');
  RAISE NOTICE 'ProductEmbedding table: OK';
  RAISE NOTICE 'HNSW index: OK';
  RAISE NOTICE 'Semantic search is ready. Run POST /ai/reindex to generate embeddings.';
END
$$;
