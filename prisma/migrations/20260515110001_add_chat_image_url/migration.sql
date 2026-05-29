-- AlterTable: thêm image_url cho tin nhắn ảnh
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "image_url" TEXT;
