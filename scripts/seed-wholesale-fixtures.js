// Development-only wholesale fixtures.
//
// The real catalogue has no supplier-confirmed packaging or pricing yet, so this
// script creates clearly labeled fake products (slug prefix "fixture-", name prefix
// "[DEV FIXTURE]", category "Development fixtures") to exercise the carton
// calculator, cart, checkout, and inquiry flows end to end. It only ever touches
// rows whose slug starts with "fixture-" and refuses to run in production.
import { migrate, getDb, closeDb, transaction } from "../src/db.js";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed development fixtures in production.");
  process.exit(1);
}

migrate();
const db = getDb();

if (process.argv.includes("--remove")) {
  const removed = db.prepare("DELETE FROM products WHERE slug LIKE 'fixture-%'").run().changes;
  console.log(`Removed ${removed} development fixture products.`);
  closeDb();
  process.exit(0);
}

const FIXTURES = [
  {
    slug: "fixture-amoxicillin-500-capsules",
    display_name: "[DEV FIXTURE] Amoxicillin 500 mg Capsules",
    generic_name: "Amoxicillin (fixture)", brand_name: "Fixture Pharma", active_ingredient: "Amoxicillin trihydrate",
    strength: "500 mg", dosage_form: "Capsules", manufacturer: "Fixture Laboratories Ltd", package_size: "10 strips of 10 capsules per box",
    description: "Development fixture used to test the wholesale carton calculator. Not a real product.",
    units_per_box: 10, unit_kind: "strips", boxes_per_carton: 20, minimum_cartons: 10, available_cartons: 120,
    price_per_carton_cents: 275000, currency: "SLE", pricing_mode: "fixed", wholesale_status: "in_stock",
    wholesale_enabled: 1, direct_checkout_enabled: 1, packaging_review_status: "confirmed"
  },
  {
    slug: "fixture-amoxicillin-250-capsules",
    display_name: "[DEV FIXTURE] Amoxicillin 250 mg Capsules",
    generic_name: "Amoxicillin (fixture)", brand_name: "Fixture Pharma", active_ingredient: "Amoxicillin trihydrate",
    strength: "250 mg", dosage_form: "Capsules", manufacturer: "Fixture Laboratories Ltd", package_size: "10 strips of 10 capsules per box",
    description: "Development fixture variation for testing the variation selector. Not a real product.",
    units_per_box: 10, unit_kind: "strips", boxes_per_carton: 24, minimum_cartons: 10, available_cartons: 18,
    price_per_carton_cents: 210000, currency: "SLE", pricing_mode: "fixed", wholesale_status: "low_stock",
    wholesale_enabled: 1, direct_checkout_enabled: 1, packaging_review_status: "confirmed"
  },
  {
    slug: "fixture-amoxicillin-suspension",
    display_name: "[DEV FIXTURE] Amoxicillin 125 mg/5 mL Suspension",
    generic_name: "Amoxicillin (fixture)", brand_name: "Fixture Pharma", active_ingredient: "Amoxicillin trihydrate",
    strength: "125 mg/5 mL", dosage_form: "Oral suspension", manufacturer: "Fixture Laboratories Ltd", package_size: "1 bottle of 100 mL per box",
    description: "Development fixture with quotation-only pricing. Not a real product.",
    units_per_box: 1, unit_kind: "bottles", boxes_per_carton: 48, minimum_cartons: 5, available_cartons: null,
    price_per_carton_cents: null, currency: null, pricing_mode: "quote_required", wholesale_status: "quote_required",
    wholesale_enabled: 1, direct_checkout_enabled: 0, packaging_review_status: "confirmed"
  },
  {
    slug: "fixture-paracetamol-500-tablets",
    display_name: "[DEV FIXTURE] Paracetamol 500 mg Tablets",
    generic_name: "Paracetamol (fixture)", brand_name: "Fixture Health", active_ingredient: "Paracetamol",
    strength: "500 mg", dosage_form: "Tablets", manufacturer: "Fixture Laboratories Ltd", package_size: "10 strips of 10 tablets per box",
    description: "Development fixture that is out of stock, for testing availability inquiries. Not a real product.",
    units_per_box: 10, unit_kind: "strips", boxes_per_carton: 40, minimum_cartons: 10, available_cartons: 0,
    price_per_carton_cents: 140000, currency: "SLE", pricing_mode: "fixed", wholesale_status: "out_of_stock",
    wholesale_enabled: 1, direct_checkout_enabled: 1, packaging_review_status: "confirmed"
  },
  {
    slug: "fixture-omeprazole-20-capsules",
    display_name: "[DEV FIXTURE] Omeprazole 20 mg Capsules",
    generic_name: "Omeprazole (fixture)", brand_name: "Fixture Health", active_ingredient: "Omeprazole",
    strength: "20 mg", dosage_form: "Capsules", manufacturer: "Fixture Laboratories Ltd", package_size: null,
    description: "Development fixture with unconfirmed packaging, for testing the inquiry-only path. Not a real product.",
    units_per_box: null, unit_kind: null, boxes_per_carton: null, minimum_cartons: null, available_cartons: null,
    price_per_carton_cents: null, currency: null, pricing_mode: "quote_required", wholesale_status: "available_by_request",
    wholesale_enabled: 1, direct_checkout_enabled: 0, packaging_review_status: "needs_review"
  }
];

transaction(database => {
  const removed = database.prepare("DELETE FROM products WHERE slug LIKE 'fixture-%'").run().changes;
  const columns = ["slug", "display_name", "generic_name", "brand_name", "active_ingredient", "strength", "dosage_form", "manufacturer", "package_size", "description", "units_per_box", "unit_kind", "boxes_per_carton", "minimum_cartons", "available_cartons", "price_per_carton_cents", "currency", "pricing_mode", "wholesale_status", "wholesale_enabled", "direct_checkout_enabled", "packaging_review_status"];
  const insert = database.prepare(`INSERT INTO products(category,review_status,${columns.join(",")}) VALUES ('Development fixtures','reviewed',${columns.map(() => "?").join(",")})`);
  for (const fixture of FIXTURES) insert.run(...columns.map(column => fixture[column]));
  console.log(`Replaced ${removed} fixture rows with ${FIXTURES.length} development fixtures (slugs prefixed "fixture-").`);
});

console.log("Remove them any time with: npm run seed:fixtures -- --remove");
closeDb();
