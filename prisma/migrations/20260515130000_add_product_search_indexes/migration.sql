-- Index hỗ trợ AI tools (ProductSearchTool, SellerRecommendationTool)
-- ILIKE/contains trên name và filter is_active là pattern phổ biến nhất
CREATE INDEX IF NOT EXISTS "Product_is_active_name_idx" ON "Product"("is_active", "name");
CREATE INDEX IF NOT EXISTS "Product_is_active_category_id_idx" ON "Product"("is_active", "category_id");

-- Optional: GIN trigram index để ILIKE nhanh hơn nữa (cần pg_trgm extension).
-- Bỏ comment nếu Railway DB đã có extension pg_trgm bật sẵn.
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CREATE INDEX IF NOT EXISTS "Product_name_trgm_idx" ON "Product" USING gin (lower("name") gin_trgm_ops);
