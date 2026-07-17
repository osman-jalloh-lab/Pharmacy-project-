import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";

const source = path.join(config.root, "pharmacy-storefront-desktop.pre-fullstack.backup.html");
const html = fs.readFileSync(source, "utf8");
const block = html.match(/var raw=\[([\s\S]*?)\n\s*\];/);
if (!block) throw new Error("Could not find the legacy product array.");

const slugify = value => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const products = block[1].split(/\r?\n/).map(line => line.trim().replace(/^"|",?$/g, "")).filter(Boolean).map((line, index) => {
  const [displayName, folder, primaryFile, category, dosageForm, kind] = line.split("|");
  return {
    legacyId: index + 1,
    slug: slugify(displayName),
    displayName,
    genericName: kind === "generic" ? displayName : null,
    brandName: kind === "brand" ? displayName : null,
    category,
    dosageForm: dosageForm || null,
    folder,
    primaryFile: primaryFile || null,
    featured: [24, 30, 46, 64, 67, 80].includes(index + 1)
  };
});

fs.mkdirSync(path.join(config.root, "data"), { recursive: true });
fs.writeFileSync(path.join(config.root, "data", "products.seed.json"), JSON.stringify(products, null, 2) + "\n");
console.log(`Extracted ${products.length} product records.`);
