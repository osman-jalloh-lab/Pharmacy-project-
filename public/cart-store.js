// Shared guest wholesale cart. Only product identity and carton quantity are stored;
// names, packaging, prices, and totals are always re-read from the server.
const KEY = "graceCartV1";

export function readCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw.filter(item => Number.isInteger(item.productId) && Number.isInteger(item.cartonQuantity) && item.cartonQuantity > 0) : [];
  } catch { return []; }
}

export function writeCart(items) { localStorage.setItem(KEY, JSON.stringify(items)); updateBadges(); }

export function cartCount() { return readCart().length; }

export function addToCart(productId, slug, cartonQuantity) {
  const items = readCart(), existing = items.find(item => item.productId === productId);
  if (existing) { existing.cartonQuantity += cartonQuantity; existing.slug = slug; }
  else items.push({ productId, slug, cartonQuantity, addedAt: new Date().toISOString() });
  writeCart(items);
  return { combined: Boolean(existing), cartonQuantity: existing ? existing.cartonQuantity : cartonQuantity };
}

export function updateQuantity(productId, cartonQuantity) {
  const items = readCart(), entry = items.find(item => item.productId === productId);
  if (entry) { entry.cartonQuantity = cartonQuantity; writeCart(items); }
}

export function removeFromCart(productId) { writeCart(readCart().filter(item => item.productId !== productId)); }

export function clearCart() { writeCart([]); }

export function updateBadges() {
  const count = cartCount();
  document.querySelectorAll("[data-cart-count]").forEach(element => { element.textContent = count; });
}

export function formatMoney(cents, currency) {
  if (cents == null || !currency) return null;
  if (currency === "SLE") {
    const amount = cents / 100;
    return `Le ${amount.toLocaleString("en", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
  }
  try { return new Intl.NumberFormat("en", { style: "currency", currency }).format(cents / 100); }
  catch { return `${(cents / 100).toFixed(2)} ${currency}`; }
}
