-- Shop location / Google Maps integration
ALTER TABLE "Profile"
  ADD COLUMN "shop_location_name"   TEXT,
  ADD COLUMN "shop_google_maps_url" TEXT,
  ADD COLUMN "shop_latitude"        DECIMAL(10,7),
  ADD COLUMN "shop_longitude"       DECIMAL(10,7),
  ADD COLUMN "place_id"             TEXT;
