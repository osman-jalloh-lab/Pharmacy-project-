import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "grace-care-test-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(temp, "test.db");
process.env.ADMIN_PASSWORD = "test-admin-secret";
process.env.ALLOWED_ORIGINS = "http://localhost:3000";

const { migrate, getDb, closeDb } = await import("../src/db.js");
const db = migrate();
const productId = Number(db.prepare("INSERT INTO products(slug,display_name,generic_name,category,review_status,is_sierra_leone_eml) VALUES (?,?,?,?,?,?)").run("test-medicine", "Test Medicine", "Test Medicine", "Test Category", "reviewed", 1).lastInsertRowid);

function insertWholesale(slug, name, overrides = {}) {
  const row = {
    generic_name: "Test Amoxicillin", brand_name: "Test Brand", strength: "500 mg", dosage_form: "Capsules",
    units_per_box: 10, unit_kind: "strips", boxes_per_carton: 24, units_per_carton: null,
    minimum_cartons: 10, available_cartons: 40, price_per_carton_cents: 12000, currency: "USD",
    pricing_mode: "fixed", wholesale_status: "in_stock", wholesale_enabled: 1, direct_checkout_enabled: 1,
    packaging_review_status: "confirmed", ...overrides
  };
  const keys = Object.keys(row);
  return Number(db.prepare(`INSERT INTO products(slug,display_name,category,review_status,${keys.join(",")}) VALUES (?,?,?,?,${keys.map(() => "?").join(",")})`).run(slug, name, "Test Category", "reviewed", ...keys.map(k => row[k])).lastInsertRowid);
}
const wholesaleId = insertWholesale("test-amoxicillin-500", "Test Amoxicillin 500 mg");
const quoteId = insertWholesale("test-paracetamol-quote", "Test Paracetamol 500 mg", { generic_name: "Test Paracetamol", pricing_mode: "quote_required", price_per_carton_cents: null, wholesale_status: "quote_required", direct_checkout_enabled: 0, available_cartons: null, minimum_cartons: 5 });
const incompleteId = insertWholesale("test-omeprazole-incomplete", "Test Omeprazole 20 mg", { generic_name: "Test Omeprazole", units_per_box: null, boxes_per_carton: null, packaging_review_status: "needs_review", direct_checkout_enabled: 0 });
const outOfStockId = insertWholesale("test-cipro-oos", "Test Ciprofloxacin 500 mg", { generic_name: "Test Ciprofloxacin", wholesale_status: "out_of_stock", available_cartons: 0 });
const imageId = Number(db.prepare("INSERT INTO product_images(product_id,local_path,public_path,file_hash,is_primary,is_verified,review_status,angle_label) VALUES (?,?,?,?,?,?,?,?)").run(productId, ".product_image_candidates/test.jpg", "/media/test.jpg", "abc123", 1, 1, "reviewed", "Front").lastInsertRowid);
const queueId = Number(db.prepare("INSERT INTO review_queue(entity_type,entity_id,product_id,reason,details) VALUES (?,?,?,?,?)").run("image", imageId, productId, "test_review", "{}").lastInsertRowid);
const app = (await import("../server.js")).default;
const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
const base = `http://127.0.0.1:${server.address().port}`;
const auth = `Basic ${Buffer.from("admin:test-admin-secret").toString("base64")}`;

async function request(url, options = {}) {
  const response = await fetch(base + url, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

test("health, catalogue, categories, search, details, and images", async () => {
  let result = await request("/api/health"); assert.equal(result.response.status, 200); assert.equal(result.body.database, "connected");
  result = await request("/api/products"); assert.equal(result.body.total, 5); assert.equal(result.body.items.find(p => p.slug === "test-medicine").primaryImage, "/media/test.jpg");
  result = await request("/api/search?q=Test Medicine"); assert.equal(result.body.items.length, 1);
  result = await request("/api/categories"); assert.equal(result.body.items[0].name, "Test Category");
  result = await request("/api/products/test-medicine"); assert.equal(result.body.viewerMode, "single"); assert.equal(result.body.images.length, 1);
  result = await request("/api/products/test-medicine/images"); assert.equal(result.body.viewerLabel, "Single Product Image");
});

test("inquiry validation, persistence, and duplicate protection", async () => {
  let result = await request("/api/inquiries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerName: "A", items: [] }) });
  assert.equal(result.response.status, 400);
  const payload = { customerName: "Review Person", email: "review@example.com", phone: "", message: "Please confirm availability", items: [{ productId, quantityRequested: 1, notes: "" }] };
  result = await request("/api/inquiries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal(result.response.status, 201); assert.equal(result.body.status, "submitted"); assert.ok(result.body.referenceNumber.startsWith("INQ-"));
  result = await request("/api/inquiries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal(result.response.status, 409);
  assert.equal(getDb().prepare("SELECT COUNT(*) count FROM inquiries").get().count, 1);
});

test("product payload exposes wholesale summary, packaging honesty, and variations", async () => {
  let result = await request("/api/products/test-amoxicillin-500");
  assert.equal(result.body.wholesale.enabled, true);
  assert.equal(result.body.wholesale.canAddToCart, true);
  assert.equal(result.body.wholesale.checkoutEligible, true);
  assert.equal(result.body.wholesale.packaging.unitsPerCarton, 240);
  assert.equal(result.body.wholesale.minimumCartons, 10);
  assert.equal(result.body.wholesale.availableCartons, 40);
  result = await request("/api/products/test-omeprazole-incomplete");
  assert.equal(result.body.wholesale.packaging.confirmed, false);
  assert.equal(result.body.wholesale.packaging.boxesPerCarton, null, "unconfirmed packaging must not be published");
  assert.equal(result.body.wholesale.canAddToCart, false);
  result = await request("/api/search?q=Amoxicillin 500");
  assert.ok(result.body.items.some(p => p.slug === "test-amoxicillin-500"), "search matches strength");
});

test("cart verification calculates cartons, boxes, units, and totals server-side", async () => {
  let result = await request("/api/cart/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ productId: wholesaleId, cartonQuantity: 20 }] }) });
  assert.equal(result.response.status, 200);
  const line = result.body.lines[0];
  assert.equal(line.status, "ok");
  assert.equal(line.totalBoxes, 480);
  assert.equal(line.totalUnits, 4800);
  assert.equal(line.lineSubtotalCents, 240000);
  assert.equal(result.body.summary.checkoutEligible, true);
  assert.equal(result.body.summary.subtotalCents, 240000);

  result = await request("/api/cart/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ productId: wholesaleId, cartonQuantity: 5 }] }) });
  assert.equal(result.body.lines[0].code, "below_minimum");
  result = await request("/api/cart/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ productId: wholesaleId, cartonQuantity: 50 }] }) });
  assert.equal(result.body.lines[0].code, "above_stock");
  result = await request("/api/cart/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ productId: quoteId, cartonQuantity: 10 }] }) });
  assert.equal(result.body.lines[0].status, "ok");
  assert.equal(result.body.lines[0].lineSubtotalCents, null);
  assert.equal(result.body.summary.quoteRequired, true);
  assert.equal(result.body.summary.checkoutEligible, false);
  result = await request("/api/cart/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ productId: incompleteId, cartonQuantity: 10 }] }) });
  assert.equal(result.body.lines[0].code, "packaging_unconfirmed");
  result = await request("/api/cart/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ productId: outOfStockId, cartonQuantity: 10 }] }) });
  assert.equal(result.body.lines[0].code, "not_orderable");
  result = await request("/api/cart/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ productId: wholesaleId, cartonQuantity: 2.5 }] }) });
  assert.equal(result.response.status, 400, "decimal cartons rejected");
});

test("orders are revalidated and repriced from the database", async () => {
  const contact = { customerName: "Order Person", email: "orders@example.com", destinationCountry: "Sierra Leone" };
  // Tampered price fields in the payload must be ignored.
  let result = await request("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...contact, items: [{ productId: wholesaleId, cartonQuantity: 20, pricePerCartonCents: 1 }], subtotalCents: 1 }) });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.status, "pending_verification");
  assert.ok(result.body.referenceNumber.startsWith("ORD-"));
  assert.equal(result.body.subtotalCents, 240000, "subtotal comes from server pricing, not the browser");
  const stored = getDb().prepare("SELECT * FROM order_items WHERE order_id=?").get(result.body.id);
  assert.equal(stored.price_per_carton_cents_snapshot, 12000);
  assert.equal(stored.boxes_per_carton_snapshot, 24);

  result = await request("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...contact, items: [{ productId: wholesaleId, cartonQuantity: 20 }] }) });
  assert.equal(result.response.status, 409, "duplicate order rejected");
  result = await request("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...contact, customerName: "Second Person", items: [{ productId: quoteId, cartonQuantity: 10 }] }) });
  assert.equal(result.response.status, 400, "quote-required products cannot be checked out");
  assert.equal(result.body.problems[0].code, "checkout_unavailable");
  result = await request("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...contact, customerName: "Third Person", items: [{ productId: wholesaleId, cartonQuantity: 5 }] }) });
  assert.equal(result.body.problems[0].code, "below_minimum");
});

test("wholesale inquiries store carton quantities with server-side snapshots", async () => {
  const payload = { customerName: "Wholesale Buyer", email: "buyer@example.com", businessName: "Freetown Pharmacy Ltd", destinationCountry: "Sierra Leone", destinationCity: "Freetown", inquiryReason: "wholesale_price", inquiryType: "cart", message: "Please confirm availability and shipping cost.", items: [{ productId: wholesaleId, cartonQuantity: 40, quantityRequested: 1 }, { productId: quoteId, cartonQuantity: 10, quantityRequested: 1 }] };
  const result = await request("/api/inquiries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal(result.response.status, 201);
  assert.ok(result.body.referenceNumber.startsWith("INQ-"));
  const rows = getDb().prepare("SELECT i.* FROM inquiry_items i JOIN inquiries q ON q.id=i.inquiry_id WHERE q.reference_number=? ORDER BY i.id").all(result.body.referenceNumber);
  assert.equal(rows[0].carton_quantity, 40);
  assert.equal(rows[0].boxes_per_carton_snapshot, 24);
  assert.equal(rows[0].price_per_carton_cents_snapshot, 12000);
  assert.equal(rows[1].price_per_carton_cents_snapshot, null, "quote-required products store no fabricated price");
  const inquiry = getDb().prepare("SELECT * FROM inquiries WHERE reference_number=?").get(result.body.referenceNumber);
  assert.equal(inquiry.inquiry_type, "cart");
  assert.equal(inquiry.business_name, "Freetown Pharmacy Ltd");
});

test("admin can review orders and update statuses", async () => {
  let result = await request("/api/admin/orders");
  assert.equal(result.response.status, 401);
  result = await request("/api/admin/orders", { headers: { authorization: auth } });
  assert.equal(result.response.status, 200);
  assert.ok(result.body.items.length >= 1);
  const orderId = result.body.items[0].id;
  result = await request(`/api/admin/orders/${orderId}`, { headers: { authorization: auth } });
  assert.equal(result.body.items.length, 1);
  result = await request(`/api/admin/orders/${orderId}`, { method: "PATCH", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ status: "quote_requested" }) });
  assert.equal(result.response.status, 200);
  result = await request(`/api/admin/orders/${orderId}`, { method: "PATCH", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ status: "paid_in_full" }) });
  assert.equal(result.response.status, 400, "unknown status rejected");
});

test("admin endpoints require authentication and review decisions persist", async () => {
  let result = await request("/api/admin/review-queue"); assert.equal(result.response.status, 401);
  result = await request("/api/admin/review-queue", { headers: { authorization: auth } }); assert.equal(result.response.status, 200); assert.equal(result.body.items.length, 1);
  result = await request(`/api/admin/review-queue/${queueId}`, { method: "PATCH", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ status: "rejected" }) });
  assert.equal(result.response.status, 200);
  assert.equal(getDb().prepare("SELECT status FROM review_queue WHERE id=?").get(queueId).status, "rejected");
  assert.equal(getDb().prepare("SELECT is_verified FROM product_images WHERE id=?").get(imageId).is_verified, 0);
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  const { getDb: reopen, closeDb: closeAgain } = await import("../src/db.js");
  assert.equal(reopen().prepare("SELECT COUNT(*) count FROM inquiries").get().count, 2);
  assert.equal(reopen().prepare("SELECT COUNT(*) count FROM orders").get().count, 1);
  closeAgain();
  fs.rmSync(temp, { recursive: true, force: true });
});
