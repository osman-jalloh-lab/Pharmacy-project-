// Repeatable catalogue data-quality audit: npm run audit:catalogue
// Prints a human-readable summary and writes a machine-readable JSON report.
import fs from "node:fs";
import path from "node:path";
import { migrate, getDb, closeDb } from "../src/db.js";
import { config } from "../src/config.js";
import { productIdentityKey } from "../src/medicines.js";

migrate();
const db = getDb();
const count = sql => Number(db.prepare(sql).get().c);
const injection = "(p.dosage_form LIKE '%inject%' OR p.dosage_form LIKE '%infusion%')";
const factFor = extra => `EXISTS(SELECT 1 FROM medicine_facts f WHERE ((f.scope='product' AND f.product_id=p.id) OR (f.scope='medicine' AND f.medicine_id=p.medicine_id)) ${extra})`;

const report = {
  generatedAt: new Date().toISOString(),
  totals: {
    medicines: count("SELECT COUNT(*) c FROM medicines"),
    products: count("SELECT COUNT(*) c FROM products p"),
    reviewedFacts: count("SELECT COUNT(*) c FROM medicine_facts f WHERE f.review_status='reviewed'"),
    pendingFacts: count("SELECT COUNT(*) c FROM medicine_facts f WHERE f.review_status='pending'"),
    sources: count("SELECT COUNT(*) c FROM sources s")
  },
  products: {
    withoutCanonicalMedicine: count("SELECT COUNT(*) c FROM products p WHERE p.medicine_id IS NULL"),
    missingDosageForm: count("SELECT COUNT(*) c FROM products p WHERE p.dosage_form IS NULL"),
    missingStrength: count("SELECT COUNT(*) c FROM products p WHERE p.strength IS NULL"),
    missingManufacturer: count("SELECT COUNT(*) c FROM products p WHERE p.manufacturer IS NULL"),
    missingPackageSize: count("SELECT COUNT(*) c FROM products p WHERE p.package_size IS NULL"),
    missingCartonConfiguration: count("SELECT COUNT(*) c FROM products p WHERE p.boxes_per_carton IS NULL OR p.packaging_review_status<>'confirmed'"),
    missingReviewedImage: count("SELECT COUNT(*) c FROM products p WHERE NOT EXISTS(SELECT 1 FROM product_images i WHERE i.product_id=p.id AND i.is_verified=1)"),
    singleReviewedImage: count("SELECT COUNT(*) c FROM products p WHERE (SELECT COUNT(*) FROM product_images i WHERE i.product_id=p.id AND i.is_verified=1)=1"),
    multipleReviewedImages: count("SELECT COUNT(*) c FROM products p WHERE (SELECT COUNT(*) FROM product_images i WHERE i.product_id=p.id AND i.is_verified=1)>=2"),
    verified360Sequences: count("SELECT COUNT(*) c FROM products p WHERE (SELECT COUNT(*) FROM product_images i WHERE i.product_id=p.id AND i.is_verified=1 AND i.sequence_index IS NOT NULL)>=12"),
    missingMedicalFacts: count(`SELECT COUNT(*) c FROM products p WHERE NOT ${factFor("")}`),
    missingSideEffects: count(`SELECT COUNT(*) c FROM products p WHERE NOT ${factFor("AND f.fact_type LIKE 'side_effects%'")}`),
    missingWarnings: count(`SELECT COUNT(*) c FROM products p WHERE NOT ${factFor("AND f.fact_type IN ('warnings','contraindications')")}`)
  },
  injections: {
    total: count(`SELECT COUNT(*) c FROM products p WHERE ${injection}`),
    missingContainerType: count(`SELECT COUNT(*) c FROM products p WHERE ${injection} AND p.container_type IS NULL`),
    missingConcentration: count(`SELECT COUNT(*) c FROM products p WHERE ${injection} AND p.concentration IS NULL AND p.strength IS NULL`),
    missingRoute: count(`SELECT COUNT(*) c FROM products p WHERE ${injection} AND p.route IS NULL`),
    missingStorage: count(`SELECT COUNT(*) c FROM products p WHERE ${injection} AND p.storage_requirements IS NULL AND p.storage_temperature IS NULL`)
  },
  facts: {
    reviewedOverAYearAgo: count("SELECT COUNT(*) c FROM medicine_facts f WHERE f.review_status='reviewed' AND (f.last_reviewed_at IS NULL OR f.last_reviewed_at < datetime('now','-1 year'))")
  },
  sources: {
    missingOrNonHttpUrl: count("SELECT COUNT(*) c FROM sources s WHERE s.url IS NULL OR (s.url NOT LIKE 'http://%' AND s.url NOT LIKE 'https://%')")
  }
};

// Potential duplicates: identical identity fingerprints across different rows,
// computed from stored attributes only. Sparse records that share a generic name
// and nothing else are listed for review, never merged automatically.
const fingerprints = new Map();
for (const row of db.prepare("SELECT id,slug,generic_name genericName,brand_name brandName,manufacturer,dosage_form dosageForm,strength,concentration,container_type containerType,container_volume_ml containerVolumeMl,package_size packageSize FROM products").all()) {
  const key = productIdentityKey(row);
  if (!fingerprints.has(key)) fingerprints.set(key, []);
  fingerprints.get(key).push(row.slug);
}
report.potentialDuplicates = [...fingerprints.values()].filter(group => group.length > 1);

const outputPath = path.join(config.root, "data", "catalogue-audit.json");
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

console.log("Catalogue audit");
console.log("===============");
for (const [section, values] of Object.entries(report)) {
  if (section === "generatedAt") continue;
  if (section === "potentialDuplicates") { console.log(`potential duplicate groups: ${values.length}${values.length ? " -> " + JSON.stringify(values.slice(0, 5)) : ""}`); continue; }
  console.log(section + ":");
  for (const [name, valueCount] of Object.entries(values)) console.log(`  ${name}: ${valueCount}`);
}
console.log(`\nJSON report: ${outputPath}`);
closeDb();
