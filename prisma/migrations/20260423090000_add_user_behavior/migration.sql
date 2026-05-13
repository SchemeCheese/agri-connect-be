-- CreateEnum
CREATE TYPE "BehaviorAction" AS ENUM ('VIEW_PRODUCT', 'SEARCH', 'ADD_TO_CART', 'START_CHAT', 'PURCHASE');

-- CreateTable
CREATE TABLE "UserBehavior" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "session_id" TEXT,
    "action" "BehaviorAction" NOT NULL,
    "target_id" TEXT,
    "metadata" JSONB,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBehavior_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserBehavior_user_id_created_at_idx" ON "UserBehavior"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "UserBehavior_session_id_created_at_idx" ON "UserBehavior"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "UserBehavior_action_created_at_idx" ON "UserBehavior"("action", "created_at");

-- CreateIndex
CREATE INDEX "UserBehavior_target_id_created_at_idx" ON "UserBehavior"("target_id", "created_at");

-- AddForeignKey
ALTER TABLE "UserBehavior" ADD CONSTRAINT "UserBehavior_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
