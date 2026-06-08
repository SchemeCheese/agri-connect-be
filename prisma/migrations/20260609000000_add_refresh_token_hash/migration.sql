-- AlterTable: add nullable refresh token hash for refresh-token rotation
-- Stores bcrypt(SHA-256(refresh_token)); NULL means the user has no active refresh session (logged out / invalidated).
ALTER TABLE "User" ADD COLUMN "refresh_token_hash" TEXT;
