-- Firebase / multi-provider sync fields
ALTER TABLE "User"
  ADD COLUMN "firebase_uid"  TEXT,
  ADD COLUMN "display_name"  TEXT,
  ADD COLUMN "photo_url"     TEXT,
  ADD COLUMN "provider"      TEXT,
  ADD COLUMN "last_login_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "User_firebase_uid_key" ON "User"("firebase_uid");
