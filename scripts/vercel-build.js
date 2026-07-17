// Vercel build step.
//
// 1. Builds the SQLite database into data/pharmacy.db (schema, product/image
//    import, demo leone pricing, dev fixtures). The file is bundled into the
//    serverless function and copied to /tmp on cold start.
// 2. Copies the curated images into public/media so Vercel's CDN serves them
//    at the same /media/... paths the Express route uses locally.
//
// NODE_ENV is forced off "production" because the seed scripts refuse to run
// there, and this deployment intentionally serves fake demo pricing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = path.join(root, "data", "pharmacy.db");
const env = { ...process.env, NODE_ENV: "development", DB_PATH: dbPath, VERCEL: "" };

for (const file of ["pharmacy.db", "pharmacy.db-shm", "pharmacy.db-wal"]) {
  const stale = path.join(root, "data", file);
  if (fs.existsSync(stale)) fs.rmSync(stale);
}

for (const script of ["scripts/migrate.js", "scripts/import-products.js", "scripts/seed-demo-wholesale.js", "scripts/seed-wholesale-fixtures.js"]) {
  console.log(`[vercel-build] node ${script}`);
  const result = spawnSync(process.execPath, ["--no-warnings", path.join(root, script)], { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) { console.error(`[vercel-build] ${script} failed with exit code ${result.status}`); process.exit(result.status ?? 1); }
}

const mediaSource = path.join(root, ".product_image_candidates");
const mediaTarget = path.join(root, "public", "media");
fs.rmSync(mediaTarget, { recursive: true, force: true });
fs.cpSync(mediaSource, mediaTarget, { recursive: true });

const dbSize = Math.round(fs.statSync(dbPath).size / 1024);
const mediaCount = fs.readdirSync(mediaTarget).length;
console.log(`[vercel-build] done: database ${dbSize}KB, ${mediaCount} media folders copied to public/media`);
