// Demo wholesale data for the REAL catalogue (development/demo use only).
//
// Fills every untouched product with plausible but FAKE packaging, stock, and
// per-carton pricing so the full customer flow (carton calculator, cart,
// checkout, inquiries) works across the whole catalogue. Values are
// deterministic per product id, so reruns are stable.
//
//   npm run seed:demo              stamp demo data on untouched products
//   npm run seed:demo -- --remove  reset wholesale fields on ALL non-fixture products
//
// The remove flag resets every non-fixture product's wholesale fields to the
// unconfigured defaults, including any values an admin entered by hand.
import { migrate, getDb, closeDb, transaction } from "../src/db.js";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo pricing in production.");
  process.exit(1);
}

migrate();
const db = getDb();

if (process.argv.includes("--remove")) {
  const reset = db.prepare(`UPDATE products SET units_per_box=NULL,unit_kind=NULL,boxes_per_carton=NULL,units_per_carton=NULL,minimum_cartons=NULL,available_cartons=NULL,price_per_carton_cents=NULL,currency=NULL,pricing_mode='quote_required',wholesale_status='available_by_request',wholesale_enabled=0,direct_checkout_enabled=0,packaging_review_status='needs_review',updated_at=CURRENT_TIMESTAMP WHERE slug NOT LIKE 'fixture-%'`).run().changes;
  console.log(`Reset wholesale fields on ${reset} non-fixture products.`);
  closeDb();
  process.exit(0);
}

// Small deterministic PRNG so each product keeps the same demo values across runs.
function rng(seed) { let s = seed * 2654435761 % 4294967296; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const pick = (random, list) => list[Math.floor(random() * list.length)];

function unitKindFor(dosageForm) {
  const form = String(dosageForm || "").toLowerCase();
  if (/tablet|caplet|capsule/.test(form)) return { unitKind: "strips", unitsPerBox: 10 };
  if (/syrup|suspension|solution|drops|elixir/.test(form)) return { unitKind: "bottles", unitsPerBox: 1 };
  if (/inject|ampoule|vial/.test(form)) return { unitKind: "ampoules", unitsPerBox: 10 };
  if (/cream|ointment|gel/.test(form)) return { unitKind: "tubes", unitsPerBox: 12 };
  if (/inhaler|aerosol/.test(form)) return { unitKind: "inhalers", unitsPerBox: 1 };
  if (/sachet|powder|salts/.test(form)) return { unitKind: "sachets", unitsPerBox: 20 };
  if (/supposit|pessar/.test(form)) return { unitKind: "strips", unitsPerBox: 5 };
  return { unitKind: "packs", unitsPerBox: 10 };
}

const candidates = db.prepare("SELECT id,slug,dosage_form FROM products WHERE slug NOT LIKE 'fixture-%' AND packaging_review_status='needs_review' AND boxes_per_carton IS NULL AND wholesale_enabled=0").all();

transaction(database => {
  const update = database.prepare(`UPDATE products SET units_per_box=?,unit_kind=?,boxes_per_carton=?,minimum_cartons=?,available_cartons=?,price_per_carton_cents=?,currency='SLE',pricing_mode='fixed',wholesale_status=?,wholesale_enabled=1,direct_checkout_enabled=1,packaging_review_status='confirmed',updated_at=CURRENT_TIMESTAMP WHERE id=?`);
  for (const product of candidates) {
    const random = rng(product.id + 7);
    const { unitKind, unitsPerBox } = unitKindFor(product.dosage_form);
    const boxesPerCarton = pick(random, [12, 20, 24, 30, 36, 40, 48]);
    const minimumCartons = pick(random, [5, 5, 10]);
    const lowStock = product.id % 9 === 0;
    const availableCartons = lowStock ? minimumCartons + Math.floor(random() * 12) : 60 + Math.floor(random() * 23) * 20;
    const priceCents = (18 + Math.floor(random() * 162)) * 5000; // Le 900 to Le 8,950 per carton in Le 50 steps
    update.run(unitsPerBox, unitKind, boxesPerCarton, minimumCartons, availableCartons, priceCents, lowStock ? "low_stock" : "in_stock", product.id);
  }
  console.log(`Stamped demo wholesale data on ${candidates.length} products (fake pricing, deterministic per id).`);
});

console.log("These prices are placeholders for demonstration, not real quotes. Revert with: npm run seed:demo -- --remove");
closeDb();
