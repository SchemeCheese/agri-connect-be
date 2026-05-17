-- 1. Enum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'OUT_OF_STOCK', 'INACTIVE', 'DELETED');

-- 2. Column (NOT NULL with default so existing rows are valid immediately)
ALTER TABLE "Product"
  ADD COLUMN "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE';

-- 3. Backfill from current is_active + stock_quantity. Older rows cannot
-- distinguish "seller-deactivated" from "auto out-of-stock", so we map:
--   is_active=false + stock=0 → OUT_OF_STOCK
--   is_active=false + stock>0 → INACTIVE
--   is_active=true  + stock=0 → OUT_OF_STOCK
--   is_active=true  + stock>0 → ACTIVE
UPDATE "Product"
SET "status" = CASE
  WHEN "is_active" = false AND "stock_quantity" = 0 THEN 'OUT_OF_STOCK'::"ProductStatus"
  WHEN "is_active" = false                          THEN 'INACTIVE'::"ProductStatus"
  WHEN "stock_quantity" = 0                         THEN 'OUT_OF_STOCK'::"ProductStatus"
  ELSE                                                  'ACTIVE'::"ProductStatus"
END;
