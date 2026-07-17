import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { imageSize } from "image-size";
import { config } from "../src/config.js";
import { migrate, closeDb, transaction } from "../src/db.js";

const db = migrate();
const products = JSON.parse(fs.readFileSync(path.join(config.root, "data", "products.seed.json"), "utf8"));
const emlText = fs.readFileSync(path.join(config.root, "data", "sources", "sierra-leone-neml-2021.txt"), "utf8").toLowerCase();
const accessedAt = new Date().toISOString().slice(0, 10);
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const aliases = new Map([
  ["aspirin", "acetylsalicylic acid"], ["chlorphenamine", "chlorpheniramine"],
  ["co-trimoxazole", "cotrimoxazole"], ["oral rehydration salts", "oral rehydration salts"],
  ["ors + zinc", "oral rehydration salts"], ["adrenaline", "adrenaline"], ["acyclovir", "aciclovir"]
]);

function normalized(value) { return value.toLowerCase().replace(/[^a-z0-9+ -]/g, " ").replace(/\s+/g, " ").trim(); }
function emlMatch(product) {
  const candidate = aliases.get(normalized(product.displayName)) || normalized(product.genericName || product.displayName);
  if (!candidate || product.brandName) return false;
  return new RegExp(`\\b${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "\\s+")}\\b`, "i").test(emlText);
}
function hashFile(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function dimensions(file) { try { return imageSize(fs.readFileSync(file)); } catch { return {}; } }
function safePublicPath(folder, file) { return `/media/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`; }

const runId = Number(db.prepare("INSERT INTO import_runs(started_at) VALUES (?)").run(new Date().toISOString()).lastInsertRowid);
const summary = { productsCreated: 0, productsUpdated: 0, imagesImported: 0, duplicateImagesSkipped: 0, uncertainImagesFlagged: 0, true360Sequences: 0, multiViewProducts: 0, singleImageProducts: 0, productsMissingVerifiedImages: 0 };

try {
  transaction(database => {
    const sourceInsert = database.prepare("INSERT OR IGNORE INTO sources(organization,title,url,accessed_at,source_type,notes) VALUES (?,?,?,?,?,?)");
    sourceInsert.run("Sierra Leone Ministry of Health and Sanitation", "National Essential Medicines List for Sierra Leone - 2021 Edition", "https://mohs.gov.sl/download/71/parmaceutical-service/18079/national-essential-medicines-list_sierra_leone-2021-edition.pdf", accessedAt, "regional_official", "Local archived PDF: data/sources/sierra-leone-neml-2021.pdf");
    sourceInsert.run("U.S. National Library of Medicine", "DailyMed RESTful Web Services", "https://dailymed.nlm.nih.gov/dailymed/app-support-web-services.cfm", accessedAt, "international_labeling", "Used only by the explicit enrichment workflow; a search result is not automatically published as medical guidance.");
    const emlSource = database.prepare("SELECT id FROM sources WHERE url LIKE '%national-essential-medicines-list_sierra_leone-2021-edition.pdf'").get().id;
    const findProduct = database.prepare("SELECT id FROM products WHERE slug=?");
    const insertProduct = database.prepare("INSERT INTO products(slug,display_name,generic_name,brand_name,category,dosage_form,featured,review_status,is_sierra_leone_eml) VALUES (?,?,?,?,?,?,?,?,?)");
    const updateProduct = database.prepare("UPDATE products SET display_name=?,generic_name=?,brand_name=?,category=?,dosage_form=?,featured=?,is_sierra_leone_eml=?,updated_at=CURRENT_TIMESTAMP WHERE id=?");
    const insertFact = database.prepare("INSERT OR IGNORE INTO medicine_facts(product_id,fact_type,title,content,warning_level,source_id,review_status,last_reviewed_at) VALUES (?,?,?,?,?,?,?,?)");
    const findHash = database.prepare("SELECT id,product_id,local_path FROM product_images WHERE file_hash=? LIMIT 1");
    const findImage = database.prepare("SELECT id FROM product_images WHERE product_id=? AND local_path=?");
    const insertImage = database.prepare("INSERT INTO product_images(product_id,local_path,public_path,license_status,image_type,angle_label,sequence_index,is_primary,is_verified,width,height,file_hash,sort_order,review_status,review_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const queue = database.prepare("INSERT OR IGNORE INTO review_queue(entity_type,entity_id,product_id,reason,details,status) VALUES (?,?,?,?,?,'pending')");

    for (const product of products) {
      const listed = emlMatch(product) ? 1 : 0;
      let row = findProduct.get(product.slug);
      if (!row) { row = { id: Number(insertProduct.run(product.slug, product.displayName, product.genericName, product.brandName, product.category, product.dosageForm, product.featured ? 1 : 0, "needs_medical_review", listed).lastInsertRowid) }; summary.productsCreated++; }
      else { updateProduct.run(product.displayName, product.genericName, product.brandName, product.category, product.dosageForm, product.featured ? 1 : 0, listed, row.id); summary.productsUpdated++; }
      if (listed) insertFact.run(row.id, "sierra_leone_eml", "Sierra Leone Essential Medicines List", "The generic medicine name appears in the 2021 National Essential Medicines List. Exact listed formulations and strengths must be checked in the cited source.", "info", emlSource, "reviewed", accessedAt);
      const folderPath = path.join(config.imageRoot, product.folder);
      const files = fs.existsSync(folderPath) ? fs.readdirSync(folderPath).filter(file => imageExtensions.has(path.extname(file).toLowerCase())).sort() : [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index], full = path.join(folderPath, file), local = path.relative(config.root, full).replaceAll("\\", "/"), hash = hashFile(full);
        if (findImage.get(row.id, local)) continue;
        const duplicate = findHash.get(hash);
        if (duplicate) { summary.duplicateImagesSkipped++; queue.run("image", duplicate.id, row.id, "exact_duplicate_hash", JSON.stringify({ candidate: local, existing: duplicate.local_path })); continue; }
        const size = dimensions(full), isPrimary = file === product.primaryFile, verified = isPrimary ? 1 : 0;
        const imageId = Number(insertImage.run(row.id, local, safePublicPath(product.folder, file), "needs_review", isPrimary ? "product" : "candidate", isPrimary ? "Primary reference" : "Unknown view", null, isPrimary ? 1 : 0, verified, size.width || null, size.height || null, hash, isPrimary ? 0 : index + 1, isPrimary ? "reviewed_folder_match" : "pending", isPrimary ? "Previously selected after visual folder-level review; exact package attributes still require confirmation." : "Folder-name match only; exact brand, strength, form, and package identity are unverified.").lastInsertRowid);
        summary.imagesImported++;
        if (!verified) { summary.uncertainImagesFlagged++; queue.run("image", imageId, row.id, "exact_product_identity_unverified", JSON.stringify({ localPath: local, folder: product.folder })); }
      }
    }
  });

  const counts = db.prepare("SELECT p.id, COUNT(i.id) verified FROM products p LEFT JOIN product_images i ON i.product_id=p.id AND i.is_verified=1 GROUP BY p.id").all();
  for (const count of counts) { if (count.verified >= 12) summary.true360Sequences++; else if (count.verified >= 2) summary.multiViewProducts++; else if (count.verified === 1) summary.singleImageProducts++; else summary.productsMissingVerifiedImages++; }
  db.prepare("UPDATE import_runs SET finished_at=?,summary_json=?,status='complete' WHERE id=?").run(new Date().toISOString(), JSON.stringify(summary), runId);
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  db.prepare("UPDATE import_runs SET finished_at=?,summary_json=?,status='failed' WHERE id=?").run(new Date().toISOString(), JSON.stringify({ error: error.message }), runId);
  throw error;
} finally { closeDb(); }
