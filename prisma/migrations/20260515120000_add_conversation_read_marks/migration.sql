-- AlterTable: thêm mốc đã đọc cho mỗi participant trong conversation
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "user1_last_read_at" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "user2_last_read_at" TIMESTAMP(3);

-- Index hỗ trợ query unread count
CREATE INDEX IF NOT EXISTS "ChatMessage_conversation_id_created_at_idx"
  ON "ChatMessage"("conversation_id", "created_at");
