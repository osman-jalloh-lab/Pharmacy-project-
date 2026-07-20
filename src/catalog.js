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
    directCheckoutEnabled: Boolean(row.direct_checkout_enabled), packagingReviewStatus: row.packaging_review_status,
    medicineId: row.medicine_id, concentration: row.concentration, route: row.route,
    countryOfManufacture: row.country_of_manufacture, containerType: row.container_type,
    containerVolumeMl: row.container_volume_ml, formulationState: row.formulation_state,
    requiresReconstitution: row.requires_reconstitution == null ? null : Boolean(row.requires_reconstitution),
    dilutionRequired: row.dilution_required == null ? null : Boolean(row.dilution_required),
    doseContainer: row.dose_container,
    professionalUseOnly: row.professional_use_only == null ? null : Boolean(row.professional_use_only),
    coldChainRequired: row.cold_chain_required == null ? null : Boolean(row.cold_chain_required),
    storageTemperature: row.storage_temperature,
    protectFromLight: row.protect_from_light == null ? null : Boolean(row.protect_from_light),
    storageRequirements: row.storage_requirements
  };
  product.wholesale = wholesaleSummary(product);
  return product;
}

export function listProducts({ q = "", category = "", dosageForm = "", manufacturer = "", prescriptionStatus = "", wholesaleStatus = "", limit = 100, offset = 0 } = {}) {
  const db = getDb(), clauses = [], values = [];
  // Every word in the query must match at least one identifying field, so
  // "Amoxicillin 500 mg" and "ceftriaxone 1 g vial" narrow instead of failing.
  for (const token of String(q).split(/\s+/).filter(Boolean).slice(0, 6)) {
    clauses.push("(p.display_name LIKE ? OR p.generic_name LIKE ? OR p.brand_name LIKE ? OR p.active_ingredient LIKE ? OR p.strength LIKE ? OR p.concentration LIKE ? OR p.manufacturer LIKE ? OR p.category LIKE ? OR p.dosage_form LIKE ? OR p.container_type LIKE ? OR p.package_size LIKE ?)");
    for (let i = 0; i < 11; i++) values.push(`%${token}%`);
  }
  if (category) { clauses.push("p.category=?"); values.push(category); }
  if (dosageForm) { clauses.push("p.dosage_form LIKE ?"); values.push(`%${dosageForm}%`); }
  if (manufacturer) { clauses.push("p.manufacturer=?"); values.push(manufacturer); }
  if (prescriptionStatus) { clauses.push("p.prescription_status=?"); values.push(prescriptionStatus); }
  if (wholesaleStatus) { clauses.push("p.wholesale_status=?"); values.push(wholesaleStatus); }
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
  // Product-scope facts for this exact record plus medicine-scope facts shared
  // by every product of the canonical medicine. Public sees reviewed facts only.
  product.facts = db.prepare(`SELECT f.id,f.fact_type factType,f.scope,f.title,f.content,f.warning_level warningLevel,f.review_status reviewStatus,f.last_reviewed_at lastReviewedAt,s.id sourceId,s.organization,s.title sourceTitle,s.url sourceUrl,s.accessed_at accessedAt FROM medicine_facts f LEFT JOIN sources s ON s.id=f.source_id WHERE ((f.scope='product' AND f.product_id=?) OR (f.scope='medicine' AND f.medicine_id IS NOT NULL AND f.medicine_id=?)) ${admin ? "" : "AND f.review_status='reviewed'"} ORDER BY f.scope DESC,f.id`).all(row.id, row.medicine_id ?? -1);
  product.medicine = row.medicine_id ? db.prepare("SELECT id,slug,generic_name genericName,preferred_display_name preferredDisplayName,active_ingredient activeIngredient,therapeutic_category therapeuticCategory,prescription_status prescriptionStatus,is_sierra_leone_eml sierraLeoneEml,review_status reviewStatus,last_medical_review_at lastMedicalReviewAt FROM medicines WHERE id=?").get(row.medicine_id) || null : null;
  const sequenced = product.images.filter(i => i.isVerified && i.sequenceIndex != null).length;
  product.viewerMode = product.verifiedImageCount >= 12 && sequenced === product.verifiedImageCount ? "360" : product.verifiedImageCount >= 2 ? "multi" : product.verifiedImageCount === 1 ? "single" : "missing";
  product.viewerLabel = product.viewerMode === "360" ? "360° View" : product.viewerMode === "multi" ? "Multi-View Product Gallery" : product.viewerMode === "single" ? "Single Product Image" : "Image review pending";
  // Sibling records of the same canonical medicine (generic-name fallback for
  // unlinked records) are the only source of selectable variations, so the
  // guided selector can never offer a combination that has no exact product.
  const trimVariation = v => ({ id: v.id, slug: v.slug, displayName: v.displayName, brandName: v.brandName, strength: v.strength, concentration: v.concentration, dosageForm: v.dosageForm, containerType: v.containerType, containerVolumeMl: v.containerVolumeMl, packageSize: v.packageSize, manufacturer: v.manufacturer, wholesale: v.wholesale });
  const siblingWhere = row.medicine_id ? "p.medicine_id=?" : "p.generic_name=?";
  const siblingKey = row.medicine_id ?? product.genericName;
  product.variations = siblingKey != null
    ? db.prepare(`${productSelect} WHERE ${siblingWhere} AND p.id<>? ORDER BY p.dosage_form,p.strength,p.display_name`).all(siblingKey, product.id).map(mapProduct).map(trimVariation)
    : [];
  return product;
}

export function listMedicines({ q = "", limit = 100, offset = 0 } = {}) {
  const db = getDb(), clauses = [], values = [];
  if (q) { clauses.push("(m.generic_name LIKE ? OR m.preferred_display_name LIKE ? OR m.active_ingredient LIKE ? OR m.therapeutic_category LIKE ?)"); for (let i = 0; i < 4; i++) values.push(`%${q}%`); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) count FROM medicines m${where}`).get(...values).count;
  const rows = db.prepare(`SELECT m.*,(SELECT COUNT(*) FROM products p WHERE p.medicine_id=m.id) product_count FROM medicines m${where} ORDER BY m.generic_name LIMIT ? OFFSET ?`).all(...values, limit, offset);
  return { items: rows.map(m => ({ id: m.id, slug: m.slug, genericName: m.generic_name, preferredDisplayName: m.preferred_display_name, activeIngredient: m.active_ingredient, therapeuticCategory: m.therapeutic_category, prescriptionStatus: m.prescription_status, sierraLeoneEml: m.is_sierra_leone_eml == null ? null : Boolean(m.is_sierra_leone_eml), reviewStatus: m.review_status, productCount: Number(m.product_count) })), total: Number(total), limit, offset };
}

export function getMedicine(slug, { admin = false } = {}) {
  const db = getDb(), row = db.prepare("SELECT * FROM medicines WHERE slug=?").get(slug);
  if (!row) return null;
  const medicine = { id: row.id, slug: row.slug, genericName: row.generic_name, preferredDisplayName: row.preferred_display_name, activeIngredient: row.active_ingredient, therapeuticCategory: row.therapeutic_category, description: row.description, prescriptionStatus: row.prescription_status, sierraLeoneEml: row.is_sierra_leone_eml == null ? null : Boolean(row.is_sierra_leone_eml), reviewStatus: row.review_status, lastMedicalReviewAt: row.last_medical_review_at };
  medicine.products = db.prepare(`${productSelect} WHERE p.medicine_id=? ORDER BY p.dosage_form,p.strength,p.display_name`).all(row.id).map(mapProduct);
  medicine.facts = db.prepare(`SELECT f.id,f.fact_type factType,f.scope,f.title,f.content,f.warning_level warningLevel,f.review_status reviewStatus,f.last_reviewed_at lastReviewedAt,s.organization,s.title sourceTitle,s.url sourceUrl,s.accessed_at accessedAt FROM medicine_facts f LEFT JOIN sources s ON s.id=f.source_id WHERE f.scope='medicine' AND f.medicine_id=? ${admin ? "" : "AND f.review_status='reviewed'"} ORDER BY f.id`).all(row.id);
  return medicine;
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
