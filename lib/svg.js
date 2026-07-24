// SVG reader -> bounding box + rough cut length, in inches.
// Uses the browser's own geometry engine (getBBox / getTotalLength) for accuracy.

const PX_PER_IN = 96; // CSS reference: 96 px = 1 inch

// Parse an SVG length like "120", "120mm", "4in", "300px" into inches.
function lenToInches(str) {
  if (str == null) return null;
  const m = String(str).trim().match(/^([\d.]+)\s*([a-z%]*)$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const unit = (m[2] || "px").toLowerCase();
  switch (unit) {
    case "in": return v;
    case "mm": return v / 25.4;
    case "cm": return v / 2.54;
    case "pt": return v / 72;
    case "pc": return v / 6;
    case "px":
    case "": return v / PX_PER_IN;
    default: return null; // % or unknown
  }
}

const SHAPE_TAGS = new Set(["path", "rect", "circle", "ellipse", "polygon", "polyline", "line", "g"]);

// Detect the individual panels in a (possibly multi-part) SVG so they can be nested.
// Returns [{w,h}] in inches, or null if the file is effectively a single part (caller then
// falls back to the overall bounding box). Interior holes (e.g. finger-hole circles) are
// absorbed into the panel that contains them, not counted as parts.
function partsFromSVG(rootEl, scaleX, scaleY) {
  const kidsOf = (el) => [...el.children].filter((c) => SHAPE_TAGS.has(c.tagName.toLowerCase()));
  // Unwrap a single wrapping <g> so we see the real parts, not one container.
  let container = rootEl;
  let kids = kidsOf(container);
  while (kids.length === 1 && kids[0].tagName.toLowerCase() === "g") {
    container = kids[0];
    kids = kidsOf(container);
  }
  const boxes = [];
  for (const el of kids) {
    let bb;
    try { bb = el.getBBox(); } catch { continue; }
    if (!bb || bb.width <= 0 || bb.height <= 0) continue;
    boxes.push({ x: bb.x, y: bb.y, w: bb.width, h: bb.height, el });
  }
  if (boxes.length <= 1) return null;
  const inside = (a, b) =>
    a.x >= b.x - 1e-6 && a.y >= b.y - 1e-6 &&
    a.x + a.w <= b.x + b.w + 1e-6 && a.y + a.h <= b.y + b.h + 1e-6;
  // For each box, find the SMALLEST larger box that contains it — that makes it a hole of that box.
  const holeOf = boxes.map((a, i) => {
    let best = -1, bestArea = Infinity;
    for (let j = 0; j < boxes.length; j++) {
      if (i === j) continue;
      const b = boxes[j];
      if (b.w * b.h > a.w * a.h + 1e-6 && inside(a, b) && b.w * b.h < bestArea) { best = j; bestArea = b.w * b.h; }
    }
    return best;
  });
  const parts = [];
  for (let i = 0; i < boxes.length; i++) {
    if (holeOf[i] !== -1) continue; // a hole — rendered inside its panel, not a part of its own
    const a = boxes[i];
    // Panel geometry = its own markup plus the markup of any holes that belong to it, so the
    // preview shows the real outline + cut-outs (in the file's user-unit space; vb frames it).
    let inner = a.el.outerHTML;
    for (let k = 0; k < boxes.length; k++) if (holeOf[k] === i) inner += boxes[k].el.outerHTML;
    parts.push({
      w: a.w * scaleX,
      h: a.h * scaleY,
      shape: { inner, vb: { x: a.x, y: a.y, w: a.w, h: a.h } },
    });
  }
  return parts.length >= 2 ? parts : null;
}

export async function parseSVG(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== "svg") return null;

  // Render offscreen so getBBox() works.
  const holder = document.createElement("div");
  holder.style.cssText = "position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden";
  const clone = document.importNode(svg, true);
  holder.appendChild(clone);
  document.body.appendChild(holder);

  try {
    let bbox;
    try {
      bbox = clone.getBBox(); // union of all rendered geometry, in user units
    } catch {
      bbox = null;
    }
    if (!bbox || (bbox.width === 0 && bbox.height === 0)) {
      document.body.removeChild(holder);
      return null;
    }

    // Figure out user-unit -> inch scale.
    const widthAttr = svg.getAttribute("width");
    const heightAttr = svg.getAttribute("height");
    const viewBox = svg.getAttribute("viewBox");
    let unit = "px-assumed";
    let scaleX = 1 / PX_PER_IN; // user units are px by default
    let scaleY = 1 / PX_PER_IN;

    const wIn = lenToInches(widthAttr);
    const hIn = lenToInches(heightAttr);
    if (viewBox && wIn != null && hIn != null) {
      const vb = viewBox.split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
        scaleX = wIn / vb[2];
        scaleY = hIn / vb[3];
        unit = /mm|cm|in|pt|pc/i.test(widthAttr || "") ? "real" : "px-assumed";
      }
    } else if (wIn != null && /mm|cm|in|pt|pc/i.test(widthAttr || "")) {
      // width in real units but no viewBox: assume user units == that unit's px mapping
      unit = "real";
    }

    // Sum path/shape lengths for a cut-length estimate (in user units), and split them into the
    // OUTER profile vs INTERIOR features. An element is interior when its rendered box sits fully
    // inside the overall box (doesn't reach any edge) — that's the engraved lettering/holes, as
    // opposed to the boundary. getBoundingClientRect is used so ancestor transforms are respected.
    let cutUser = 0, outerUser = 0, interiorUser = 0;
    const interiorEls = [];
    const measurable = clone.querySelectorAll("path, line, polyline, polygon, circle, ellipse, rect");
    // The edge test must run against the GEOMETRY bounds, not the SVG canvas. Plenty of exporters
    // (Vectric, etc.) drop the artwork inside a much larger canvas — measured against the canvas,
    // an outer profile that touches no canvas edge is misread as "interior", leaving
    // outerCutLengthIn = 0 and letting the engrave-separately toggle quote a zero cut length.
    const rects = [];
    measurable.forEach((el) => {
      try { const r = el.getBoundingClientRect(); if (r && (r.width || r.height)) rects.push(r); }
      catch { /* ignore */ }
    });
    const rootRect = rects.length
      ? { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)),
          top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) }
      : clone.getBoundingClientRect();
    const eTol = Math.max(1, Math.max(rootRect.right - rootRect.left, rootRect.bottom - rootRect.top) * 0.005);
    measurable.forEach((el) => {
      let len = 0;
      if (typeof el.getTotalLength === "function") { try { len = el.getTotalLength(); } catch { len = 0; } }
      cutUser += len;
      let r = null; try { r = el.getBoundingClientRect(); } catch { /* ignore */ }
      const touchesEdge = r && (
        r.left <= rootRect.left + eTol || r.right >= rootRect.right - eTol ||
        r.top <= rootRect.top + eTol || r.bottom >= rootRect.bottom - eTol);
      if (!r || touchesEdge) outerUser += len;
      else { interiorUser += len; interiorEls.push(el); }
    });

    // Capture the source geometry for the sheet-layout preview. The inner markup is in the
    // SVG's own user-unit space (same space getBBox reports), so the bbox frames it directly.
    const vb = { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height };
    const shape = (bbox.width > 0 && bbox.height > 0) ? { inner: clone.innerHTML, vb } : null;

    // Extract individual panels for nesting (multi-part files). Must run while the clone is
    // still attached — getBBox() needs a rendered element.
    const parts = partsFromSVG(clone, scaleX, scaleY);

    // Outer-only shape (interior removed) for the engrave-separately preview — built AFTER
    // partsFromSVG, which needs the full geometry. Dropping interior elements leaves the boundary.
    let shapeOuter = shape;
    if (shape && interiorEls.length) {
      interiorEls.forEach((el) => { try { el.remove(); } catch { /* ignore */ } });
      shapeOuter = { inner: clone.innerHTML, vb };
    }

    document.body.removeChild(holder);

    const widthIn = bbox.width * scaleX;
    const heightIn = bbox.height * scaleY;
    const s = (scaleX + scaleY) / 2;

    return {
      widthIn, heightIn,
      cutLengthIn: cutUser * s,
      outerCutLengthIn: outerUser * s,       // boundary only (engrave-separately mode)
      interiorCutLengthIn: interiorUser * s, // interior features (0 = nothing to exclude)
      detectedUnit: unit === "real" ? "in/mm" : "px→in (assumed)",
      shape,
      shapeOuter,
      parts: parts || [{ w: widthIn, h: heightIn }],
    };
  } catch (e) {
    if (holder.parentNode) document.body.removeChild(holder);
    return null;
  }
}
