-- Shop location / Google Maps integration
ALTER TABLE "Profile"
  ADD COLUMN IF NOT EXISTS "shop_location_name"   TEXT,
  ADD COLUMN IF NOT EXISTS "shop_google_maps_url" TEXT,
  ADD COLUMN IF NOT EXISTS "shop_latitude"        DECIMAL(10,7),
  ADD COLUMN IF NOT EXISTS "shop_longitude"       DECIMAL(10,7),
  ADD COLUMN IF NOT EXISTS "place_id"             TEXT;
