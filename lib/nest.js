// Client-side nesting PREVIEW. Mirrors the backend's grid packing so the customer can
// see how their parts lay out on a 24x24 sheet. The authoritative count/price comes from
// the backend; this is just for the picture.

import { tiltAngleDeg } from "./pack.js";

export function nestPreview(partW, partH, opts = {}) {
  const W = opts.sheetW ?? 24;
  const H = opts.sheetH ?? 24;
  const ho = opts.holderOffset ?? opts.margin ?? 0.25; // trimmed off each X end for tool holders
  const er = opts.edgeReserve ?? 0;                     // reserved strip on each Y (top/bottom) end
  const gap = opts.nest ? (opts.gapNest ?? 0.1) : (opts.gapPlain ?? 0.2);
  const allowRotate = opts.nest && (opts.allowRotate ?? true);

  const layoutFor = (w, h) => {
    const availW = W - 2 * ho;
    const availH = H - 2 * er; // holders on the X ends; edge reserve on the Y (top/bottom) ends
    if (w <= 0 || h <= 0 || w > availW || h > availH) return { count: 0, rects: [], cols: 0, rows: 0 };
    const cols = Math.floor((availW + gap) / (w + gap));
    const rows = Math.floor((availH + gap) / (h + gap));
    const rects = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        rects.push({ x: ho + c * (w + gap), y: er + r * (h + gap), w, h });
      }
    }
    return { count: cols * rows, rects, cols, rows };
  };

  let best = layoutFor(partW, partH);
  best.rotated = false;
  if (allowRotate) {
    const alt = layoutFor(partH, partW);
    if (alt.count > best.count) {
      alt.rotated = true;
      best = alt;
    }
  }
  // Nothing fits square-on — a long narrow part may still clear the sheet CORNERWISE. Draw the
  // single part at its natural size, centred, tilted to the middle of the workable angle range.
  // Matches the 1-per-sheet the pricing path counts for a tilted fit.
  if (best.count === 0) {
    const availW = W - 2 * ho, availH = H - 2 * er;
    const deg = tiltAngleDeg(partW, partH, availW, availH);
    if (deg > 0) {
      best = {
        count: 1, cols: 1, rows: 1, rotated: false, tilt: deg,
        rects: [{ x: ho + (availW - partW) / 2, y: er + (availH - partH) / 2, w: partW, h: partH }],
      };
    }
  }
  best.sheetW = W;
  best.sheetH = H;
  best.holderOffset = ho;
  best.edgeReserve = er;
  return best;
}

// Build a small SVG string showing the sheet + nested parts. If `shape` (the real part
// outline, captured by the DXF/SVG readers) is provided, each cell renders that outline;
// otherwise it falls back to plain rectangles.
export function nestSVG(layout, shape) {
  const scale = 12; // px per inch
  const W = layout.sheetW * scale;
  const H = layout.sheetH * scale;
  const rotated = !!layout.rotated;
  const tilt = Number(layout.tilt) || 0; // cornerwise placement (see nestPreview)

  let cells;
  if (shape && shape.inner && shape.vb && shape.vb.w > 0 && shape.vb.h > 0) {
    const vb = `${shape.vb.x} ${shape.vb.y} ${shape.vb.w} ${shape.vb.h}`;
    cells = layout.rects
      .map((r) => {
        const cx = r.x * scale, cy = r.y * scale, cw = r.w * scale, ch = r.h * scale;
        if (tilt) {
          // Natural size, spun about its own centre by the fitted angle.
          const mx = cx + cw / 2, my = cy + ch / 2;
          return `<g transform="rotate(${tilt.toFixed(2)} ${mx} ${my})">` +
            `<svg x="${cx}" y="${cy}" width="${cw}" height="${ch}" viewBox="${vb}" ` +
            `preserveAspectRatio="none" class="ps-shape">${shape.inner}</svg></g>`;
        }
        if (!rotated) {
          return `<svg x="${cx}" y="${cy}" width="${cw}" height="${ch}" viewBox="${vb}" ` +
            `preserveAspectRatio="none" class="ps-shape">${shape.inner}</svg>`;
        }
        // Nesting rotated the part 90°: draw the un-rotated shape (box ch×cw, centred on the
        // cell centre) and rotate the whole thing 90° about that centre to fill the cell.
        const mx = cx + cw / 2, my = cy + ch / 2;
        const ix = mx - ch / 2, iy = my - cw / 2;
        return `<g transform="rotate(90 ${mx} ${my})">` +
          `<svg x="${ix}" y="${iy}" width="${ch}" height="${cw}" viewBox="${vb}" ` +
          `preserveAspectRatio="none" class="ps-shape">${shape.inner}</svg></g>`;
      })
      .join("");
  } else {
    cells = layout.rects
      .map((r) => {
        const cx = r.x * scale, cy = r.y * scale, cw = r.w * scale, ch = r.h * scale;
        const rect = `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" ` +
          `rx="1.5" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1"/>`;
        return tilt ? `<g transform="rotate(${tilt.toFixed(2)} ${cx + cw / 2} ${cy + ch / 2})">${rect}</g>` : rect;
      })
      .join("");
  }

  // Shade the reserved strips: tool-holder offset on each X end, edge reserve on each Y (top/bottom)
  // end — both unusable material.
  const ho = (layout.holderOffset || 0) * scale;
  const er = (layout.edgeReserve || 0) * scale;
  const holderZones =
    (ho > 0
      ? `<rect x="0" y="0" width="${ho}" height="${H}" fill="var(--border)" opacity="0.18"/>` +
        `<rect x="${W - ho}" y="0" width="${ho}" height="${H}" fill="var(--border)" opacity="0.18"/>`
      : "") +
    (er > 0
      ? `<rect x="0" y="0" width="${W}" height="${er}" fill="var(--border)" opacity="0.18"/>` +
        `<rect x="0" y="${H - er}" width="${W}" height="${er}" fill="var(--border)" opacity="0.18"/>`
      : "");

  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" ` +
    `style="max-height:320px;background:var(--sheet-bg);border-radius:6px">` +
    `<style>.ps-shape *{fill:var(--accent-soft)!important;stroke:var(--accent)!important;` +
    `stroke-width:1.2px!important;vector-effect:non-scaling-stroke;}</style>` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" ` +
    `stroke="var(--border)" stroke-width="1" stroke-dasharray="4 3"/>` +
    holderZones +
    cells +
    `</svg>`
  );
}

// Draw a MULTI-PART packed layout: each nested panel rendered with its REAL outline (and
// cut-outs) when available, else a plain rectangle, plus the shaded tool-holder strips.
// `placements` come from pack.js in usable-area coords (x measured from inside the left holder),
// so we shift each by the holder offset. `parts[p.i]` supplies each panel's {w,h,shape}.
export function nestMultiSVG(sheetWIn, sheetHIn, holderOffsetIn, placements, parts, edgeReserveIn = 0) {
  const scale = 12; // px per inch
  const W = sheetWIn * scale, H = sheetHIn * scale;
  const ho = holderOffsetIn * scale;
  const er = (edgeReserveIn || 0) * scale;
  const approx = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.02 + 1e-6;
  const cells = (placements || [])
    .map((p) => {
      const cx = (holderOffsetIn + p.x) * scale, cy = (edgeReserveIn + p.y) * scale, cw = p.w * scale, ch = p.h * scale;
      const part = parts && parts[p.i];
      const shape = part && part.shape;
      let body;
      if (shape && shape.inner && shape.vb && shape.vb.w > 0 && shape.vb.h > 0) {
        const vb = `${shape.vb.x} ${shape.vb.y} ${shape.vb.w} ${shape.vb.h}`;
        // The packer may have rotated this panel 90° relative to its natural orientation.
        const rotated = !(approx(p.w, part.w) && approx(p.h, part.h));
        if (!rotated) {
          body = `<svg x="${cx}" y="${cy}" width="${cw}" height="${ch}" viewBox="${vb}" ` +
            `preserveAspectRatio="none" class="ps-shape">${shape.inner}</svg>`;
        } else {
          // Draw the un-rotated shape (box ch×cw, centred on the cell) and rotate 90° to fill it.
          const mx = cx + cw / 2, my = cy + ch / 2, ix = mx - ch / 2, iy = my - cw / 2;
          body = `<g transform="rotate(90 ${mx} ${my})">` +
            `<svg x="${ix}" y="${iy}" width="${ch}" height="${cw}" viewBox="${vb}" ` +
            `preserveAspectRatio="none" class="ps-shape">${shape.inner}</svg></g>`;
        }
      } else {
        // Fallback: no geometry for this panel — draw its footprint.
        body = `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="1.5" ` +
          `fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1"/>`;
      }
      // Faint part number, centred and always upright, sized to the cell so it stays legible
      // even when many small parts are packed together.
      let label = "";
      if (Number.isFinite(p.i)) {
        const fs = Math.max(6, Math.min(15, Math.min(cw, ch) * 0.42));
        label = `<text x="${cx + cw / 2}" y="${cy + ch / 2}" text-anchor="middle" ` +
          `dominant-baseline="central" font-size="${fs.toFixed(1)}" font-weight="700" ` +
          `fill="var(--accent)" opacity="0.4" style="pointer-events:none">${p.i + 1}</text>`;
      }
      return `<g>${body}${label}</g>`;
    })
    .join("");
  const holderZones =
    (ho > 0
      ? `<rect x="0" y="0" width="${ho}" height="${H}" fill="var(--border)" opacity="0.18"/>` +
        `<rect x="${W - ho}" y="0" width="${ho}" height="${H}" fill="var(--border)" opacity="0.18"/>`
      : "") +
    (er > 0
      ? `<rect x="0" y="0" width="${W}" height="${er}" fill="var(--border)" opacity="0.18"/>` +
        `<rect x="0" y="${H - er}" width="${W}" height="${er}" fill="var(--border)" opacity="0.18"/>`
      : "");
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" ` +
    `style="max-height:320px;background:var(--sheet-bg);border-radius:6px">` +
    `<style>.ps-shape *{fill:var(--accent-soft)!important;stroke:var(--accent)!important;` +
    `stroke-width:1.2px!important;vector-effect:non-scaling-stroke;}</style>` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" ` +
    `stroke="var(--border)" stroke-width="1" stroke-dasharray="4 3"/>` +
    holderZones +
    cells +
    `</svg>`
  );
}
