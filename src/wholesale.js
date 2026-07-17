import crypto from "node:crypto";

// Single source of truth for wholesale carton math and ordering rules.
// Every order and inquiry must be recalculated here from database values;
// prices, totals, stock, and packaging sent by a browser are never trusted.

export const MAX_CARTONS = 10000;

export const STATUS_LABELS = Object.freeze({
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
  available_by_request: "Available by request",
  preorder: "Preorder",
  quote_required: "Quote required",
  temporarily_unavailable: "Temporarily unavailable",
  discontinued: "Discontinued"
});

// States in which a carton quantity may be placed in the cart at all.
const CARTABLE = new Set(["in_stock", "low_stock", "available_by_request", "preorder", "quote_required"]);
// States in which available_cartons is a hard ceiling.
const STOCK_LIMITED = new Set(["in_stock", "low_stock"]);

export function referenceNumber(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

// Packaging facts derived only from stored, admin-confirmed fields.
export function packagingInfo(product) {
  const confirmed = product.packagingReviewStatus === "confirmed";
  const unitsPerBox = confirmed ? product.unitsPerBox ?? null : null;
  const boxesPerCarton = confirmed ? product.boxesPerCarton ?? null : null;
  const unitsPerCarton = confirmed
    ? product.unitsPerCarton ?? (unitsPerBox != null && boxesPerCarton != null ? unitsPerBox * boxesPerCarton : null)
    : null;
  return {
    confirmed: confirmed && boxesPerCarton != null,
    unitsPerBox,
    unitKind: confirmed ? product.unitKind ?? null : null,
    boxesPerCarton,
    unitsPerCarton
  };
}

export function quantityBounds(product) {
  const minimum = product.minimumCartons ?? 1;
  const stockLimited = STOCK_LIMITED.has(product.wholesaleStatus) && product.availableCartons != null;
  return { minimum, maximum: stockLimited ? Math.min(product.availableCartons, MAX_CARTONS) : MAX_CARTONS, stockLimited };
}

export function canAddToCart(product) {
  return Boolean(product.wholesaleEnabled) && CARTABLE.has(product.wholesaleStatus) && packagingInfo(product).confirmed;
}

export function checkoutEligible(product) {
  return canAddToCart(product)
    && Boolean(product.directCheckoutEnabled)
    && product.pricingMode === "fixed"
    && product.pricePerCartonCents != null
    && STOCK_LIMITED.has(product.wholesaleStatus);
}

export function validateQuantity(product, cartonQuantity) {
  if (!Number.isInteger(cartonQuantity) || cartonQuantity < 1) {
    return { ok: false, code: "invalid_quantity", message: "The carton quantity must be a positive whole number." };
  }
  const bounds = quantityBounds(product);
  if (cartonQuantity < bounds.minimum) {
    return { ok: false, code: "below_minimum", message: `The minimum wholesale order is ${bounds.minimum} carton${bounds.minimum === 1 ? "" : "s"}.` };
  }
  if (cartonQuantity > MAX_CARTONS) {
    return { ok: false, code: "above_maximum", message: `Quantities above ${MAX_CARTONS} cartons require an inquiry.` };
  }
  if (bounds.stockLimited && cartonQuantity > bounds.maximum) {
    return { ok: false, code: "above_stock", message: `Only ${bounds.maximum} carton${bounds.maximum === 1 ? " is" : "s are"} currently available. Reduce the quantity or request the full amount through an inquiry.` };
  }
  return { ok: true };
}

// Line totals computed strictly from stored product data; unsupported values stay null.
export function computeLine(product, cartonQuantity) {
  const packaging = packagingInfo(product);
  const fixedPrice = product.pricingMode === "fixed" && product.pricePerCartonCents != null;
  return {
    cartonQuantity,
    unitsPerBox: packaging.unitsPerBox,
    unitKind: packaging.unitKind,
    boxesPerCarton: packaging.boxesPerCarton,
    unitsPerCarton: packaging.unitsPerCarton,
    totalBoxes: packaging.boxesPerCarton != null ? packaging.boxesPerCarton * cartonQuantity : null,
    totalUnits: packaging.unitsPerCarton != null ? packaging.unitsPerCarton * cartonQuantity : null,
    pricePerCartonCents: fixedPrice ? product.pricePerCartonCents : null,
    lineSubtotalCents: fixedPrice ? product.pricePerCartonCents * cartonQuantity : null,
    currency: fixedPrice ? product.currency ?? null : null,
    pricingMode: product.pricingMode
  };
}

// Compact wholesale summary attached to public product payloads.
export function wholesaleSummary(product) {
  const packaging = packagingInfo(product);
  const bounds = quantityBounds(product);
  return {
    enabled: Boolean(product.wholesaleEnabled),
    status: product.wholesaleStatus,
    statusLabel: STATUS_LABELS[product.wholesaleStatus] || product.wholesaleStatus,
    pricingMode: product.pricingMode,
    pricePerCartonCents: product.pricingMode === "fixed" ? product.pricePerCartonCents ?? null : null,
    currency: product.currency ?? null,
    minimumCartons: bounds.minimum,
    availableCartons: bounds.stockLimited ? product.availableCartons : null,
    packaging,
    canAddToCart: canAddToCart(product),
    checkoutEligible: checkoutEligible(product),
    inquiryEnabled: true
  };
}

// Server-side verification of a browser cart. Only productId and cartonQuantity
// are read from the client; everything else comes from the database records.
export function verifyCart(products, items) {
  const lines = items.map(item => {
    const product = products.get(item.productId);
    if (!product) return { productId: item.productId, status: "error", code: "missing_product", message: "This product is no longer in the catalogue." };
    const base = {
      productId: product.id,
      slug: product.slug,
      displayName: product.displayName,
      genericName: product.genericName,
      brandName: product.brandName,
      strength: product.strength,
      dosageForm: product.dosageForm,
      manufacturer: product.manufacturer,
      packageSize: product.packageSize,
      imageUrl: product.primaryImage ?? null,
      wholesale: wholesaleSummary(product)
    };
    if (!canAddToCart(product)) {
      const code = packagingInfo(product).confirmed ? "not_orderable" : "packaging_unconfirmed";
      return { ...base, status: "error", code, cartonQuantity: item.cartonQuantity, message: code === "packaging_unconfirmed" ? "The carton configuration for this product needs supplier confirmation. Submit an inquiry to continue." : `This product is currently ${STATUS_LABELS[product.wholesaleStatus]?.toLowerCase() || "unavailable"}. Submit an inquiry instead.` };
    }
    const validity = validateQuantity(product, item.cartonQuantity);
    if (!validity.ok) return { ...base, status: "error", code: validity.code, message: validity.message, cartonQuantity: item.cartonQuantity };
    return { ...base, status: "ok", ...computeLine(product, item.cartonQuantity) };
  });

  const okLines = lines.filter(line => line.status === "ok");
  const currencies = new Set(okLines.filter(line => line.lineSubtotalCents != null).map(line => line.currency));
  const allPriced = okLines.length > 0 && okLines.every(line => line.lineSubtotalCents != null) && currencies.size === 1;
  const summary = {
    productCount: okLines.length,
    totalCartons: okLines.reduce((sum, line) => sum + line.cartonQuantity, 0),
    totalBoxes: okLines.length && okLines.every(line => line.totalBoxes != null) ? okLines.reduce((sum, line) => sum + line.totalBoxes, 0) : null,
    totalUnits: okLines.length && okLines.every(line => line.totalUnits != null) ? okLines.reduce((sum, line) => sum + line.totalUnits, 0) : null,
    subtotalCents: allPriced ? okLines.reduce((sum, line) => sum + line.lineSubtotalCents, 0) : null,
    currency: allPriced ? [...currencies][0] : null,
    quoteRequired: okLines.some(line => line.lineSubtotalCents == null),
    checkoutEligible: lines.length > 0 && lines.every(line => line.status === "ok") && okLines.every(line => checkoutEligible(products.get(line.productId)))
  };
  return { lines, summary };
}
