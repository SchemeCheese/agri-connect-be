-- Firebase / multi-provider sync fields
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "firebase_uid"  TEXT,
  ADD COLUMN IF NOT EXISTS "display_name"  TEXT,
  ADD COLUMN IF NOT EXISTS "photo_url"     TEXT,
  ADD COLUMN IF NOT EXISTS "provider"      TEXT,
  ADD COLUMN IF NOT EXISTS "last_login_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "User_firebase_uid_key" ON "User"("firebase_uid");
