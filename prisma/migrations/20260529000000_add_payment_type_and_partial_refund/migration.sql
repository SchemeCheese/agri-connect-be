-- Thêm enum PaymentType và cột Payment.payment_type (mặc định PAYMENT để row cũ
-- không cần backfill). Thêm giá trị PARTIALLY_REFUNDED vào CheckoutSessionStatus
-- cho refundPayment khi chỉ hoàn một phần đơn trong nhóm.

-- 1) Enum PaymentType
DO $$ BEGIN
  CREATE TYPE "PaymentType" AS ENUM ('PAYMENT', 'REFUND');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2) Cột Payment.payment_type
ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "payment_type" "PaymentType" NOT NULL DEFAULT 'PAYMENT';

-- 3) CheckoutSessionStatus.PARTIALLY_REFUNDED
ALTER TYPE "CheckoutSessionStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_REFUNDED';
