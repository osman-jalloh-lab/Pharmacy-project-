import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { config } from "../src/config.js";

const executablePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const output = path.join(config.root, "docs", "screenshots");
const qaInquiry = {
  name: "Automated QA Review",
  email: "qa-review@example.test",
  message: "Automated local persistence check"
};

function cleanupQaInquiries() {
  const db = new DatabaseSync(config.dbPath);
  db.prepare(`
    DELETE FROM inquiries
    WHERE customer_name = ? AND email = ? AND message = ?
  `).run(qaInquiry.name, qaInquiry.email, qaInquiry.message);
  db.close();
}

// A failed prior run must not trigger the duplicate-submission guard.
cleanupQaInquiries();
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "no-preference" });
const consoleErrors = [], pageErrors = [], failedRequests = [];
page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", error => pageErrors.push(error.message));
page.on("response", response => { if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`); });

const catalogueTotal = (await (await fetch("http://127.0.0.1:3000/api/products")).json()).total;
await page.goto("http://127.0.0.1:3000", { waitUntil: "networkidle" });
assert.match(await page.locator("#results").innerText(), new RegExp(`${catalogueTotal} products shown`));
assert.equal(await page.locator(".card").count(), 32, "first batch of cards renders");
for (let i = 0; i < 30 && await page.locator(".card").count() < catalogueTotal; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(160);
}
assert.equal(await page.locator(".card").count(), catalogueTotal, "all products lazy-load on scroll");
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: path.join(output, "catalogue.png"), fullPage: false });

await page.locator("#search").fill("Coartem");
await page.waitForTimeout(220);
assert.equal(await page.locator(".card").count(), 1, "search filters catalogue");
await page.locator("#clearSearch").click();
assert.equal(await page.locator(".card").count(), 32, "clearing search restores the first batch");

await page.locator("#search").fill("Coartem");
await page.waitForTimeout(220);
await page.locator('a[href="/product.html?slug=coartem"]').first().click();
await page.waitForLoadState("networkidle");
assert.match(page.url(), /product\.html\?slug=coartem/);
assert.equal(await page.locator(".viewer-label").innerText(), "Single Product Image");
assert.equal(await page.locator("#mainImage").count(), 1);
assert.equal(await page.locator("#zoom").count(), 1);
assert.equal(await page.locator("#fullscreen").count(), 1);
assert.ok(await page.locator(".detail-section").count() >= 7, "structured details render");
const viewer = page.locator("#viewerObject"), box = await viewer.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.move(box.x + box.width * .7, box.y + box.height * .4);
assert.match(await viewer.getAttribute("style"), /rotateX/);
await page.locator("#zoom").click();
assert.equal(await page.locator("#zoom").getAttribute("aria-pressed"), "true");
await page.screenshot({ path: path.join(output, "product-details.png"), fullPage: true });

await page.setViewportSize({ width: 820, height: 1100 });
await page.goto("http://127.0.0.1:3000", { waitUntil: "networkidle" });
const tablet = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
assert.equal(tablet.scroll, tablet.viewport, "no horizontal overflow at 820px");
assert.ok(await page.locator("#navToggle").isVisible(), "menu toggle appears on tablet");
await page.locator("#navToggle").click();
assert.equal(await page.locator("#navToggle").getAttribute("aria-expanded"), "true", "menu toggle reports expanded");
assert.ok(await page.locator('#navLinks a[href="#safety"]').isVisible(), "navigation links reachable on tablet");
await page.locator('#navLinks a[href="#safety"]').click();
assert.equal(await page.locator("#navToggle").getAttribute("aria-expanded"), "false", "menu closes after navigating");

await page.setViewportSize({ width: 320, height: 800 });
await page.goto("http://127.0.0.1:3000", { waitUntil: "networkidle" });
const dimensions = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
assert.equal(dimensions.scroll, dimensions.viewport, "no horizontal overflow at 320px");
await page.screenshot({ path: path.join(output, "mobile-catalogue.png"), fullPage: false });

await page.setViewportSize({ width: 1100, height: 900 });
await page.goto("http://127.0.0.1:3000/?inquire=coartem", { waitUntil: "networkidle" });
assert.equal(await page.locator("#drawer").getAttribute("aria-hidden"), "false", "inquiry drawer opens from product link");
await page.locator("#customerName").fill(qaInquiry.name);
await page.locator("#email").fill(qaInquiry.email);
await page.locator("#message").fill(qaInquiry.message);
await page.locator("#inquiryForm").evaluate(form => form.requestSubmit());
await page.locator("#formStatus.success").waitFor();
assert.match(await page.locator("#formStatus").innerText(), /was stored/);

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(" | ")}`);
assert.deepEqual(failedRequests, [], `failed requests: ${failedRequests.join(" | ")}`);
console.log(JSON.stringify({ cards: catalogueTotal, search: "passed", productViewer: "single-image controls passed", structuredSections: "passed", inquiryUiPersistence: "passed", mobile320: dimensions, consoleErrors: 0, pageErrors: 0, failedRequests: 0, screenshots: ["catalogue.png", "product-details.png", "mobile-catalogue.png"] }, null, 2));
await browser.close();

// Keep the development catalogue clean while still exercising a real persisted write.
cleanupQaInquiries();
