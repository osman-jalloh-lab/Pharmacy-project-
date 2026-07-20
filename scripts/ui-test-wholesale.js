// Browser QA for the wholesale carton flow. Requires:
//   npm run seed:fixtures   (development fixtures)
//   npm start               (server on port 3000)
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { config } from "../src/config.js";

const executablePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const output = path.join(config.root, "docs", "screenshots");
const QA_NAME = "Automated Wholesale QA", QA_EMAIL = "wholesale-qa@example.test";

function cleanupQaRows() {
  const db = new DatabaseSync(config.dbPath);
  db.prepare("DELETE FROM orders WHERE customer_name=?").run(QA_NAME);
  db.prepare("DELETE FROM inquiries WHERE customer_name=?").run(QA_NAME);
  db.close();
}
cleanupQaRows();
fs.mkdirSync(output, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
const consoleErrors = [], pageErrors = [];
page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", error => pageErrors.push(error.message));

const summaryText = () => page.locator("#calcSummary").innerText();

// 1. Search finds the exact variation.
await page.goto("http://127.0.0.1:3000", { waitUntil: "networkidle" });
await page.locator("#search").fill("amoxicillin 500");
await page.waitForTimeout(250);
assert.ok(await page.locator('a[href*="fixture-amoxicillin-500-capsules"]').first().isVisible(), "strength-qualified search finds the fixture");

// 2. Product page: calculator math at the minimum, then 20 cartons.
await page.goto("http://127.0.0.1:3000/product.html?slug=fixture-amoxicillin-500-capsules", { waitUntil: "networkidle" });
assert.equal(await page.locator("#cartonQty").inputValue(), "10", "quantity starts at the minimum order");
assert.match(await summaryText(), /10 cartons × 20 boxes per carton = 200 boxes/);
await page.locator("#cartonQty").fill("20");
await page.waitForTimeout(80);
const summary20 = await summaryText();
assert.match(summary20, /20 cartons × 20 boxes per carton = 400 boxes/);
assert.match(summary20, /400 boxes × 10 strips per box = 4,000 strips/);
assert.match(summary20, /Le 2,750 per carton/);
assert.match(summary20, /Le 55,000/);
// Guided selector: dosage form -> strength -> exact presentation, real combinations only.
assert.equal(await page.locator('[data-sel-group="form"]').count(), 2, "two dosage forms exist for the fixture medicine");
assert.equal(await page.locator('[data-sel-group="form"][aria-pressed="true"]').innerText(), "Capsules (2)", "current dosage form preselected");
assert.equal(await page.locator('[data-sel-group="strength"]').count(), 2, "capsule strengths listed");
assert.match(await page.locator(".sel-presentations").innerText(), /Currently viewing/);
await page.locator('[data-sel-group="strength"]', { hasText: "250 mg" }).click();
assert.ok(await page.locator('.sel-presentations a[href*="fixture-amoxicillin-250-capsules"]').isVisible(), "250 mg resolves to the exact sibling record");
await page.locator('[data-sel-group="form"]', { hasText: "Oral suspension" }).click();
assert.ok(await page.locator('.sel-presentations a[href*="fixture-amoxicillin-suspension"]').isVisible(), "suspension form resolves to the exact suspension record");
assert.equal(await page.locator('[data-sel-group="strength"]').count(), 1, "impossible strength combinations are not offered");
await page.locator('.sel-presentations a[href*="fixture-amoxicillin-suspension"]').click();
await page.waitForLoadState("networkidle");
assert.match(page.url(), /fixture-amoxicillin-suspension/, "selecting a presentation updates the URL to the exact product");
await page.goBack();
await page.waitForLoadState("networkidle");
assert.match(page.url(), /fixture-amoxicillin-500-capsules/, "browser back returns to the previous exact product");
await page.locator("#cartonQty").fill("20");
await page.waitForTimeout(120);

// 3. Invalid quantities are blocked with clear messages.
await page.locator("#cartonQty").fill("5");
await page.waitForTimeout(80);
assert.match(await page.locator("#qtyError").innerText(), /minimum wholesale order is 10 cartons/i);
assert.ok(await page.locator("#addToCart").isDisabled(), "add to cart disabled below the minimum");
await page.locator("#cartonQty").fill("500");
await page.waitForTimeout(80);
assert.match(await page.locator("#qtyError").innerText(), /Only 120 cartons are currently available/);

// 4. Add 20 cartons to the cart.
await page.locator("#cartonQty").fill("20");
await page.waitForTimeout(80);
await page.locator("#addToCart").click();
assert.match(await page.locator("#cartFeedback").innerText(), /Added to cart: .*20 cartons, 400 boxes total/);
assert.equal(await page.locator("[data-cart-count]").first().innerText(), "1");
await page.screenshot({ path: path.join(output, "wholesale-product.png"), fullPage: true });

// 5. Quote-required product can join the cart; price shown as quotation.
await page.goto("http://127.0.0.1:3000/product.html?slug=fixture-amoxicillin-suspension", { waitUntil: "networkidle" });
assert.match(await page.locator(".pack-config").innerText(), /Available by quotation/);
assert.match(await summaryText(), /Wholesale pricing requires confirmation/);
await page.locator("#addToCart").click();
assert.equal(await page.locator("[data-cart-count]").first().innerText(), "2");

// 6. Incomplete packaging and out-of-stock products are inquiry-only.
await page.goto("http://127.0.0.1:3000/product.html?slug=fixture-omeprazole-20-capsules", { waitUntil: "networkidle" });
assert.match(await page.locator(".ws-panel").innerText(), /Packaging details require confirmation/);
assert.equal(await page.locator("#addToCart").count(), 0, "no cart control without confirmed packaging");
await page.goto("http://127.0.0.1:3000/product.html?slug=fixture-paracetamol-500-tablets", { waitUntil: "networkidle" });
assert.match(await page.locator(".ws-panel").innerText(), /out of stock/i);
assert.equal(await page.locator("#addToCart").count(), 0, "no cart control when out of stock");

// 7. Single-product inquiry dialog, prefilled product and quantity.
await page.locator("[data-open-inquiry]").first().click();
await page.locator("#dialogQty").fill("40");
await page.locator("#dialogName").fill(QA_NAME);
await page.locator("#dialogEmail").fill(QA_EMAIL);
await page.locator("#dialogCountry").fill("Sierra Leone");
await page.locator("#dialogMessage").fill("Automated QA: please confirm restock timing.");
await page.locator("#dialogForm button[type=submit]").click();
await page.locator("#dialogForm .form-status.success, #dialogForm .success").first().waitFor();
assert.match(await page.locator("#dialogForm").innerText(), /INQ-/, "inquiry confirmation shows a reference number");
await page.keyboard.press("Escape");

// 8. Cart page: totals, quantity edit, checkout blocked while a quote item is present.
await page.goto("http://127.0.0.1:3000/cart.html", { waitUntil: "networkidle" });
await page.locator(".cart-line").first().waitFor();
assert.equal(await page.locator(".cart-line").count(), 2);
assert.match(await page.locator("#cartSummary").innerText(), /Total cartons\s*25/, "20 + 5 minimum cartons");
assert.equal(await page.locator("#startCheckout").count(), 0, "checkout hidden while a quotation item is in the cart");
await page.locator('[data-qty]').first().fill("40");
await page.waitForTimeout(600);
assert.match(await page.locator("#cartSummary").innerText(), /Total cartons\s*45/, "cart totals update after editing quantity");
await page.screenshot({ path: path.join(output, "wholesale-cart.png"), fullPage: true });

// 9. Full-cart quotation request.
await page.locator("#startCartInquiry").click();
await page.locator("#inqName").fill(QA_NAME);
await page.locator("#inqEmail").fill(QA_EMAIL);
await page.locator("#inqCountry").fill("Sierra Leone");
await page.locator("#inqTimeline").fill("Within 8 weeks");
await page.locator("#inquiryForm button[type=submit]").click();
await page.locator(".confirm-card").waitFor();
assert.match(await page.locator(".confirm-card").innerText(), /INQ-/, "cart inquiry confirmation shows reference");
assert.match(await page.locator(".confirm-card").innerText(), /2 items|Submitted products/);

// 10. Checkout an all-fixed-price cart end to end.
await page.goto("http://127.0.0.1:3000/product.html?slug=fixture-amoxicillin-500-capsules", { waitUntil: "networkidle" });
await page.locator("#cartonQty").fill("12");
await page.waitForTimeout(80);
await page.locator("#addToCart").click();
await page.goto("http://127.0.0.1:3000/cart.html", { waitUntil: "networkidle" });
await page.locator(".cart-line").first().waitFor();
// Remove the leftover quote-required line so checkout becomes available.
while (await page.locator("[data-remove]").count() > 1) { await page.locator("[data-remove]").last().click(); await page.waitForTimeout(500); }
await page.locator("#startCheckout").waitFor();
await page.locator("#startCheckout").click();
await page.locator("#ordName").fill(QA_NAME);
await page.locator("#ordEmail").fill(QA_EMAIL);
await page.locator("#ordCountry").fill("Sierra Leone");
await page.locator("#ordAddress").fill("QA Street 1, Freetown");
await page.locator("#checkoutForm button[type=submit]").click();
await page.locator(".confirm-card").waitFor();
const confirmation = await page.locator(".confirm-card").innerText();
assert.match(confirmation, /ORD-/, "order confirmation shows reference number");
assert.match(confirmation, /Pending verification/i);
assert.equal(await page.locator("[data-cart-count]").first().innerText(), "0", "cart cleared after order submission");
await page.screenshot({ path: path.join(output, "wholesale-checkout-confirmation.png"), fullPage: true });

// 11. Mobile: no horizontal overflow on product and cart pages.
await page.setViewportSize({ width: 320, height: 800 });
for (const url of ["http://127.0.0.1:3000/product.html?slug=fixture-amoxicillin-500-capsules", "http://127.0.0.1:3000/cart.html"]) {
  await page.goto(url, { waitUntil: "networkidle" });
  const dims = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.equal(dims.scroll, dims.viewport, `no horizontal overflow at 320px on ${url}`);
}
await page.screenshot({ path: path.join(output, "wholesale-product-mobile.png"), fullPage: true });

// 12. Keyboard: stepper buttons work with Enter and the input is labeled.
await page.setViewportSize({ width: 1360, height: 1000 });
await page.goto("http://127.0.0.1:3000/product.html?slug=fixture-amoxicillin-500-capsules", { waitUntil: "networkidle" });
await page.locator("#qtyUp").focus();
await page.keyboard.press("Enter");
assert.equal(await page.locator("#cartonQty").inputValue(), "11", "keyboard-activated stepper increments");
assert.ok(await page.locator('label[for="cartonQty"]').count(), "carton quantity input has a visible label");
assert.equal(await page.locator("#calcSummary").getAttribute("aria-live"), "polite", "calculation changes are announced");

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(" | ")}`);
console.log(JSON.stringify({ search: "passed", calculator: "passed", validation: "passed", cart: "passed", quoteCart: "passed", inquiryDialog: "passed", cartInquiry: "passed", checkout: "passed", mobile320: "passed", keyboard: "passed", screenshots: ["wholesale-product.png", "wholesale-cart.png", "wholesale-checkout-confirmation.png", "wholesale-product-mobile.png"] }, null, 2));
await browser.close();
cleanupQaRows();
