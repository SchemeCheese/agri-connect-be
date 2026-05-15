-- AlterTable: thêm mốc đã đọc cho mỗi participant trong conversation
ALTER TABLE "Conversation" ADD COLUMN "user1_last_read_at" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "user2_last_read_at" TIMESTAMP(3);

-- Index hỗ trợ query unread count
CREATE INDEX "ChatMessage_conversation_id_created_at_idx"
  ON "ChatMessage"("conversation_id", "created_at");
