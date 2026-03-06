/*
  Warnings:

  - The values [PENDING,SUCCESS] on the enum `PaymentStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `notes` on the `Order` table. All the data in the column will be lost.
  - You are about to alter the column `final_total_price` on the `Order` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,2)` to `Decimal(10,2)`.
  - You are about to alter the column `quantity` on the `OrderItem` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,2)` to `Decimal(10,2)`.
  - You are about to alter the column `negotiated_price` on the `OrderItem` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,2)` to `Decimal(10,2)`.
  - You are about to drop the column `transaction_code` on the `Payment` table. All the data in the column will be lost.
  - You are about to drop the column `user_id` on the `Payment` table. All the data in the column will be lost.
  - You are about to alter the column `amount` on the `Payment` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,2)` to `Decimal(10,2)`.
  - You are about to alter the column `reference_price` on the `Product` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,2)` to `Decimal(10,2)`.
  - You are about to alter the column `stock_quantity` on the `Product` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,2)` to `Decimal(10,2)`.
  - A unique constraint covering the columns `[name]` on the table `Category` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `payer_id` to the `Payment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `Payment` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `payment_method` on the `Payment` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `updated_at` to the `Profile` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('COD', 'QR_CODE', 'MOMO', 'ZALOPAY');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('GENERAL', 'NEGOTIATION', 'AI');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'NEGOTIATION_QUOTE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AccountIdentifier" AS ENUM ('EMAIL', 'PHONE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderStatus" ADD VALUE 'ISSUE_REPORTED';
ALTER TYPE "OrderStatus" ADD VALUE 'FAILED';

-- AlterEnum
BEGIN;
CREATE TYPE "PaymentStatus_new" AS ENUM ('UNPAID', 'PAID', 'REFUNDING', 'REFUNDED', 'FAILED');
ALTER TABLE "Payment" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Payment" ALTER COLUMN "status" TYPE "PaymentStatus_new" USING ("status"::text::"PaymentStatus_new");
ALTER TYPE "PaymentStatus" RENAME TO "PaymentStatus_old";
ALTER TYPE "PaymentStatus_new" RENAME TO "PaymentStatus";
DROP TYPE "PaymentStatus_old";
ALTER TABLE "Payment" ALTER COLUMN "status" SET DEFAULT 'UNPAID';
COMMIT;

-- AlterEnum
ALTER TYPE "TargetType" ADD VALUE 'REVIEW';

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_user_id_fkey";

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "message_type" "MessageType" NOT NULL DEFAULT 'TEXT',
ADD COLUMN     "quote_price" DECIMAL(10,2),
ADD COLUMN     "quote_product_id" TEXT,
ADD COLUMN     "quote_product_name" TEXT,
ADD COLUMN     "quote_quantity" DECIMAL(10,2),
ADD COLUMN     "quote_status" "QuoteStatus",
ADD COLUMN     "quote_unit" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "conversation_type" "ConversationType" NOT NULL DEFAULT 'GENERAL';

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "notes",
ADD COLUMN     "discount_amount" DECIMAL(10,2),
ADD COLUMN     "note" TEXT,
ADD COLUMN     "payment_method" "PaymentMethod" NOT NULL DEFAULT 'COD',
ADD COLUMN     "shipped_at" TIMESTAMP(3),
ADD COLUMN     "tracking_code" TEXT,
ADD COLUMN     "voucher_id" TEXT,
ALTER COLUMN "final_total_price" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "OrderItem" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "negotiated_price" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "transaction_code",
DROP COLUMN "user_id",
ADD COLUMN     "payer_id" TEXT NOT NULL,
ADD COLUMN     "transaction_ref" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
DROP COLUMN "payment_method",
ADD COLUMN     "payment_method" "PaymentMethod" NOT NULL,
ALTER COLUMN "amount" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "status" SET DEFAULT 'UNPAID';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "min_negotiation_qty" DECIMAL(10,2),
ALTER COLUMN "reference_price" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "stock_quantity" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "banners1" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "banners2" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "cover_url" TEXT,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "store_name" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "seller_replied_at" TIMESTAMP(3),
ADD COLUMN     "seller_reply" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "verified_email" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Voucher" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "discount_type" "DiscountType" NOT NULL,
    "discount_value" DECIMAL(10,2) NOT NULL,
    "min_order_value" DECIMAL(10,2) NOT NULL,
    "max_discount_amount" DECIMAL(10,2) NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3) NOT NULL,
    "usage_limit" INTEGER NOT NULL DEFAULT 100,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedVoucher" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "voucher_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedVoucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "AccountIdentifier" NOT NULL DEFAULT 'EMAIL',
    "userId" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Voucher_seller_id_idx" ON "Voucher"("seller_id");

-- CreateIndex
CREATE INDEX "Voucher_code_idx" ON "Voucher"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_seller_id_code_key" ON "Voucher"("seller_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "SavedVoucher_user_id_voucher_id_key" ON "SavedVoucher"("user_id", "voucher_id");

-- CreateIndex
CREATE INDEX "Verification_userId_idx" ON "Verification"("userId");

-- CreateIndex
CREATE INDEX "Verification_code_idx" ON "Verification"("code");

-- CreateIndex
CREATE INDEX "Attachment_target_id_target_type_idx" ON "Attachment"("target_id", "target_type");

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "Voucher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedVoucher" ADD CONSTRAINT "SavedVoucher_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedVoucher" ADD CONSTRAINT "SavedVoucher_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "Voucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
