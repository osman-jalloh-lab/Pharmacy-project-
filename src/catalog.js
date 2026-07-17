import { getDb } from "./db.js";
import { wholesaleSummary } from "./wholesale.js";

const productSelect = `
  SELECT p.*,
    (SELECT public_path FROM product_images i WHERE i.product_id=p.id AND i.is_verified=1 ORDER BY i.is_primary DESC,i.sort_order,i.id LIMIT 1) primary_image,
    (SELECT COUNT(*) FROM product_images i WHERE i.product_id=p.id AND i.is_verified=1) verified_image_count,
    (SELECT COUNT(*) FROM product_images i WHERE i.product_id=p.id) candidate_image_count
  FROM products p`;

function mapProduct(row) {
  if (!row) return null;
  const product = {
    id: row.id, slug: row.slug, displayName: row.display_name, genericName: row.generic_name,
    brandName: row.brand_name, activeIngredient: row.active_ingredient, category: row.category,
    dosageForm: row.dosage_form, strength: row.strength, manufacturer: row.manufacturer,
    packageSize: row.package_size, description: row.description, commonUses: row.common_uses,
    keyFacts: row.key_facts, prescriptionStatus: row.prescription_status,
    availabilityStatus: row.availability_status, featured: Boolean(row.featured),
    reviewStatus: row.review_status, sierraLeoneEml: row.is_sierra_leone_eml == null ? null : Boolean(row.is_sierra_leone_eml),
    lastMedicalReviewAt: row.last_medical_review_at, primaryImage: row.primary_image,
    verifiedImageCount: Number(row.verified_image_count || 0), candidateImageCount: Number(row.candidate_image_count || 0),
    unitsPerBox: row.units_per_box, unitKind: row.unit_kind, boxesPerCarton: row.boxes_per_carton,
    unitsPerCarton: row.units_per_carton, minimumCartons: row.minimum_cartons, availableCartons: row.available_cartons,
    pricePerCartonCents: row.price_per_carton_cents, currency: row.currency, pricingMode: row.pricing_mode,
    wholesaleStatus: row.wholesale_status, wholesaleEnabled: Boolean(row.wholesale_enabled),
    directCheckoutEnabled: Boolean(row.direct_checkout_enabled), packagingReviewStatus: row.packaging_review_status
  };
  product.wholesale = wholesaleSummary(product);
  return product;
}

export function listProducts({ q = "", category = "", limit = 100, offset = 0 } = {}) {
  const db = getDb(), clauses = [], values = [];
  // Every word in the query must match at least one identifying field, so
  // "Amoxicillin 500 mg" and "Paracetamol tablets" narrow instead of failing.
  for (const token of String(q).split(/\s+/).filter(Boolean).slice(0, 6)) {
    clauses.push("(p.display_name LIKE ? OR p.generic_name LIKE ? OR p.brand_name LIKE ? OR p.active_ingredient LIKE ? OR p.strength LIKE ? OR p.manufacturer LIKE ? OR p.category LIKE ? OR p.dosage_form LIKE ?)");
    for (let i = 0; i < 8; i++) values.push(`%${token}%`);
  }
  if (category) { clauses.push("p.category=?"); values.push(category); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) count FROM products p${where}`).get(...values).count;
  const rows = db.prepare(`${productSelect}${where} ORDER BY p.featured DESC,p.display_name LIMIT ? OFFSET ?`).all(...values, limit, offset);
  return { items: rows.map(mapProduct), total: Number(total), limit, offset };
}

export function getProduct(slug, { admin = false } = {}) {
  const db = getDb(), row = db.prepare(`${productSelect} WHERE p.slug=?`).get(slug);
  if (!row) return null;
  const product = mapProduct(row);
  product.images = db.prepare(`SELECT id,public_path publicPath,angle_label angleLabel,sequence_index sequenceIndex,is_primary isPrimary,is_verified isVerified,width,height,source_page sourcePage,source_title sourceTitle,license_status licenseStatus,review_status reviewStatus,review_reason reviewReason,sort_order sortOrder FROM product_images WHERE product_id=? ${admin ? "" : "AND is_verified=1"} ORDER BY is_primary DESC,sort_order,id`).all(row.id).map(image => ({ ...image, isPrimary: Boolean(image.isPrimary), isVerified: Boolean(image.isVerified) }));
  product.facts = db.prepare(`SELECT f.id,f.fact_type factType,f.title,f.content,f.warning_level warningLevel,f.review_status reviewStatus,f.last_reviewed_at lastReviewedAt,s.id sourceId,s.organization,s.title sourceTitle,s.url sourceUrl,s.accessed_at accessedAt FROM medicine_facts f LEFT JOIN sources s ON s.id=f.source_id WHERE f.product_id=? ${admin ? "" : "AND f.review_status='reviewed'"} ORDER BY f.id`).all(row.id);
  const sequenced = product.images.filter(i => i.isVerified && i.sequenceIndex != null).length;
  product.viewerMode = product.verifiedImageCount >= 12 && sequenced === product.verifiedImageCount ? "360" : product.verifiedImageCount >= 2 ? "multi" : product.verifiedImageCount === 1 ? "single" : "missing";
  product.viewerLabel = product.viewerMode === "360" ? "360° View" : product.viewerMode === "multi" ? "Multi-View Product Gallery" : product.viewerMode === "single" ? "Single Product Image" : "Image review pending";
  // Sibling records sharing the same generic name are presented as selectable variations.
  product.variations = product.genericName
    ? db.prepare(`${productSelect} WHERE p.generic_name=? AND p.id<>? ORDER BY p.display_name`).all(product.genericName, product.id)
        .map(mapProduct).map(v => ({ id: v.id, slug: v.slug, displayName: v.displayName, brandName: v.brandName, strength: v.strength, dosageForm: v.dosageForm, packageSize: v.packageSize, manufacturer: v.manufacturer, wholesale: v.wholesale }))
    : [];
  return product;
}

export function getProductsByIds(ids) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = getDb().prepare(`${productSelect} WHERE p.id IN (${unique.map(() => "?").join(",")})`).all(...unique);
  return new Map(rows.map(row => { const product = mapProduct(row); return [product.id, product]; }));
}

export function categories() {
  return getDb().prepare("SELECT category,COUNT(*) count FROM products GROUP BY category ORDER BY category").all().map(row => ({ name: row.category, count: Number(row.count) }));
}
