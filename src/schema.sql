PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  generic_name TEXT,
  brand_name TEXT,
  active_ingredient TEXT,
  category TEXT NOT NULL,
  dosage_form TEXT,
  strength TEXT,
  manufacturer TEXT,
  package_size TEXT,
  description TEXT,
  common_uses TEXT,
  key_facts TEXT,
  prescription_status TEXT,
  availability_status TEXT NOT NULL DEFAULT 'confirm_availability',
  featured INTEGER NOT NULL DEFAULT 0 CHECK(featured IN (0,1)),
  review_status TEXT NOT NULL DEFAULT 'needs_review',
  is_sierra_leone_eml INTEGER CHECK(is_sierra_leone_eml IN (0,1)),
  units_per_box INTEGER CHECK(units_per_box IS NULL OR units_per_box > 0),
  unit_kind TEXT,
  boxes_per_carton INTEGER CHECK(boxes_per_carton IS NULL OR boxes_per_carton > 0),
  units_per_carton INTEGER CHECK(units_per_carton IS NULL OR units_per_carton > 0),
  minimum_cartons INTEGER CHECK(minimum_cartons IS NULL OR minimum_cartons > 0),
  available_cartons INTEGER CHECK(available_cartons IS NULL OR available_cartons >= 0),
  price_per_carton_cents INTEGER CHECK(price_per_carton_cents IS NULL OR price_per_carton_cents >= 0),
  currency TEXT,
  pricing_mode TEXT NOT NULL DEFAULT 'quote_required' CHECK(pricing_mode IN ('fixed','quote_required','contact_supplier')),
  wholesale_status TEXT NOT NULL DEFAULT 'available_by_request' CHECK(wholesale_status IN ('in_stock','low_stock','out_of_stock','available_by_request','preorder','quote_required','temporarily_unavailable','discontinued')),
  wholesale_enabled INTEGER NOT NULL DEFAULT 0 CHECK(wholesale_enabled IN (0,1)),
  direct_checkout_enabled INTEGER NOT NULL DEFAULT 0 CHECK(direct_checkout_enabled IN (0,1)),
  packaging_review_status TEXT NOT NULL DEFAULT 'needs_review' CHECK(packaging_review_status IN ('needs_review','confirmed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_medical_review_at TEXT
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  accessed_at TEXT NOT NULL,
  source_type TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  local_path TEXT NOT NULL,
  public_path TEXT NOT NULL,
  source_page TEXT,
  source_domain TEXT,
  source_title TEXT,
  license_status TEXT NOT NULL DEFAULT 'needs_review',
  image_type TEXT NOT NULL DEFAULT 'candidate',
  angle_label TEXT,
  sequence_index INTEGER,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  is_verified INTEGER NOT NULL DEFAULT 0 CHECK(is_verified IN (0,1)),
  width INTEGER,
  height INTEGER,
  file_hash TEXT NOT NULL,
  perceptual_hash TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  review_status TEXT NOT NULL DEFAULT 'pending',
  review_reason TEXT,
  ocr_text TEXT,
  ocr_confidence REAL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, local_path)
);
CREATE INDEX IF NOT EXISTS idx_images_product ON product_images(product_id, is_verified, sort_order);
CREATE INDEX IF NOT EXISTS idx_images_hash ON product_images(file_hash);

CREATE TABLE IF NOT EXISTS medicine_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  fact_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  warning_level TEXT NOT NULL DEFAULT 'info',
  source_id INTEGER REFERENCES sources(id),
  review_status TEXT NOT NULL DEFAULT 'pending',
  last_reviewed_at TEXT,
  UNIQUE(product_id, fact_type, source_id)
);

CREATE TABLE IF NOT EXISTS review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_queue_unique ON review_queue(entity_type,entity_id,product_id,reason);

CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  dedupe_key TEXT NOT NULL UNIQUE,
  reference_number TEXT,
  business_name TEXT,
  destination_country TEXT,
  destination_city TEXT,
  inquiry_reason TEXT,
  inquiry_type TEXT NOT NULL DEFAULT 'availability',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inquiry_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity_requested INTEGER NOT NULL DEFAULT 1 CHECK(quantity_requested BETWEEN 1 AND 99),
  notes TEXT,
  carton_quantity INTEGER CHECK(carton_quantity IS NULL OR carton_quantity > 0),
  product_name_snapshot TEXT,
  units_per_box_snapshot INTEGER,
  boxes_per_carton_snapshot INTEGER,
  units_per_carton_snapshot INTEGER,
  price_per_carton_cents_snapshot INTEGER,
  currency_snapshot TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  business_name TEXT,
  email TEXT,
  phone TEXT,
  delivery_address TEXT,
  destination_country TEXT,
  destination_city TEXT,
  shipping_preference TEXT,
  wholesale_license_info TEXT,
  order_notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending_verification' CHECK(status IN ('pending_verification','quote_requested','awaiting_payment','payment_confirmed','processing','shipped','delivered','cancelled')),
  subtotal_cents INTEGER,
  currency TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,
  slug_snapshot TEXT,
  carton_quantity INTEGER NOT NULL CHECK(carton_quantity > 0),
  units_per_box_snapshot INTEGER,
  boxes_per_carton_snapshot INTEGER,
  units_per_carton_snapshot INTEGER,
  price_per_carton_cents_snapshot INTEGER,
  line_subtotal_cents INTEGER,
  currency_snapshot TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary_json TEXT,
  status TEXT NOT NULL DEFAULT 'running'
);
