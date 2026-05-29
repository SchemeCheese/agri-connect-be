-- AlterEnum: thêm IMAGE vào MessageType
-- Lưu ý: ALTER TYPE ADD VALUE không chạy được trong transaction; Prisma sẽ tự
-- detect và chạy ngoài transaction nhờ comment `AlterEnum` ở đầu.
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'IMAGE';
