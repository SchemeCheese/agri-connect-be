-- Accent-insensitive search: thêm cột tên đã bỏ dấu + index.
-- An toàn cho dữ liệu hiện có (cột nullable, không default phá vỡ row cũ).
-- Dữ liệu cũ được điền bằng script: pnpm run backfill:search-name

ALTER TABLE "Product" ADD COLUMN "search_name" TEXT;

CREATE INDEX "Product_search_name_idx" ON "Product"("search_name");
