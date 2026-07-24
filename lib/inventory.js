// inventory.js — owner-only sheet-stock tracking, stored in the browser's localStorage.
//
// There is no server/DB: the internal tool runs locally and the quote flow deducts stock right in
// the browser, so localStorage is the live store. It's per-origin (the owner's machine), never
// shipped as data, and shared between the quote tool (index.html/app.js) and the editor
// (admin.html/admin.js) since both are same-origin. Use Export/Import in the admin to back it up.
//
// Stock is keyed by material + thickness + sheet size — a quote picks exactly one of each, so a
// deduction maps to one line. Quantities are whole sheets.

const KEY = "mq_inventory";

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

export function getStock(inv, materialId, thicknessIn, sheetId) {
  return Number(inv[lineKey(materialId, thicknessIn, sheetId)] || 0);
}

// Set an absolute on-hand quantity (whole sheets). 0 or blank removes the line to keep the store tidy.
export function setStock(inv, materialId, thicknessIn, sheetId, qty) {
  const k = lineKey(materialId, thicknessIn, sheetId);
  const n = Math.round(Number(qty) || 0);
  if (n === 0) delete inv[k]; else inv[k] = n;
  return inv;
}

// Add delta (negative to deduct). Returns the resulting on-hand quantity (may go negative).
export function adjustStock(inv, materialId, thicknessIn, sheetId, delta) {
  const next = getStock(inv, materialId, thicknessIn, sheetId) + Math.round(Number(delta) || 0);
  const k = lineKey(materialId, thicknessIn, sheetId);
  if (next === 0) delete inv[k]; else inv[k] = next;
  return next;
}

export function totalSheets(inv) {
  return Object.values(inv || {}).reduce((a, n) => a + (Number(n) || 0), 0);
}
