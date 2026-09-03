// inventory.js — owner-only sheet-stock tracking, stored in the browser's localStorage.
//
// There is no server/DB: the internal tool runs locally and the quote flow deducts stock right in
// the browser, so localStorage is the live store. It's per-origin (the owner's machine), never
// shipped as data, and shared between the quote tool (index.html/app.js) and the editor
// (admin.html/admin.js) since both are same-origin. Use Export/Import in the admin to back it up.
//
// Stock is keyed by material + thickness + sheet size — a quote picks exactly one of each, so a
// deduction maps to one line. Quantities are whole sheets.
//
// PRICED LOTS (FIFO): each line stores up to MAX_LOTS purchase "lots" — { price, sheets } — that
// the owner filled in at the price they paid. Quotes on the INTERNAL edition price from the front
// non-empty lot (auto-advancing as sheets deplete), overriding the market/auto price; the customer
// Worker never sees this. A bare number from an older export is read as one unpriced lot.

const KEY = "mq_inventory";
export const MAX_LOTS = 5;

// Canonical numeric key for a thickness so "0.032" (string) and 0.032 (number) collide correctly.
export function thkKey(x) { return String(Number(x)); }

export function lineKey(materialId, thicknessIn, sheetId) {
  return `${materialId}|${thkKey(thicknessIn)}|${sheetId}`;
}

export function loadInventory() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
  catch { return {}; }
}

export function saveInventory(inv) {
  localStorage.setItem(KEY, JSON.stringify(inv || {}));
}

// Normalize a stored value to a clean lots array. Legacy bare number => one unpriced lot.
function lotsOf(v) {
  if (typeof v === "number") return v > 0 ? [{ price: null, sheets: Math.round(v) }] : [];
  const raw = v && Array.isArray(v.lots) ? v.lots : [];
  return raw.slice(0, MAX_LOTS).map((l) => ({
    price: l && l.price != null && isFinite(Number(l.price)) ? Number(l.price) : null,
    sheets: Math.max(0, Math.round(Number(l && l.sheets) || 0)),
  }));
}

export function getLots(inv, key) { return lotsOf(inv[key]); }

// Persist a lots array (drops the line entirely if it carries no sheets and no entered price).
function putLots(inv, key, lots) {
  const clean = (lots || []).slice(0, MAX_LOTS).map((l) => ({
    price: l.price != null && isFinite(Number(l.price)) ? Number(l.price) : null,
    sheets: Math.max(0, Math.round(Number(l.sheets) || 0)),
  }));
  if (clean.some((l) => l.sheets > 0 || l.price != null)) inv[key] = { lots: clean };
  else delete inv[key];
  return inv;
}

// Set price and/or sheets on one lot (0-based index). Grows the lots array as needed.
export function setLot(inv, key, index, patch) {
  const lots = getLots(inv, key);
  while (lots.length <= index && lots.length < MAX_LOTS) lots.push({ price: null, sheets: 0 });
  const lot = lots[index];
  if (!lot) return inv;
  if (patch.price !== undefined) {
    const p = Number(patch.price);
    lot.price = patch.price === "" || patch.price == null || !isFinite(p) ? null : p;
  }
  if (patch.sheets !== undefined) lot.sheets = Math.max(0, Math.round(Number(patch.sheets) || 0));
  return putLots(inv, key, lots);
}

// Total whole sheets on a line (sum across lots).
export function getStock(inv, materialId, thicknessIn, sheetId) {
  return getLots(inv, lineKey(materialId, thicknessIn, sheetId)).reduce((a, l) => a + l.sheets, 0);
}

// The front lot that still has sheets — drives the active purchase price. null if none.
export function activeLot(inv, key) { return getLots(inv, key).find((l) => l.sheets > 0) || null; }
// Active purchase-price basis: the front non-empty lot's price. null if unstocked or that lot is
// unpriced (a bare count with no price entered).
export function activeLotPrice(inv, key) { const l = activeLot(inv, key); return l ? l.price : null; }
// Does this line have ANY priced sheets on hand? (i.e. can we price a quote from inventory?)
export function hasPricedStock(inv, key) { return getLots(inv, key).some((l) => l.sheets > 0 && l.price != null); }

// Cost of drawing `n` sheets FIFO from a lots array WITHOUT mutating. `n` may be fractional (area
// billing). Sheets beyond the priced stock use fallbackPrice (the market/auto rate) when given,
// else the last priced lot's price. Returns { cost, remaining, short, segments }.
export function priceSheetsFIFO(lots, n, fallbackPrice) {
  let need = Math.max(0, Number(n) || 0);
  let cost = 0;
  const segments = [];
  let lastPriced = null;
  for (const l of lots || []) {
    if (need <= 1e-9) break;
    if (!(l.sheets > 0) || l.price == null) continue;
    lastPriced = l.price;
    const take = Math.min(l.sheets, need);
    cost += take * l.price; need -= take; segments.push({ price: l.price, sheets: take });
  }
  const short = need > 1e-9;
  if (short) {
    const fp = fallbackPrice != null && isFinite(fallbackPrice) ? Number(fallbackPrice) : lastPriced;
    if (fp != null) { cost += need * fp; segments.push({ price: fp, sheets: need, fallback: true }); need = 0; }
  }
  return { cost, remaining: need, short, segments };
}

// Draw `n` whole sheets FIFO, mutating the store. Returns the number actually removed (never makes a
// lot negative). Used by the quote tool's "remove from stock" after a job is cut.
export function consumeSheets(inv, key, n) {
  let need = Math.max(0, Math.round(Number(n) || 0));
  const lots = getLots(inv, key);
  let removed = 0;
  for (const l of lots) {
    if (need <= 0) break;
    const take = Math.min(l.sheets, need);
    l.sheets -= take; need -= take; removed += take;
  }
  putLots(inv, key, lots);
  return removed;
}

// Compact a line: drop emptied lots and shift the rest left so lot 1 is the current price. The
// owner's "Roll" button — tidy-up only, since pricing already auto-advances to the front non-empty
// lot. Keeps a trailing priced-but-zero lot? No — anything with 0 sheets is dropped.
export function rollLots(inv, key) {
  const kept = getLots(inv, key).filter((l) => l.sheets > 0);
  return putLots(inv, key, kept);
}

// Set an absolute on-hand quantity as a single unpriced lot. Back-compat for callers that only
// tracked counts; the priced-lots UI uses setLot instead.
export function setStock(inv, materialId, thicknessIn, sheetId, qty) {
  const n = Math.round(Number(qty) || 0);
  return putLots(inv, lineKey(materialId, thicknessIn, sheetId), n > 0 ? [{ price: null, sheets: n }] : []);
}

// Add delta whole sheets (negative to deduct). Negative draws FIFO; positive lands in a trailing
// unpriced lot. Returns the resulting total on hand.
export function adjustStock(inv, materialId, thicknessIn, sheetId, delta) {
  const key = lineKey(materialId, thicknessIn, sheetId);
  const d = Math.round(Number(delta) || 0);
  if (d < 0) { consumeSheets(inv, key, -d); }
  else if (d > 0) {
    const lots = getLots(inv, key);
    if (lots.length && lots[lots.length - 1].price == null) lots[lots.length - 1].sheets += d;
    else if (lots.length < MAX_LOTS) lots.push({ price: null, sheets: d });
    else lots[lots.length - 1].sheets += d;
    putLots(inv, key, lots);
  }
  return getStock(inv, materialId, thicknessIn, sheetId);
}

export function totalSheets(inv) {
  return Object.keys(inv || {}).reduce((a, k) => a + getLots(inv, k).reduce((s, l) => s + l.sheets, 0), 0);
}

// ---- Cut-speed validation flags ----
// A personal owner checklist: per material + THICKNESS (cut speed is a function of thickness, not
// sheet size), has the real cut time been validated on the machine yet? Signal only — nothing in
// pricing reads it. Stored separately from stock so it survives independently. Device-local like the
// rest of this store.
const VKEY = "mq_cutvalidated";
export function valKey(materialId, thicknessIn) { return `${materialId}|${thkKey(thicknessIn)}`; }
export function loadValidated() { try { return JSON.parse(localStorage.getItem(VKEY)) || {}; } catch { return {}; } }
export function saveValidated(v) { localStorage.setItem(VKEY, JSON.stringify(v || {})); }
export function isValidated(v, materialId, thicknessIn) { return !!(v && v[valKey(materialId, thicknessIn)]); }
export function setValidated(v, materialId, thicknessIn, on) {
  const k = valKey(materialId, thicknessIn);
  if (on) v[k] = true; else delete v[k];
  return v;
}

// Push this device's inventory to the local dev-session launcher (scripts/dev-session.mjs), which
// saves it and updates the customer price files to match (skipping MakerStock-governed lines). This
// is what lets "the tool looks at my inventory and updates the online price" happen automatically.
// STRICTLY localhost-only: the deployed customer site has no such endpoint and must never try to
// write prices — so it no-ops there. Failures are swallowed (the tool still works if the launcher
// isn't the thing serving it, e.g. a plain static server).
export async function syncInventoryToServer() {
  const h = location.hostname;
  if (h !== "localhost" && h !== "127.0.0.1") return { ok: false, skipped: "not-local" };
  try {
    const body = JSON.stringify({ version: 2, inventory: loadInventory(), cutValidated: loadValidated() });
    const res = await fetch("/__inventory", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    return await res.json().catch(() => ({ ok: res.ok }));
  } catch { return { ok: false }; }
}
