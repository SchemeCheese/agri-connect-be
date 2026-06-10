-- ── Review: chống đánh giá trùng (dedupe trước rồi tạo unique index) ──────────
-- Xoá các review trùng (order_id, reviewer_id), GIỮ bản mới nhất theo created_at.
DELETE FROM "Review" a
USING "Review" b
WHERE a."order_id" = b."order_id"
  AND a."reviewer_id" = b."reviewer_id"
  AND (a."created_at" < b."created_at"
       OR (a."created_at" = b."created_at" AND a."id" < b."id"));

CREATE UNIQUE INDEX "Review_order_id_reviewer_id_key" ON "Review"("order_id", "reviewer_id");

-- ── Profile.trust_status ──────────────────────────────────────────────────────
CREATE TYPE "TrustStatus" AS ENUM ('VERIFIED', 'NORMAL', 'WARNING', 'RESTRICTED');
ALTER TABLE "Profile" ADD COLUMN "trust_status" "TrustStatus" NOT NULL DEFAULT 'NORMAL';
