/*
  Warnings:

  - You are about to drop the column `conversation_type` on the `Conversation` table. All the data in the column will be lost.
  - You are about to drop the column `product_id` on the `Conversation` table. All the data in the column will be lost.
  - You are about to drop the column `proposed_price` on the `Conversation` table. All the data in the column will be lost.
  - You are about to drop the column `proposed_quantity` on the `Conversation` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[user1_id,user2_id]` on the table `Conversation` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_product_id_fkey";

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "context_product_id" TEXT,
ADD COLUMN     "proposed_price" DECIMAL(10,2),
ADD COLUMN     "proposed_quantity" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "conversation_type",
DROP COLUMN "product_id",
DROP COLUMN "proposed_price",
DROP COLUMN "proposed_quantity";

-- DropEnum
DROP TYPE "ConversationType";

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_user1_id_user2_id_key" ON "Conversation"("user1_id", "user2_id");

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_context_product_id_fkey" FOREIGN KEY ("context_product_id") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
