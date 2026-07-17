import crypto from "node:crypto";
import { config } from "./config.js";

function equal(a, b) {
  const left = Buffer.from(a || ""), right = Buffer.from(b || "");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function requireAdmin(req, res, next) {
  if (!config.allowRemoteAdmin && (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"])) return res.status(403).json({ error: "remote_admin_disabled", message: "The admin interface is local-only." });
  if (!config.adminPassword) return res.status(503).json({ error: "admin_not_configured", message: "Set ADMIN_PASSWORD in .env before using admin features." });
  const [scheme, value] = (req.headers.authorization || "").split(" ");
  let password = "";
  if (scheme === "Basic" && value) { try { password = Buffer.from(value, "base64").toString("utf8").split(":").slice(1).join(":"); } catch {} }
  if (!equal(password, config.adminPassword)) { res.set("WWW-Authenticate", 'Basic realm="Grace Care local admin"'); return res.status(401).json({ error: "unauthorized", message: "Administrator authentication is required." }); }
  next();
}
