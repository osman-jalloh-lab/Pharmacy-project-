import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { imageSize } from "image-size";
import { ZodError } from "zod";
import { config } from "./src/config.js";
import { migrate, getDb, transaction } from "./src/db.js";
import { listProducts, getProduct, getProductsByIds, categories } from "./src/catalog.js";
import { requireAdmin } from "./src/auth.js";
import { inquirySchema, cartVerifySchema, orderSchema, productPatchSchema, imagePatchSchema, INQUIRY_STATUSES, ORDER_STATUSES } from "./src/validation.js";
import { verifyCart, validateQuantity, checkoutEligible, computeLine, packagingInfo, referenceNumber } from "./src/wholesale.js";

migrate();
const app = express();
if (config.trustProxy) app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", "data:"], styleSrc: ["'self'"], scriptSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: "same-origin" } }));
app.use(cors({ origin(origin, callback) { if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true); callback(new Error("Origin is not allowed.")); }, credentials: false }));
app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => { const started = Date.now(); res.on("finish", () => console.log(JSON.stringify({ at: new Date().toISOString(), method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started }))); next(); });
app.use("/api", rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: "draft-8", legacyHeaders: false }));
const inquiryLimit = rateLimit({ windowMs: 10 * 60_000, limit: 6, standardHeaders: "draft-8", legacyHeaders: false });
const orderLimit = rateLimit({ windowMs: 10 * 60_000, limit: 6, standardHeaders: "draft-8", legacyHeaders: false });

app.get("/api/health", (req, res) => { const db = getDb(); const products = db.prepare("SELECT COUNT(*) count FROM products").get().count; res.json({ status: "ok", database: "connected", products: Number(products), time: new Date().toISOString() }); });
app.get("/favicon.ico", (req, res) => res.status(204).end());
app.get("/api/products", (req, res) => { const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500); const offset = Math.max(Number(req.query.offset) || 0, 0); res.json(listProducts({ q: String(req.query.q || "").slice(0, 100), category: String(req.query.category || "").slice(0, 100), limit, offset })); });
app.get("/api/search", (req, res) => res.json(listProducts({ q: String(req.query.q || "").slice(0, 100), limit: 500 })));
app.get("/api/categories", (req, res) => res.json({ items: categories() }));
app.get("/api/products/:slug", (req, res) => { const product = getProduct(req.params.slug); if (!product) return res.status(404).json({ error: "not_found", message: "Product not found." }); res.json(product); });
app.get("/api/products/:slug/images", (req, res) => { const product = getProduct(req.params.slug); if (!product) return res.status(404).json({ error: "not_found", message: "Product not found." }); res.json({ viewerMode: product.viewerMode, viewerLabel: product.viewerLabel, items: product.images }); });
app.get("/api/sources/:id", (req, res) => { const source = getDb().prepare("SELECT id,organization,title,url,accessed_at accessedAt,source_type sourceType,notes FROM sources WHERE id=?").get(Number(req.params.id)); if (!source) return res.status(404).json({ error: "not_found", message: "Source not found." }); res.json(source); });

app.post("/api/inquiries", inquiryLimit, (req, res) => {
  const value = inquirySchema.parse(req.body), minuteBucket = Math.floor(Date.now() / 300000), ids = value.items.map(i => i.productId).sort((a,b) => a-b);
  const dedupe = crypto.createHash("sha256").update(JSON.stringify([value.customerName.toLowerCase(), value.email || "", value.phone || "", ids, value.items.map(i => i.cartonQuantity || i.quantityRequested), minuteBucket])).digest("hex");
  const products = getProductsByIds(ids);
  if (products.size !== new Set(ids).size) return res.status(400).json({ error: "invalid_product", message: "One or more selected products do not exist." });
  const reference = referenceNumber("INQ");
  try {
    const inquiryId = transaction(database => {
      const id = Number(database.prepare("INSERT INTO inquiries(customer_name,email,phone,message,dedupe_key,reference_number,business_name,destination_country,destination_city,inquiry_reason,inquiry_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(value.customerName, value.email || null, value.phone || null, value.message || null, dedupe, reference, value.businessName || null, value.destinationCountry || null, value.destinationCity || null, value.inquiryReason, value.inquiryType).lastInsertRowid);
      const item = database.prepare("INSERT INTO inquiry_items(inquiry_id,product_id,quantity_requested,notes,carton_quantity,product_name_snapshot,units_per_box_snapshot,boxes_per_carton_snapshot,units_per_carton_snapshot,price_per_carton_cents_snapshot,currency_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
      for (const entry of value.items) {
        // Packaging and price snapshots come from the current database record, never the browser.
        const product = products.get(entry.productId), packaging = packagingInfo(product);
        const fixedPrice = product.pricingMode === "fixed" && product.pricePerCartonCents != null;
        item.run(id, entry.productId, entry.quantityRequested, entry.notes || null, entry.cartonQuantity ?? null, product.displayName, packaging.unitsPerBox, packaging.boxesPerCarton, packaging.unitsPerCarton, fixedPrice ? product.pricePerCartonCents : null, fixedPrice ? product.currency ?? null : null);
      }
      return id;
    });
    res.status(201).json({ id: inquiryId, referenceNumber: reference, status: "submitted", message: "Your inquiry has been submitted successfully. It has not yet been reviewed, and it is not a confirmed order." });
  } catch (error) { if (String(error.message).includes("UNIQUE constraint failed: inquiries.dedupe_key")) return res.status(409).json({ error: "duplicate_inquiry", message: "This inquiry was already received recently." }); throw error; }
});

app.post("/api/cart/verify", (req, res) => {
  const value = cartVerifySchema.parse(req.body);
  res.json(verifyCart(getProductsByIds(value.items.map(i => i.productId)), value.items));
});

app.post("/api/orders", orderLimit, (req, res) => {
  const value = orderSchema.parse(req.body), ids = value.items.map(i => i.productId);
  if (new Set(ids).size !== ids.length) return res.status(400).json({ error: "duplicate_items", message: "Each product may appear only once per order." });
  const products = getProductsByIds(ids);
  // Every line is revalidated and repriced from the database before anything is stored.
  const problems = [];
  for (const entry of value.items) {
    const product = products.get(entry.productId);
    if (!product) { problems.push({ productId: entry.productId, code: "missing_product", message: "This product is no longer in the catalogue." }); continue; }
    if (!checkoutEligible(product)) { problems.push({ productId: entry.productId, code: "checkout_unavailable", message: `${product.displayName} cannot be checked out directly. Submit an inquiry to request a quotation.` }); continue; }
    const validity = validateQuantity(product, entry.cartonQuantity);
    if (!validity.ok) problems.push({ productId: entry.productId, code: validity.code, message: validity.message });
  }
  if (problems.length) return res.status(400).json({ error: "order_rejected", message: "The order could not be accepted as submitted.", problems });
  const lines = value.items.map(entry => ({ product: products.get(entry.productId), line: computeLine(products.get(entry.productId), entry.cartonQuantity) }));
  const currencies = new Set(lines.map(({ line }) => line.currency));
  if (currencies.size !== 1) return res.status(400).json({ error: "mixed_currency", message: "These products cannot be combined in one order. Submit a cart inquiry instead." });
  const subtotal = lines.reduce((sum, { line }) => sum + line.lineSubtotalCents, 0), currency = [...currencies][0];
  const minuteBucket = Math.floor(Date.now() / 300000);
  const dedupe = crypto.createHash("sha256").update(JSON.stringify([value.customerName.toLowerCase(), value.email || "", value.phone || "", ids.slice().sort((a,b)=>a-b), value.items.map(i => i.cartonQuantity), minuteBucket])).digest("hex");
  const reference = referenceNumber("ORD");
  try {
    const orderId = transaction(database => {
      const id = Number(database.prepare("INSERT INTO orders(reference_number,customer_name,business_name,email,phone,delivery_address,destination_country,destination_city,shipping_preference,wholesale_license_info,order_notes,subtotal_cents,currency,dedupe_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(reference, value.customerName, value.businessName || null, value.email || null, value.phone || null, value.deliveryAddress || null, value.destinationCountry || null, value.destinationCity || null, value.shippingPreference || null, value.wholesaleLicenseInfo || null, value.orderNotes || null, subtotal, currency, dedupe).lastInsertRowid);
      const item = database.prepare("INSERT INTO order_items(order_id,product_id,product_name_snapshot,slug_snapshot,carton_quantity,units_per_box_snapshot,boxes_per_carton_snapshot,units_per_carton_snapshot,price_per_carton_cents_snapshot,line_subtotal_cents,currency_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
      for (const { product, line } of lines) item.run(id, product.id, product.displayName, product.slug, line.cartonQuantity, line.unitsPerBox, line.boxesPerCarton, line.unitsPerCarton, line.pricePerCartonCents, line.lineSubtotalCents, line.currency);
      return id;
    });
    res.status(201).json({ id: orderId, referenceNumber: reference, status: "pending_verification", subtotalCents: subtotal, currency, message: "Your order request was stored with status pending verification. No payment has been taken. Licensing, prescription, or supplier verification may still be required before the order is approved." });
  } catch (error) { if (String(error.message).includes("UNIQUE constraint failed: orders.dedupe_key")) return res.status(409).json({ error: "duplicate_order", message: "This order was already received recently." }); throw error; }
});

app.use("/api/admin", requireAdmin);
app.get("/api/admin/products", (req, res) => res.json(listProducts({ q: String(req.query.q || ""), limit: 500 })));
app.get("/api/admin/products/:slug", (req, res) => { const product = getProduct(req.params.slug, { admin: true }); if (!product) return res.status(404).json({ error: "not_found" }); res.json(product); });
app.post("/api/admin/products", (req,res)=>{const value=productPatchSchema.parse(req.body);if(!value.displayName||!value.category)return res.status(400).json({error:"validation_error",message:"displayName and category are required."});const slug=value.displayName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");try{const id=Number(getDb().prepare("INSERT INTO products(slug,display_name,generic_name,brand_name,category,dosage_form,review_status) VALUES (?,?,?,?,?,?,?)").run(slug,value.displayName,value.genericName||null,value.brandName||null,value.category,value.dosageForm||null,value.reviewStatus||"needs_review").lastInsertRowid);res.status(201).json({id,slug});}catch(error){if(String(error.message).includes("UNIQUE"))return res.status(409).json({error:"duplicate_product"});throw error;}});
app.patch("/api/admin/products/:id", (req, res) => { const value = productPatchSchema.parse(req.body), map = { displayName:"display_name",genericName:"generic_name",brandName:"brand_name",activeIngredient:"active_ingredient",category:"category",dosageForm:"dosage_form",strength:"strength",manufacturer:"manufacturer",packageSize:"package_size",description:"description",commonUses:"common_uses",prescriptionStatus:"prescription_status",availabilityStatus:"availability_status",reviewStatus:"review_status",unitsPerBox:"units_per_box",unitKind:"unit_kind",boxesPerCarton:"boxes_per_carton",unitsPerCarton:"units_per_carton",minimumCartons:"minimum_cartons",availableCartons:"available_cartons",pricePerCartonCents:"price_per_carton_cents",currency:"currency",pricingMode:"pricing_mode",wholesaleStatus:"wholesale_status",wholesaleEnabled:"wholesale_enabled",directCheckoutEnabled:"direct_checkout_enabled",packagingReviewStatus:"packaging_review_status" }; const entries = Object.entries(value); if (!entries.length) return res.status(400).json({ error:"empty_patch" }); const sql = entries.map(([key]) => `${map[key]}=?`).join(","); getDb().prepare(`UPDATE products SET ${sql},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...entries.map(([,v]) => typeof v === "boolean" ? (v ? 1 : 0) : v), Number(req.params.id)); res.json({ status:"updated" }); });
app.post("/api/admin/products/:id/images",(req,res)=>{const productId=Number(req.params.id),localPath=String(req.body.localPath||"").replaceAll("\\","/");const product=getDb().prepare("SELECT id FROM products WHERE id=?").get(productId);if(!product)return res.status(404).json({error:"not_found"});const full=path.resolve(config.root,localPath),root=path.resolve(config.imageRoot);if(!full.startsWith(root+path.sep)||!fs.existsSync(full)||!fs.statSync(full).isFile())return res.status(400).json({error:"unsafe_path",message:"The image must be an existing file inside the curated image directory."});const buffer=fs.readFileSync(full),hash=crypto.createHash("sha256").update(buffer).digest("hex"),size=imageSize(buffer),relative=path.relative(config.imageRoot,full).split(path.sep),publicPath="/media/"+relative.map(encodeURIComponent).join("/");const duplicate=getDb().prepare("SELECT id FROM product_images WHERE file_hash=?").get(hash);if(duplicate)return res.status(409).json({error:"duplicate_image",existingImageId:duplicate.id});const id=Number(getDb().prepare("INSERT INTO product_images(product_id,local_path,public_path,file_hash,width,height,angle_label,is_verified,review_status,license_status) VALUES (?,?,?,?,?,?,?,?,?,?)").run(productId,path.relative(config.root,full).replaceAll("\\","/"),publicPath,hash,size.width||null,size.height||null,req.body.angleLabel||"Unknown view",0,"pending","needs_review").lastInsertRowid);getDb().prepare("INSERT OR IGNORE INTO review_queue(entity_type,entity_id,product_id,reason,details) VALUES ('image',?,?,?,?)").run(id,productId,"new_image_requires_review",JSON.stringify({localPath}));res.status(201).json({id});});
app.patch("/api/admin/images/:id", (req, res) => { const value = imagePatchSchema.parse(req.body), map = { angleLabel:"angle_label",sequenceIndex:"sequence_index",sortOrder:"sort_order",isPrimary:"is_primary",isVerified:"is_verified",licenseStatus:"license_status",reviewStatus:"review_status",ocrText:"ocr_text",ocrConfidence:"ocr_confidence" }; const entries = Object.entries(value); if (!entries.length) return res.status(400).json({ error:"empty_patch" }); const db=getDb(), image=db.prepare("SELECT product_id FROM product_images WHERE id=?").get(Number(req.params.id)); if(!image)return res.status(404).json({error:"not_found"}); transaction(database=>{ if(value.isPrimary)database.prepare("UPDATE product_images SET is_primary=0 WHERE product_id=?").run(image.product_id); database.prepare(`UPDATE product_images SET ${entries.map(([key])=>`${map[key]}=?`).join(",")},reviewed_at=CURRENT_TIMESTAMP WHERE id=?`).run(...entries.map(([,v])=>typeof v==="boolean"?(v?1:0):v),Number(req.params.id)); }); res.json({status:"updated"}); });
app.get("/api/admin/review-queue", (req, res) => { const status=String(req.query.status||"pending"); const items=getDb().prepare("SELECT q.*,p.display_name productName,i.public_path publicPath FROM review_queue q LEFT JOIN products p ON p.id=q.product_id LEFT JOIN product_images i ON q.entity_type='image' AND i.id=q.entity_id WHERE q.status=? ORDER BY q.id LIMIT 500").all(status); res.json({items}); });
app.patch("/api/admin/review-queue/:id", (req,res)=>{ const status=String(req.body.status||""); if(!["approved","rejected","pending"].includes(status))return res.status(400).json({error:"invalid_status"}); const db=getDb(),row=db.prepare("SELECT * FROM review_queue WHERE id=?").get(Number(req.params.id));if(!row)return res.status(404).json({error:"not_found"});transaction(database=>{database.prepare("UPDATE review_queue SET status=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(status,row.id);if(row.entity_type==="image"&&row.entity_id)database.prepare("UPDATE product_images SET is_verified=?,review_status=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(status==="approved"?1:0,status==="approved"?"reviewed":status==="rejected"?"rejected":"pending",row.entity_id);});res.json({status});});
app.get("/api/admin/inquiries", (req,res)=>{const items=getDb().prepare("SELECT q.*,COUNT(i.id) itemCount FROM inquiries q LEFT JOIN inquiry_items i ON i.inquiry_id=q.id GROUP BY q.id ORDER BY q.created_at DESC LIMIT 200").all();res.json({items});});
app.get("/api/admin/inquiries/:id", (req,res)=>{const inquiry=getDb().prepare("SELECT * FROM inquiries WHERE id=?").get(Number(req.params.id));if(!inquiry)return res.status(404).json({error:"not_found"});inquiry.items=getDb().prepare("SELECT i.*,p.slug,p.display_name displayName FROM inquiry_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.inquiry_id=? ORDER BY i.id").all(inquiry.id);res.json(inquiry);});
app.patch("/api/admin/inquiries/:id", (req,res)=>{const status=String(req.body.status||"");if(!INQUIRY_STATUSES.includes(status))return res.status(400).json({error:"invalid_status",message:`Status must be one of: ${INQUIRY_STATUSES.join(", ")}.`});const result=getDb().prepare("UPDATE inquiries SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status,Number(req.params.id));if(!result.changes)return res.status(404).json({error:"not_found"});res.json({status:"updated"});});
app.get("/api/admin/orders", (req,res)=>{const items=getDb().prepare("SELECT o.*,COUNT(i.id) itemCount,SUM(i.carton_quantity) totalCartons FROM orders o LEFT JOIN order_items i ON i.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 200").all();res.json({items});});
app.get("/api/admin/orders/:id", (req,res)=>{const order=getDb().prepare("SELECT * FROM orders WHERE id=?").get(Number(req.params.id));if(!order)return res.status(404).json({error:"not_found"});order.items=getDb().prepare("SELECT * FROM order_items WHERE order_id=? ORDER BY id").all(order.id);res.json(order);});
app.patch("/api/admin/orders/:id", (req,res)=>{const status=String(req.body.status||"");if(!ORDER_STATUSES.includes(status))return res.status(400).json({error:"invalid_status",message:`Status must be one of: ${ORDER_STATUSES.join(", ")}.`});const result=getDb().prepare("UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status,Number(req.params.id));if(!result.changes)return res.status(404).json({error:"not_found"});res.json({status:"updated"});});
app.get("/api/admin/export", (req,res)=>{const items=listProducts({limit:100}).items.map(p=>getProduct(p.slug,{admin:true}));res.attachment("grace-care-catalogue.json").json({exportedAt:new Date().toISOString(),items});});
let importRunning=false;
app.post("/api/admin/import",(req,res)=>{if(importRunning)return res.status(409).json({error:"import_running"});importRunning=true;const child=spawn(process.execPath,[path.join(config.root,"scripts","import-products.js")],{cwd:config.root,stdio:"ignore"});child.on("exit",()=>{importRunning=false;});res.status(202).json({status:"started"});});

app.use("/media", express.static(config.imageRoot, { fallthrough: false, immutable: true, maxAge: "7d", dotfiles: "deny", index: false }));
app.use("/admin", requireAdmin, express.static(path.join(config.publicRoot,"admin"), { index: "index.html", maxAge: "no-store" }));
app.use(express.static(config.publicRoot, { extensions: ["html"], index: "index.html", maxAge: "5m" }));
app.get("/pharmacy-storefront-desktop.html", (req,res)=>res.sendFile(path.join(config.publicRoot,"index.html")));
app.use((req,res)=>res.status(404).json({error:"not_found",message:"The requested resource was not found."}));
app.use((error,req,res,next)=>{if(error instanceof ZodError)return res.status(400).json({error:"validation_error",message:"The request was not valid.",issues:error.issues.map(i=>({path:i.path.join("."),message:i.message}))});if(error.message==="Origin is not allowed.")return res.status(403).json({error:"origin_denied"});console.error(JSON.stringify({at:new Date().toISOString(),error:error.message,path:req.path}));res.status(500).json({error:"server_error",message:"The server could not complete the request."});});

if (process.env.NODE_ENV !== "test") app.listen(config.port,config.host,()=>{console.log(`Frontend: http://localhost:${config.port}`);console.log(`API health: http://localhost:${config.port}/api/health`);console.log(`Admin (local only): http://localhost:${config.port}/admin`);});

export default app;
