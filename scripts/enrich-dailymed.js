import { migrate, closeDb } from "../src/db.js";

const db = migrate();
const products = db.prepare("SELECT id,display_name,generic_name,brand_name FROM products ORDER BY id").all();
const accessedAt = new Date().toISOString().slice(0, 10);
const source = db.prepare("SELECT id FROM sources WHERE organization='U.S. National Library of Medicine'").get();
const addSource = db.prepare("INSERT OR IGNORE INTO sources(organization,title,url,accessed_at,source_type,notes) VALUES (?,?,?,?,?,?)");
const addFact = db.prepare("INSERT OR IGNORE INTO medicine_facts(product_id,fact_type,title,content,warning_level,source_id,review_status,last_reviewed_at) VALUES (?,?,?,?,?,?,?,?)");
let matched = 0, unmatched = 0;

for (const product of products) {
  const name = product.generic_name || product.brand_name || product.display_name;
  const url = `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?drug_name=${encodeURIComponent(name)}&name_type=${product.brand_name ? "brand" : "generic"}&pagesize=5`;
  try {
    const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "GraceCareCatalogue/2.0 (local research import)" } });
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    const items = body.data || body.DATA || [];
    if (!items.length) { unmatched++; continue; }
    const first = items[0], setid = first.setid || first.SETID || (Array.isArray(first) ? first[0] : null), title = first.title || first.TITLE || (Array.isArray(first) ? first[1] : name);
    if (!setid) { unmatched++; continue; }
    const labelUrl = `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${encodeURIComponent(setid)}`;
    addSource.run("U.S. National Library of Medicine", title, labelUrl, accessedAt, "international_labeling", `DailyMed candidate label for ${name}. Requires human review before any label field is published.`);
    const sourceRow = db.prepare("SELECT id FROM sources WHERE url=?").get(labelUrl);
    addFact.run(product.id, "label_reference", "DailyMed labeling candidate", "A potentially relevant DailyMed label was found. Medical fields remain unpublished until a reviewer confirms that the label matches the exact medicine, formulation, and market context.", "info", sourceRow.id, "pending", null);
    matched++;
  } catch { unmatched++; }
  await new Promise(resolve => setTimeout(resolve, 80));
}
console.log(JSON.stringify({ matched, unmatched }, null, 2));
closeDb();
