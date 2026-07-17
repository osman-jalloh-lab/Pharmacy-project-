import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number.parseInt(process.env.PORT || "3000", 10);
const onVercel = Boolean(process.env.VERCEL);

// On Vercel the function filesystem is read-only except /tmp, so the database
// baked at build time is copied there on cold start (see src/db.js). Vercel's
// own deployment URLs are appended to the CORS allowlist automatically.
const vercelOrigins = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]
  .filter(Boolean).map(host => `https://${host}`);

export const config = Object.freeze({
  root,
  onVercel,
  port: Number.isFinite(port) ? port : 3000,
  host: process.env.HOST || "127.0.0.1",
  dbPath: process.env.DB_PATH || (onVercel ? "/tmp/pharmacy.db" : path.join(root, "data", "pharmacy.db")),
  bakedDbPath: path.join(root, "data", "pharmacy.db"),
  imageRoot: path.join(root, ".product_image_candidates"),
  publicRoot: path.join(root, "public"),
  adminPassword: process.env.ADMIN_PASSWORD || "",
  allowRemoteAdmin: process.env.ALLOW_REMOTE_ADMIN === "true",
  trustProxy: process.env.TRUST_PROXY === "1" || onVercel,
  allowedOrigins: [...(process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000").split(",").map(v => v.trim()).filter(Boolean), ...vercelOrigins]
});
