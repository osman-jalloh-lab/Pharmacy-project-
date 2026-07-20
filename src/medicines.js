import crypto from "node:crypto";

export function slugify(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Stable identity fingerprint that prevents duplicate exact-product records.
// Built only from stored attributes; never used to invent data.
export function productIdentityKey(product) {
  const parts = [
    product.genericName, product.brandName, product.manufacturer, product.dosageForm,
    product.strength, product.concentration, product.containerType,
    product.containerVolumeMl, product.packageSize
  ].map(value => String(value ?? "").trim().toLowerCase());
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex");
}

// Idempotent: creates one canonical medicine per distinct generic name, links
// unlinked products to it, and queues products that cannot be linked with
// confidence (no generic name) for human review. Never merges products.
export function backfillMedicines(db) {
  const unlinked = db.prepare("SELECT id, generic_name, active_ingredient, category, prescription_status, is_sierra_leone_eml FROM products WHERE medicine_id IS NULL").all();
  if (!unlinked.length) return { created: 0, linked: 0, queued: 0 };
  const findMedicine = db.prepare("SELECT id FROM medicines WHERE generic_name=?");
  const insertMedicine = db.prepare("INSERT INTO medicines(slug, generic_name, preferred_display_name, active_ingredient, therapeutic_category, prescription_status, is_sierra_leone_eml) VALUES (?,?,?,?,?,?,?)");
  const linkProduct = db.prepare("UPDATE products SET medicine_id=? WHERE id=?");
  const queue = db.prepare("INSERT OR IGNORE INTO review_queue(entity_type, entity_id, product_id, reason, details) VALUES ('product', ?, ?, 'needs_medicine_link', ?)");
  let created = 0, linked = 0, queued = 0;
  for (const product of unlinked) {
    const generic = (product.generic_name || "").trim();
    if (!generic) { queue.run(product.id, product.id, JSON.stringify({ note: "No generic name; assign a canonical medicine manually." })); queued++; continue; }
    let medicine = findMedicine.get(generic);
    if (!medicine) {
      let slug = slugify(generic) || `medicine-${product.id}`;
      if (db.prepare("SELECT 1 FROM medicines WHERE slug=?").get(slug)) slug = `${slug}-${product.id}`;
      medicine = { id: Number(insertMedicine.run(slug, generic, generic, product.active_ingredient, product.category, product.prescription_status, product.is_sierra_leone_eml).lastInsertRowid) };
      created++;
    }
    linkProduct.run(medicine.id, product.id);
    linked++;
  }
  return { created, linked, queued };
}
