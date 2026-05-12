-- AlterTable: make password_hash nullable and add firebase_uid
ALTER TABLE "User" ALTER COLUMN "password_hash" DROP NOT NULL;

ALTER TABLE "User" ADD COLUMN "firebase_uid" TEXT;

-- CreateIndex: firebase_uid must be unique when set
CREATE UNIQUE INDEX "User_firebase_uid_key" ON "User"("firebase_uid");
