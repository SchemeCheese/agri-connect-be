-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('PENDING_SELLER_RESPONSE', 'UNDER_ADMIN_REVIEW', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "DisputeOutcome" AS ENUM ('PENDING', 'SELLER_FAULT', 'BUYER_FAULT', 'SHIPPING_FAULT', 'INSUFFICIENT_EVIDENCE');

-- CreateEnum
CREATE TYPE "ResolutionAction" AS ENUM ('NONE', 'REFUND_BUYER', 'RELEASE_PAYMENT_TO_SELLER', 'PARTIAL_REFUND', 'CLOSE_WITHOUT_ACTION');

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "buyer_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'PENDING_SELLER_RESPONSE',
    "outcome" "DisputeOutcome" NOT NULL DEFAULT 'PENDING',
    "action_taken" "ResolutionAction" NOT NULL DEFAULT 'NONE',
    "buyer_reason" TEXT NOT NULL,
    "buyer_images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "buyer_video" TEXT,
    "seller_explanation" TEXT,
    "seller_images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seller_video" TEXT,
    "admin_notes" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_order_id_key" ON "Dispute"("order_id");

-- CreateIndex
CREATE INDEX "Dispute_status_idx" ON "Dispute"("status");

-- CreateIndex
CREATE INDEX "Dispute_order_id_idx" ON "Dispute"("order_id");

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
