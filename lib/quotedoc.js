// quotedoc.js — build a branded, printable quote as a self-contained SVG (US Letter, 96dpi).
// One SVG source feeds both outputs: print-to-PDF and one-click JPG (see app.js).
// No external assets/fonts so it rasterizes to a clean, non-tainted canvas.

const W = 816, H = 1056;          // 8.5 x 11 in @ 96dpi
const M = 56;                     // page margin
const INK = "#1a1a1a", MUTE = "#6b7280", LINE = "#d1d5db", ACCENT = "#0f766e", ZEBRA = "#f3f4f6";

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n) => "$" + (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2);
const clip = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// The Potassium Solutions periodic-tile logo (from customer-guide.html), recolored to INK.
function logoSVG(x, y, w) {
  const s = w / 240; // native viewBox is 240x280
  return `<g transform="translate(${x},${y}) scale(${s})" fill="${INK}" font-family="Arial, Helvetica, sans-serif">
    <text x="120" y="36" text-anchor="middle" font-size="40" font-weight="800" textLength="212" lengthAdjust="spacingAndGlyphs">Potassium</text>
    <rect x="47" y="54" width="146" height="146" fill="none" stroke="${INK}" stroke-width="5"/>
    <text x="120" y="76" text-anchor="middle" font-size="11">19</text>
    <text x="104" y="170" text-anchor="middle" font-size="118" font-weight="800">K</text>
    <text x="151" y="170" font-size="18" font-weight="800">S&#174;l</text>
    <text x="120" y="192" text-anchor="middle" font-size="11">39.0983</text>
    <text x="120" y="256" text-anchor="middle" font-size="40" font-weight="800" textLength="206" lengthAdjust="spacingAndGlyphs">Solutions</text>
  </g>`;
}

/**
 * @param {object} d {
 *   quoteNo, date, validUntil, customer,
 *   jobDesc, sizeText, qty, perPart, total,
 *   lines: [{label, amount, note}],   // pre-filtered (no zero lines)
 *   shippingNote, disclaimer,
 *   previewSVG                        // optional on-screen sheet-layout <svg> string
 * }
 * @returns {string} full SVG document
 */
export function buildQuoteSVG(d) {
  const T = [];
  const font = `font-family="Arial, Helvetica, sans-serif"`;
  const txt = (x, y, s, o = {}) =>
    `<text x="${x}" y="${y}" ${font} font-size="${o.size || 13}" font-weight="${o.weight || 400}" ` +
    `fill="${o.fill || INK}" text-anchor="${o.anchor || "start"}"${o.spacing ? ` letter-spacing="${o.spacing}"` : ""}>${esc(s)}</text>`;

  // ---- Header: logo left, business name, big QUOTE title right ----
  T.push(logoSVG(M, M - 6, 64));
  const bx = M + 78;
  T.push(txt(bx, M + 32, "KsolDesigns", { size: 22, weight: 800 }));
  T.push(txt(bx, M + 52, "Kiki's Custom Engraving", { size: 13, fill: MUTE }));
  T.push(txt(W - M, M + 10, "QUOTE", { size: 30, weight: 800, anchor: "end", fill: ACCENT, spacing: 2 }));
  T.push(txt(W - M, M + 32, `No. ${d.quoteNo || "—"}`, { size: 12.5, anchor: "end", fill: MUTE }));

  // ---- Meta rule + Date / Valid until / Prepared for ----
  let y = M + 92;
  T.push(`<line x1="${M}" y1="${y}" x2="${W - M}" y2="${y}" stroke="${LINE}" stroke-width="1.5"/>`);
  y += 26;
  const metaCol = (x, label, val) => {
    T.push(txt(x, y, label.toUpperCase(), { size: 9.5, weight: 700, fill: MUTE, spacing: 0.6 }));
    T.push(txt(x, y + 18, val || "—", { size: 13.5, weight: 600 }));
  };
  metaCol(M, "Date", d.date);
  metaCol(M + 200, "Valid until", d.validUntil || "See below");
  metaCol(M + 400, "Prepared for", clip(d.customer || "—", 26));

  // ---- Job summary band ----
  y += 48;
  T.push(`<rect x="${M}" y="${y}" width="${W - 2 * M}" height="52" rx="6" fill="${ZEBRA}"/>`);
  T.push(txt(M + 16, y + 22, clip(d.jobDesc || "Laser-cut metal part", 60), { size: 14, weight: 700 }));
  T.push(txt(M + 16, y + 40, clip([d.sizeText, `Qty ${d.qty}`].filter(Boolean).join("  ·  "), 70), { size: 12, fill: MUTE }));
  T.push(txt(W - M - 16, y + 22, money(d.total), { size: 20, weight: 800, anchor: "end", fill: ACCENT }));
  T.push(txt(W - M - 16, y + 40, `${money(d.perPart)} each`, { size: 11.5, anchor: "end", fill: MUTE }));

  // ---- Line items table ----
  y += 84;
  T.push(txt(M, y, "DESCRIPTION", { size: 9.5, weight: 700, fill: MUTE, spacing: 0.6 }));
  T.push(txt(W - M, y, "AMOUNT", { size: 9.5, weight: 700, fill: MUTE, spacing: 0.6, anchor: "end" }));
  y += 8;
  T.push(`<line x1="${M}" y1="${y}" x2="${W - M}" y2="${y}" stroke="${INK}" stroke-width="1.5"/>`);
  const rowH = 34;
  d.lines.forEach((ln, i) => {
    const top = y + i * rowH;
    if (i % 2) T.push(`<rect x="${M}" y="${top}" width="${W - 2 * M}" height="${rowH}" fill="${ZEBRA}"/>`);
    const cy = top + rowH / 2 + 5;
    T.push(txt(M + 12, cy, ln.label, { size: 13, weight: 600 }));
    if (ln.note) T.push(txt(M + 12 + textW(ln.label, 13, 600) + 10, cy, ln.note, { size: 11, fill: MUTE }));
    T.push(txt(W - M - 12, cy, money(ln.amount), { size: 13, anchor: "end" }));
  });
  y += d.lines.length * rowH;
  T.push(`<line x1="${M}" y1="${y}" x2="${W - M}" y2="${y}" stroke="${LINE}" stroke-width="1"/>`);

  // ---- Total bar ----
  y += 14;
  T.push(`<rect x="${W - M - 260}" y="${y}" width="260" height="44" rx="6" fill="${ACCENT}"/>`);
  T.push(txt(W - M - 260 + 16, y + 28, "TOTAL", { size: 13, weight: 700, fill: "#ffffff", spacing: 1 }));
  T.push(txt(W - M - 12, y + 29, money(d.total), { size: 19, weight: 800, fill: "#ffffff", anchor: "end" }));

  // Footer notes are computed up front so the divider can float up when there are more of them
  // (leftover disposition + shipping + lead time + validity can be 4–5 lines) — otherwise a tall
  // preview + many notes would run off the page bottom.
  const notes = [d.engraveNote, d.notCurrentNote, d.disclaimer, d.leftoverNote, d.shippingNote, d.leadTimeNote, d.validUntil ? `Material pricing on this quote is held through ${d.validUntil}.` : "", d.pricingNote].filter(Boolean);
  const noteLineH = 13;
  // Terms & Conditions fine print: numbered, wrapped to the content width at a tiny size. Space is
  // reserved below so the sheet-layout preview shrinks to fit rather than overrunning the page.
  // The list is admin-editable and can grow, so the font auto-shrinks (down to 4.8px) until the
  // footer clears the total bar above it — guaranteeing everything stays on one page.
  const terms = Array.isArray(d.terms) ? d.terms : [];
  const contentW = W - 2 * M, termGap = 3;
  // Notes WRAP rather than clip. They used to be cut at 128 chars, which silently swallowed the tail
  // of anything longer — the pricing-estimate note ends in the email address to write to, and that
  // was the part being dropped. Wrapping means an admin can write a note of any length safely.
  const noteSize = 10.5;
  const noteWrapped = notes.map((n) => wrapText(n, contentW, noteSize, 400));
  const noteLines = noteWrapped.reduce((a, lines) => a + lines.length, 0);
  const floor = 372 + 34 * d.lines.length + 24; // total-bar bottom + a gap; footer must start below this
  let termSize, termLineH, termWrapped, termsH, footerTop;
  for (const sz of [6.8, 6.4, 6, 5.6, 5.2, 4.8]) {
    termSize = sz; termLineH = sz + 1.6;
    termWrapped = terms.map((t, i) => wrapText(`${i + 1}. ${t}`, contentW, sz, 400));
    termsH = terms.length ? 15 + termWrapped.reduce((a, lines) => a + lines.length * termLineH + termGap, 0) : 0;
    footerTop = H - M - Math.max(64, noteLines * noteLineH + 34 + termsH);
    if (footerTop >= floor) break; // fits above the floor at this size — stop shrinking
  }

  // ---- Sheet-layout preview (optional) — recolored to the quote's light palette ----
  const pv = embedPreview(d.previewSVG);
  if (pv) {
    y += 44 + 30; // below the total bar
    const availW = W - 2 * M;
    const availH = footerTop - (y + 14) - 16; // room left above the footer line
    if (availH > 70) {
      T.push(txt(M, y, "SHEET LAYOUT", { size: 9.5, weight: 700, fill: MUTE, spacing: 0.6 }));
      y += 14;
      const s = Math.min(availW / pv.vbW, availH / pv.vbH);
      const pw = pv.vbW * s, ph = pv.vbH * s;
      const px = M + (availW - pw) / 2;
      T.push(`<rect x="${px - 10}" y="${y - 10}" width="${pw + 20}" height="${ph + 20}" rx="8" fill="${ZEBRA}"/>`);
      T.push(`<svg x="${px}" y="${y}" width="${pw}" height="${ph}" viewBox="0 0 ${pv.vbW} ${pv.vbH}" preserveAspectRatio="xMidYMid meet">${pv.inner}</svg>`);
    }
  }

  // ---- Footer notes (divider floats with the note count, computed above) ----
  let fy = footerTop;
  T.push(`<line x1="${M}" y1="${fy}" x2="${W - M}" y2="${fy}" stroke="${LINE}" stroke-width="1"/>`);
  fy += 18;
  let nline = 0;
  noteWrapped.forEach((lines) =>
    lines.forEach((ln) => T.push(txt(M, fy + nline++ * noteLineH, ln, { size: noteSize, fill: MUTE }))));

  // ---- Terms & Conditions (fine print) ----
  if (terms.length) {
    let ty = fy + notes.length * noteLineH + 8;
    T.push(txt(M, ty, "TERMS & CONDITIONS", { size: 8, weight: 700, fill: MUTE, spacing: 0.5 }));
    ty += 10;
    termWrapped.forEach((lines) => {
      lines.forEach((ln, i) => T.push(txt(M, ty + i * termLineH, ln, { size: termSize, fill: MUTE })));
      ty += lines.length * termLineH + termGap;
    });
  }

  T.push(txt(W - M, H - M + 2, "KsolDesigns · Kiki's Custom Engraving", { size: 10, fill: MUTE, anchor: "end" }));

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>` + T.join("") + `</svg>`;
}

// Take the on-screen sheet-layout preview SVG (which uses the app's dark-theme CSS variables)
// and prepare it for embedding in the light quote page: pull the outer viewBox + inner markup,
// then swap the theme variables for concrete quote-palette colors so it renders standalone.
function embedPreview(svgStr) {
  if (!svgStr || typeof svgStr !== "string") return null;
  const m = svgStr.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!m) return null; // e.g. "part too big" message instead of an <svg>
  const vbW = parseFloat(m[1]), vbH = parseFloat(m[2]);
  if (!(vbW > 0) || !(vbH > 0)) return null;
  const open = svgStr.indexOf(">"), close = svgStr.lastIndexOf("</svg>");
  if (open < 0 || close < 0) return null;
  const inner = svgStr.slice(open + 1, close)
    .replace(/var\(--sheet-bg\)/g, "#ffffff")
    .replace(/var\(--accent-soft\)/g, "rgba(15,118,110,0.14)")
    .replace(/var\(--accent\)/g, ACCENT)
    .replace(/var\(--border\)/g, LINE);
  return { inner, vbW, vbH };
}

// Rough monospace-free width estimate for placing the light "note" after a bold label.
function textW(s, size, weight) {
  const k = weight >= 700 ? 0.58 : 0.54;
  return String(s).length * size * k;
}

// Greedy word-wrap for SVG <text> (which doesn't wrap): break a string into lines that each
// fit maxWidth at the given size/weight, using the textW estimate above.
function wrapText(str, maxWidth, size, weight) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (cur && textW(test, size, weight) > maxWidth) { lines.push(cur); cur = w; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}
