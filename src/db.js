import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

let instance;

export function getDb() {
  if (!instance) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    instance = new DatabaseSync(config.dbPath);
    instance.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  }
  return instance;
}

function ensureColumns(db, table, definitions) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
  for (const [name, ddl] of definitions) if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function migrate() {
  const db = getDb();
  const sql = fs.readFileSync(path.join(config.root, "src", "schema.sql"), "utf8");
  db.exec(sql);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(1);
  // Version 2: wholesale packaging/pricing fields, richer inquiries, and order tables (tables come from schema.sql).
  ensureColumns(db, "products", [
    ["units_per_box", "units_per_box INTEGER CHECK(units_per_box IS NULL OR units_per_box > 0)"],
    ["unit_kind", "unit_kind TEXT"],
    ["boxes_per_carton", "boxes_per_carton INTEGER CHECK(boxes_per_carton IS NULL OR boxes_per_carton > 0)"],
    ["units_per_carton", "units_per_carton INTEGER CHECK(units_per_carton IS NULL OR units_per_carton > 0)"],
    ["minimum_cartons", "minimum_cartons INTEGER CHECK(minimum_cartons IS NULL OR minimum_cartons > 0)"],
    ["available_cartons", "available_cartons INTEGER CHECK(available_cartons IS NULL OR available_cartons >= 0)"],
    ["price_per_carton_cents", "price_per_carton_cents INTEGER CHECK(price_per_carton_cents IS NULL OR price_per_carton_cents >= 0)"],
    ["currency", "currency TEXT"],
    ["pricing_mode", "pricing_mode TEXT NOT NULL DEFAULT 'quote_required' CHECK(pricing_mode IN ('fixed','quote_required','contact_supplier'))"],
    ["wholesale_status", "wholesale_status TEXT NOT NULL DEFAULT 'available_by_request' CHECK(wholesale_status IN ('in_stock','low_stock','out_of_stock','available_by_request','preorder','quote_required','temporarily_unavailable','discontinued'))"],
    ["wholesale_enabled", "wholesale_enabled INTEGER NOT NULL DEFAULT 0 CHECK(wholesale_enabled IN (0,1))"],
    ["direct_checkout_enabled", "direct_checkout_enabled INTEGER NOT NULL DEFAULT 0 CHECK(direct_checkout_enabled IN (0,1))"],
    ["packaging_review_status", "packaging_review_status TEXT NOT NULL DEFAULT 'needs_review' CHECK(packaging_review_status IN ('needs_review','confirmed'))"]
  ]);
  ensureColumns(db, "inquiries", [
    ["reference_number", "reference_number TEXT"],
    ["business_name", "business_name TEXT"],
    ["destination_country", "destination_country TEXT"],
    ["destination_city", "destination_city TEXT"],
    ["inquiry_reason", "inquiry_reason TEXT"],
    ["inquiry_type", "inquiry_type TEXT NOT NULL DEFAULT 'availability'"]
  ]);
  ensureColumns(db, "inquiry_items", [
    ["carton_quantity", "carton_quantity INTEGER CHECK(carton_quantity IS NULL OR carton_quantity > 0)"],
    ["product_name_snapshot", "product_name_snapshot TEXT"],
    ["units_per_box_snapshot", "units_per_box_snapshot INTEGER"],
    ["boxes_per_carton_snapshot", "boxes_per_carton_snapshot INTEGER"],
    ["units_per_carton_snapshot", "units_per_carton_snapshot INTEGER"],
    ["price_per_carton_cents_snapshot", "price_per_carton_cents_snapshot INTEGER"],
    ["currency_snapshot", "currency_snapshot TEXT"]
  ]);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_inquiries_reference ON inquiries(reference_number) WHERE reference_number IS NOT NULL");
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(2);
  return db;
}

export function transaction(fn) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try { const value = fn(db); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function closeDb() {
  if (instance) instance.close();
  instance = undefined;
}
