-- AlterTable: thêm client_message_id để hỗ trợ idempotency
ALTER TABLE "ChatMessage" ADD COLUMN "client_message_id" TEXT;

-- Idempotency: cùng sender không được lưu 2 message với cùng client_message_id
-- Postgres coi NULL là distinct trong unique → các row legacy không có id sẽ không bị ảnh hưởng.
CREATE UNIQUE INDEX "ChatMessage_sender_id_client_message_id_key"
  ON "ChatMessage"("sender_id", "client_message_id");
