-- shopify2simplyprint: initial database schema
-- Apply with:
--   npx wrangler d1 execute shopify2simplyprint --remote --file=./migrations/0001_initial.sql
--
-- Note: the `shopify_sessions` table is created automatically at runtime by
-- app/lib/d1-session-storage.server.ts, so it is intentionally absent here.

-- Connected shop and its credentials.
-- A self-hosted deployment normally has exactly one row here.
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_domain TEXT UNIQUE NOT NULL,
  shopify_access_token TEXT NOT NULL,
  -- SimplyPrint credentials (the API key is stored encrypted)
  simplyprint_api_key TEXT,
  simplyprint_company_id TEXT,
  simplyprint_queue_group INTEGER,
  simplyprint_connected_at INTEGER,
  -- Operation mode: 'simple' or 'advanced'
  settings_mode TEXT DEFAULT 'simple',
  -- Default stock threshold for advanced mode (can be overridden per product)
  settings_default_threshold INTEGER DEFAULT 100,
  -- Default yield per print (can be overridden per product)
  settings_default_yield INTEGER DEFAULT 1,
  -- Send filament colour along with queued prints
  settings_filament_color INTEGER DEFAULT 0,
  -- Shop contact details, captured from the Shopify Admin API
  shop_email TEXT,
  shop_owner_name TEXT,
  language TEXT DEFAULT 'en',
  -- Rolling monthly counter shown on the dashboard (informational only)
  prints_this_month INTEGER DEFAULT 0,
  prints_month_start TEXT,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Maps Shopify product variants to SimplyPrint files
CREATE TABLE IF NOT EXISTS product_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  -- Shopify product info
  shopify_product_id TEXT NOT NULL,
  shopify_variant_id TEXT,
  shopify_sku TEXT,
  shopify_barcode TEXT,
  shopify_title TEXT,
  shopify_variant_title TEXT,
  -- Primary SimplyPrint file (see product_file_mappings for multi-file mappings)
  simplyprint_file_id TEXT,
  simplyprint_file_name TEXT,
  filament_color TEXT,
  -- How many items one print produces (e.g. 5 items per print bed)
  yield_per_print INTEGER DEFAULT 1,
  -- Stock threshold for advanced mode (if null, uses the shop default)
  stock_threshold INTEGER,
  -- Virtual stock tracking, used when Shopify inventory is not tracked
  current_stock INTEGER DEFAULT 0,
  inventory_tracked INTEGER DEFAULT 1,
  -- Whether this was auto-mapped by EAN
  is_auto_mapped INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  UNIQUE(shop_id, shopify_variant_id)
);

-- Allows one product variant to map to multiple SimplyPrint files
-- (e.g. a product assembled from several printed parts)
CREATE TABLE IF NOT EXISTS product_file_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_mapping_id INTEGER NOT NULL,
  simplyprint_file_id TEXT NOT NULL,
  simplyprint_file_name TEXT,
  -- How many of this file are needed per product sold
  qty_per_product INTEGER DEFAULT 1,
  yield_per_print INTEGER DEFAULT 1,
  is_auto_mapped INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (product_mapping_id) REFERENCES product_mappings(id) ON DELETE CASCADE
);

-- Log of items added to the print queue
CREATE TABLE IF NOT EXISTS queue_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  -- Order info
  shopify_order_id TEXT NOT NULL,
  shopify_order_number TEXT,
  shopify_line_item_id TEXT,
  -- Product info
  product_mapping_id INTEGER,
  shopify_product_title TEXT,
  -- Queue info
  simplyprint_file_id TEXT,
  simplyprint_queue_item_id TEXT,
  quantity_ordered INTEGER,
  prints_queued INTEGER,
  -- How much Shopify inventory was increased when the prints were queued
  inventory_adjusted INTEGER DEFAULT 0,
  -- Status: 'queued', 'printing', 'completed', 'failed', 'skipped'
  status TEXT DEFAULT 'queued',
  -- Why it was skipped (if status = 'skipped')
  skip_reason TEXT,
  error_message TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  FOREIGN KEY (product_mapping_id) REFERENCES product_mappings(id) ON DELETE SET NULL
);

-- Sync operation history, surfaced on the Sync Logs page
CREATE TABLE IF NOT EXISTS sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  sync_type TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  details TEXT,
  items_processed INTEGER DEFAULT 0,
  items_created INTEGER DEFAULT 0,
  items_updated INTEGER DEFAULT 0,
  items_failed INTEGER DEFAULT 0,
  duration_ms INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_shops_domain ON shops(shopify_domain);
CREATE INDEX IF NOT EXISTS idx_product_mappings_shop ON product_mappings(shop_id);
CREATE INDEX IF NOT EXISTS idx_product_mappings_barcode ON product_mappings(shopify_barcode);
CREATE INDEX IF NOT EXISTS idx_product_mappings_simplyprint ON product_mappings(simplyprint_file_id);
CREATE INDEX IF NOT EXISTS idx_product_file_mappings_mapping ON product_file_mappings(product_mapping_id);
CREATE INDEX IF NOT EXISTS idx_product_file_mappings_file ON product_file_mappings(simplyprint_file_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_file_mappings_unique
  ON product_file_mappings(product_mapping_id, simplyprint_file_id);
CREATE INDEX IF NOT EXISTS idx_queue_log_shop ON queue_log(shop_id);
CREATE INDEX IF NOT EXISTS idx_queue_log_order ON queue_log(shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_queue_log_status ON queue_log(status);
CREATE INDEX IF NOT EXISTS idx_sync_logs_shop ON sync_logs(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sync_logs_type ON sync_logs(sync_type, created_at);
