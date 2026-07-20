import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { backfillMedicines } from "./medicines.js";

let instance;

export function getDb() {
  if (!instance) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    // Serverless cold start: seed the writable /tmp database from the copy baked at build time.
    if (config.onVercel && !fs.existsSync(config.dbPath) && fs.existsSync(config.bakedDbPath)) {
      fs.copyFileSync(config.bakedDbPath, config.dbPath);
    }
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
  // Version 3: canonical medicines, exact-variant and injection attributes,
  // scoped medical facts, and richer order/inquiry snapshots.
  ensureColumns(db, "products", [
    ["medicine_id", "medicine_id INTEGER REFERENCES medicines(id)"],
    ["concentration", "concentration TEXT"],
    ["route", "route TEXT"],
    ["country_of_manufacture", "country_of_manufacture TEXT"],
    ["container_type", "container_type TEXT"],
    ["container_volume_ml", "container_volume_ml REAL CHECK(container_volume_ml IS NULL OR container_volume_ml > 0)"],
    ["formulation_state", "formulation_state TEXT CHECK(formulation_state IS NULL OR formulation_state IN ('solution','suspension','powder','concentrate','emulsion'))"],
    ["requires_reconstitution", "requires_reconstitution INTEGER CHECK(requires_reconstitution IN (0,1) OR requires_reconstitution IS NULL)"],
    ["dilution_required", "dilution_required INTEGER CHECK(dilution_required IN (0,1) OR dilution_required IS NULL)"],
    ["dose_container", "dose_container TEXT CHECK(dose_container IS NULL OR dose_container IN ('single_dose','multidose'))"],
    ["professional_use_only", "professional_use_only INTEGER CHECK(professional_use_only IN (0,1) OR professional_use_only IS NULL)"],
    ["cold_chain_required", "cold_chain_required INTEGER CHECK(cold_chain_required IN (0,1) OR cold_chain_required IS NULL)"],
    ["storage_temperature", "storage_temperature TEXT"],
    ["protect_from_light", "protect_from_light INTEGER CHECK(protect_from_light IN (0,1) OR protect_from_light IS NULL)"],
    ["storage_requirements", "storage_requirements TEXT"],
    ["identity_key", "identity_key TEXT"]
  ]);
  ensureColumns(db, "inquiry_items", [
    ["unit_kind_snapshot", "unit_kind_snapshot TEXT"], ["dosage_form_snapshot", "dosage_form_snapshot TEXT"],
    ["strength_snapshot", "strength_snapshot TEXT"], ["brand_snapshot", "brand_snapshot TEXT"],
    ["manufacturer_snapshot", "manufacturer_snapshot TEXT"], ["container_type_snapshot", "container_type_snapshot TEXT"],
    ["package_size_snapshot", "package_size_snapshot TEXT"]
  ]);
  ensureColumns(db, "order_items", [
    ["unit_kind_snapshot", "unit_kind_snapshot TEXT"], ["dosage_form_snapshot", "dosage_form_snapshot TEXT"],
    ["strength_snapshot", "strength_snapshot TEXT"], ["concentration_snapshot", "concentration_snapshot TEXT"],
    ["brand_snapshot", "brand_snapshot TEXT"], ["manufacturer_snapshot", "manufacturer_snapshot TEXT"],
    ["container_type_snapshot", "container_type_snapshot TEXT"], ["container_volume_ml_snapshot", "container_volume_ml_snapshot REAL"],
    ["package_size_snapshot", "package_size_snapshot TEXT"]
  ]);
  // Legacy medicine_facts (product-only, NOT NULL product_id) must be rebuilt to
  // support scoped facts; SQLite cannot relax NOT NULL via ALTER TABLE.
  const factColumns = new Set(db.prepare("PRAGMA table_info(medicine_facts)").all().map(column => column.name));
  if (!factColumns.has("scope")) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE medicine_facts_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        medicine_id INTEGER REFERENCES medicines(id) ON DELETE CASCADE,
        scope TEXT NOT NULL DEFAULT 'product' CHECK(scope IN ('product','medicine')),
        fact_type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        warning_level TEXT NOT NULL DEFAULT 'info',
        source_id INTEGER REFERENCES sources(id),
        review_status TEXT NOT NULL DEFAULT 'pending',
        last_reviewed_at TEXT,
        CHECK((scope='product' AND product_id IS NOT NULL) OR (scope='medicine' AND medicine_id IS NOT NULL))
      );
      INSERT INTO medicine_facts_v3(id,product_id,scope,fact_type,title,content,warning_level,source_id,review_status,last_reviewed_at)
        SELECT id,product_id,'product',fact_type,title,content,warning_level,source_id,review_status,last_reviewed_at FROM medicine_facts;
      DROP TABLE medicine_facts;
      ALTER TABLE medicine_facts_v3 RENAME TO medicine_facts;
      COMMIT;`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_products_medicine ON products(medicine_id)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_product_unique ON medicine_facts(product_id,fact_type,source_id) WHERE scope='product'");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_medicine_unique ON medicine_facts(medicine_id,fact_type,source_id) WHERE scope='medicine'");
  backfillMedicines(db);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(3);
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
