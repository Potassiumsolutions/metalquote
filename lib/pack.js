// pack.js — pure 2D shelf packer for nesting multiple part footprints onto sheets.
//
// Used to quote MULTI-PART files (e.g. a box exported as 5 panels in one file): instead of
// treating the whole file as one big rectangle, we pack each panel's bounding box so the parts
// find the smallest/cheapest sheet(s). Bounding-box nesting only (no irregular interlocking).
//
// IMPORTANT: this file is duplicated at backend/pack.js — the app (browser) and the Cloudflare
// Worker MUST pack identically or their prices diverge. Keep the two files byte-for-byte equal.
// Pure + deterministic: same inputs -> same output in V8 (browser) and V8 (Workers).

const EPS = 1e-9;

// Orientations to try for a part, given whether 90° rotation is allowed.
function orientations(w, h, allowRotate) {
  return allowRotate && Math.abs(w - h) > EPS ? [[w, h], [h, w]] : [[w, h]];
}

// Can a single part fit on an empty usable area in any allowed orientation?
export function partFitsUsable(w, h, usableW, usableH, allowRotate) {
  return orientations(w, h, allowRotate).some(([pw, ph]) => pw <= usableW + EPS && ph <= usableH + EPS);
}

/**
 * Can a w×h part fit inside usableW×usableH at SOME rotation — not just 0°/90°?
 * A long, narrow part (a sword, a blade, a rule) clears a smaller sheet cornerwise even when it
 * overruns BOTH square-on orientations. Exact closed form for a rectangle inside a rectangle.
 * NOTE: deliberately NOT used by packSheets — the shelf packer can only place axis-aligned parts.
 * It's for the single-part sheet choice, where a tilted part counts as 1 per sheet.
 */
export function fitsTilted(w, h, usableW, usableH) {
  const p = Math.max(w, h), q = Math.min(w, h);
  const a = Math.max(usableW, usableH), b = Math.min(usableW, usableH);
  if (p <= a + EPS && q <= b + EPS) return true; // already fits square-on
  if (q > b + EPS) return false;                 // too wide at any angle
  const s = p * p + q * q - a * a;
  if (s < 0) return false;
  const need = (2 * p * q * a + (p * p - q * q) * Math.sqrt(s)) / (p * p + q * q);
  return b + EPS >= need;
}

/**
 * A rotation (degrees) at which the part clears the area — the middle of the workable range, so
 * the drawn/cut placement has the most margin on both axes. 0 if it fits square-on or not at all.
 */
export function tiltAngleDeg(w, h, usableW, usableH) {
  let lo = null, hi = null;
  for (let d = 0; d <= 90; d += 0.25) {
    const t = d * Math.PI / 180, c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
    if (w * c + h * s <= usableW + EPS && w * s + h * c <= usableH + EPS) {
      if (lo === null) lo = d;
      hi = d;
    }
  }
  return lo === null ? 0 : (lo + hi) / 2;
}

/**
 * Pack `qty` copies of every part onto as few sheets as possible (First-Fit Decreasing-Height
 * shelf heuristic with optional rotation).
 *
 * @param {{w:number,h:number}[]} parts  panel footprints (inches)
 * @param {number} qty        number of complete sets
 * @param {number} usableW    usable sheet width (after tool-holder offset), inches
 * @param {number} usableH    usable sheet height, inches
 * @param {number} gap        spacing between parts, inches
 * @param {boolean} allowRotate  allow 90° rotation
 * @returns {{sheetsNeeded:number, sheets:Array<Array<{x,y,w,h,i}>>, oversized:boolean}}
 *          oversized=true (sheetsNeeded=Infinity) if any single part can't fit one empty sheet.
 */
export function packSheets(parts, qty, usableW, usableH, gap, allowRotate) {
  const g = Number(gap) || 0;
  // Expand to individual items, tagged with source-part index i for the preview.
  const items = [];
  for (let q = 0; q < qty; q++) {
    for (let i = 0; i < parts.length; i++) {
      let w = Number(parts[i].w), h = Number(parts[i].h);
      // Lay each part landscape (w >= h) when rotation is allowed, to keep shelves short.
      if (allowRotate && h > w) { const t = w; w = h; h = t; }
      items.push({ w, h, i });
    }
  }
  // Tallest first, then widest — the classic FFDH ordering. Tiebreak on i for determinism.
  items.sort((a, b) => (b.h - a.h) || (b.w - a.w) || (a.i - b.i));

  const sheets = []; // each: { placements:[], shelves:[{y,height,x}], usedH }

  const place = (sheet, it) => {
    // 1) try to drop onto an existing shelf
    for (const sh of sheet.shelves) {
      for (const [pw, ph] of orientations(it.w, it.h, allowRotate)) {
        if (ph <= sh.height + EPS && sh.x + pw <= usableW + EPS) {
          sheet.placements.push({ x: sh.x, y: sh.y, w: pw, h: ph, i: it.i });
          sh.x += pw + g;
          return true;
        }
      }
    }
    // 2) open a new shelf — orientation that fits the width and is shortest
    let best = null;
    for (const [pw, ph] of orientations(it.w, it.h, allowRotate)) {
      if (pw <= usableW + EPS && sheet.usedH + ph <= usableH + EPS) {
        if (!best || ph < best.ph) best = { pw, ph };
      }
    }
    if (best) {
      const y = sheet.usedH;
      sheet.placements.push({ x: 0, y, w: best.pw, h: best.ph, i: it.i });
      sheet.shelves.push({ y, height: best.ph, x: best.pw + g });
      sheet.usedH += best.ph + g;
      return true;
    }
    return false;
  };

  for (const it of items) {
    if (!partFitsUsable(it.w, it.h, usableW, usableH, allowRotate)) {
      return { sheetsNeeded: Infinity, sheets: [], oversized: true };
    }
    let placed = false;
    for (const sheet of sheets) {
      if (place(sheet, it)) { placed = true; break; }
    }
    if (!placed) {
      const sheet = { placements: [], shelves: [], usedH: 0 };
      place(sheet, it);
      sheets.push(sheet);
    }
  }

  return { sheetsNeeded: sheets.length, sheets: sheets.map((s) => s.placements), oversized: false };
}
