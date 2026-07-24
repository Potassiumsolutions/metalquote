// Minimal DXF reader -> bounding box + rough cut length, in inches.
// Handles LINE, LWPOLYLINE, POLYLINE/VERTEX, CIRCLE, ARC, ELLIPSE, SPLINE, POINT.
// Arcs/circles use a center±radius box (a safe slight over-estimate for quoting).

const UNIT_TO_IN = { 1: 1, 2: 12, 4: 1 / 25.4, 5: 1 / 2.54, 6: 1000 / 25.4, 8: 1 / 25400 };

export function parseDXF(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  }

  let insUnits = 1; // default to inches if not specified
  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i][1] === "$INSUNITS") {
      const v = parseInt(pairs[i + 1][1], 10);
      if (!isNaN(v)) insUnits = v;
      break;
    }
  }
  const unitFactor = UNIT_TO_IN[insUnits] || 1;

  const bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let cutLen = 0;

  // Drawable geometry for the sheet-layout preview: each entity becomes an SVG subpath (in
  // raw DXF coords). Curves are sampled into short segments so they render the same after the
  // Y-flip we apply at the end (DXF is Y-up, SVG is Y-down).
  const dpaths = [];
  const fmt = (n) => Math.round(n * 1000) / 1000;
  const pushPoly = (pts, closed) => {
    if (!pts || pts.length < 2) return;
    let d = "M " + fmt(pts[0][0]) + " " + fmt(pts[0][1]);
    for (let i = 1; i < pts.length; i++) d += " L " + fmt(pts[i][0]) + " " + fmt(pts[i][1]);
    if (closed) d += " Z";
    dpaths.push(d);
  };
  const arcPts = (cx, cy, r, a0, a1, n) => {
    const pts = [];
    for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return pts;
  };

  const add = (x, y) => {
    if (x < bb.minX) bb.minX = x;
    if (y < bb.minY) bb.minY = y;
    if (x > bb.maxX) bb.maxX = x;
    if (y > bb.maxY) bb.maxY = y;
  };

  // Walk entities in the ENTITIES section.
  let inEntities = false;
  let type = null;
  let cur = {};
  // For polylines we collect a running vertex list.
  let poly = null;

  const flush = () => {
    if (!type) return;
    if (type === "LINE") {
      if (cur[10] != null && cur[11] != null) {
        add(cur[10], cur[20]);
        add(cur[11], cur[21]);
        cutLen += Math.hypot(cur[11] - cur[10], cur[21] - cur[20]);
        pushPoly([[cur[10], cur[20]], [cur[11], cur[21]]], false);
      }
    } else if (type === "CIRCLE") {
      const r = cur[40] || 0;
      add(cur[10] - r, cur[20] - r);
      add(cur[10] + r, cur[20] + r);
      cutLen += 2 * Math.PI * r;
      pushPoly(arcPts(cur[10], cur[20], r, 0, 2 * Math.PI, 48), true);
    } else if (type === "ARC") {
      const r = cur[40] || 0;
      const a0 = (cur[50] ?? 0) * (Math.PI / 180);
      let sweep = ((cur[51] ?? 0) - (cur[50] ?? 0)) * (Math.PI / 180);
      if (sweep < 0) sweep += 2 * Math.PI;
      cutLen += r * sweep;
      // Bound the box by the ACTUAL arc sweep, not center±r. A large-radius arc (e.g. a fan/award
      // edge) only traces a short curve, but center±r is the whole phantom circle — using it would
      // inflate the part's footprint far past its real size and wreck nesting.
      const apts = arcPts(cur[10], cur[20], r, a0, a0 + sweep, Math.max(6, Math.ceil(sweep / (Math.PI / 24))));
      for (const p of apts) add(p[0], p[1]);
      pushPoly(apts, false);
    } else if (type === "ELLIPSE") {
      const majLen = Math.hypot(cur[11] || 0, cur[21] || 0);
      const b = majLen * (cur[40] || 1);
      cutLen += Math.PI * (3 * (majLen + b) - Math.sqrt((3 * majLen + b) * (majLen + 3 * b)));
      const ang = Math.atan2(cur[21] || 0, cur[11] || 0);
      const epts = [];
      for (let i = 0; i <= 64; i++) {
        const t = (2 * Math.PI * i) / 64, px = majLen * Math.cos(t), py = b * Math.sin(t);
        epts.push([(cur[10] || 0) + px * Math.cos(ang) - py * Math.sin(ang), (cur[20] || 0) + px * Math.sin(ang) + py * Math.cos(ang)]);
      }
      // bbox from the real ellipse outline (respects rotation + minor axis), not a majLen square.
      for (const p of epts) add(p[0], p[1]);
      pushPoly(epts, true);
    } else if (type === "SPLINE") {
      const pts = splinePoints(cur);
      if (pts && pts.length >= 2) {
        const closed = ((cur.flags || 0) & 1) === 1 && pts.length > 2;
        for (const p of pts) add(p[0], p[1]);
        for (let i = 1; i < pts.length; i++) cutLen += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (closed) cutLen += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
        pushPoly(pts, closed);
      }
    }
    type = null;
    cur = {};
  };

  const flushPoly = () => {
    if (!poly || poly.pts.length === 0) {
      poly = null;
      return;
    }
    for (const p of poly.pts) add(p[0], p[1]);
    for (let i = 1; i < poly.pts.length; i++) {
      cutLen += Math.hypot(poly.pts[i][0] - poly.pts[i - 1][0], poly.pts[i][1] - poly.pts[i - 1][1]);
    }
    if (poly.closed && poly.pts.length > 2) {
      const a = poly.pts[0], b = poly.pts[poly.pts.length - 1];
      cutLen += Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
    pushPoly(poly.pts, poly.closed && poly.pts.length > 2);
    poly = null;
  };

  let pendingX = null; // for pairing 10 (x) with 20 (y) inside polylines

  for (let i = 0; i < pairs.length; i++) {
    const [code, val] = pairs[i];
    if (code === 0) {
      if (val === "SECTION") continue;
      if (val === "ENDSEC") {
        inEntities = false;
        continue;
      }
    }
    if (code === 2 && val === "ENTITIES") {
      inEntities = true;
      continue;
    }
    if (!inEntities) continue;

    if (code === 0) {
      // entity boundary
      flush();
      if (poly && val !== "VERTEX") flushPoly();

      if (val === "LWPOLYLINE") {
        flushPoly();
        poly = { pts: [], closed: false, lw: true };
        type = null;
        pendingX = null;
      } else if (val === "POLYLINE") {
        flushPoly();
        poly = { pts: [], closed: false, lw: false };
        type = null;
      } else if (val === "VERTEX") {
        // vertex of an old-style POLYLINE
        type = "VERTEX";
        cur = {};
      } else if (val === "SEQEND") {
        // end of POLYLINE vertices
      } else {
        type = val;
        cur = {};
      }
      continue;
    }

    const num = parseFloat(val);
    if (poly && poly.lw) {
      // LWPOLYLINE: repeated 10/20 pairs, 70 = flags (1 => closed)
      if (code === 70) poly.closed = (parseInt(val, 10) & 1) === 1;
      else if (code === 10) pendingX = num;
      else if (code === 20 && pendingX != null) {
        poly.pts.push([pendingX, num]);
        pendingX = null;
      }
      continue;
    }
    if (type === "VERTEX") {
      if (code === 10) cur[10] = num;
      else if (code === 20 && poly) poly.pts.push([cur[10], num]);
      continue;
    }
    if (poly && !poly.lw) {
      if (code === 70) poly.closed = (parseInt(val, 10) & 1) === 1;
      continue;
    }
    if (type === "SPLINE") {
      // SPLINE repeats codes, so collect into arrays instead of overwriting cur[code].
      if (code === 10) (cur.cx = cur.cx || []).push(num);        // control point x
      else if (code === 20) (cur.cy = cur.cy || []).push(num);   // control point y
      else if (code === 11) (cur.fx = cur.fx || []).push(num);   // fit point x
      else if (code === 21) (cur.fy = cur.fy || []).push(num);   // fit point y
      else if (code === 40) (cur.knots = cur.knots || []).push(num);
      else if (code === 41) (cur.weights = cur.weights || []).push(num);
      else if (code === 71) cur.degree = parseInt(val, 10);
      else if (code === 70) cur.flags = parseInt(val, 10);
      continue;
    }
    // regular entity attributes
    if ([10, 20, 11, 21, 40, 50, 51].includes(code)) cur[code] = num;
  }
  flush();
  flushPoly();

  if (!isFinite(bb.minX)) return null;

  const w = (bb.maxX - bb.minX) * unitFactor;
  const h = (bb.maxY - bb.minY) * unitFactor;

  // Split the subpaths into the OUTER profile (the boundary — subpaths whose bbox reaches an edge
  // of the overall bbox) and INTERIOR features (lettering/logos/holes that float inside). Used by
  // the "cut outer profile only, engrave interior separately" toggle: interior length can be
  // excluded from the cut and interior geometry dropped from the preview.
  const split = splitOuterInterior(dpaths, bb);

  // Shape for the preview: raw-unit paths, wrapped in a Y-flip so DXF (Y-up) draws upright
  // in SVG (Y-down). vb is the raw-unit bounding box; the preview scales it into each cell.
  const vb = { x: fmt(bb.minX), y: fmt(bb.minY), w: fmt(bb.maxX - bb.minX), h: fmt(bb.maxY - bb.minY) };
  const yflip = fmt(bb.minY + bb.maxY);
  let shape = null, shapeOuter = null;
  if (dpaths.length) {
    shape = { inner: `<g transform="matrix(1 0 0 -1 0 ${yflip})"><path d="${dpaths.join(" ")}"/></g>`, vb };
    // Outer-only variant (interior removed) for the engrave-separately preview.
    shapeOuter = split.outer.length
      ? { inner: `<g transform="matrix(1 0 0 -1 0 ${yflip})"><path d="${split.outer.join(" ")}"/></g>`, vb }
      : shape;
  }

  // Group entities into panels for nesting (multi-part files). Each drawn entity already has an
  // SVG subpath in `dpaths`; cluster entities whose bounding boxes overlap/touch (a panel outline
  // plus the holes inside it), then take each cluster's bbox as a part. Heuristic — falls back to
  // the single overall bbox when it can't split cleanly.
  const parts = partsFromDXF(dpaths, unitFactor) || [{ w, h }];

  return {
    widthIn: w,
    heightIn: h,
    cutLengthIn: cutLen * unitFactor,
    outerCutLengthIn: split.outerLen * unitFactor,      // boundary only (engrave-separately mode)
    interiorCutLengthIn: split.interiorLen * unitFactor, // interior features (0 = nothing to exclude)
    detectedUnit: UNIT_TO_IN[insUnits] ? (insUnits === 1 || insUnits === 2 ? "in" : "mm") : "unknown",
    shape,
    shapeOuter,
    parts,
  };
}

// Length of one "M x y L x y … [Z]" subpath (raw units). Curves are already sampled into L
// segments, so summing segment lengths is accurate; a trailing Z adds the closing segment.
function pathLen(d) {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (/z\s*$/i.test(d) && pts.length > 2) len += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
  return len;
}

// Classify subpaths as OUTER (boundary) vs INTERIOR (inside the outline). A subpath is OUTER if
// its bbox reaches any edge of the overall bbox (within a small tolerance) — the boundary segments
// define those extremes, while interior features (engraved lettering, holes) sit strictly inside.
function splitOuterInterior(dpaths, bb) {
  const outer = [], interior = [];
  let outerLen = 0, interiorLen = 0;
  if (!isFinite(bb.minX)) return { outer, interior, outerLen, interiorLen };
  const tol = Math.max(1e-4, Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) * 0.005);
  for (const d of dpaths) {
    const box = boxOfPath(d);
    const len = pathLen(d);
    const touchesEdge = box && (
      box.minX <= bb.minX + tol || box.maxX >= bb.maxX - tol ||
      box.minY <= bb.minY + tol || box.maxY >= bb.maxY - tol);
    if (!box || touchesEdge) { outer.push(d); outerLen += len; }
    else { interior.push(d); interiorLen += len; }
  }
  return { outer, interior, outerLen, interiorLen };
}

// Bounding box (raw units) of one SVG-ish subpath string like "M x y L x y Z".
function boxOfPath(d) {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i], y = nums[i + 1];
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// Union-find cluster of entity boxes into panels; absorb holes (they overlap their panel bbox).
// Each cluster keeps its own subpaths so the preview can draw the real outline + cut-outs.
function partsFromDXF(dpaths, unitFactor) {
  const items = dpaths.map((d) => ({ box: boxOfPath(d), d })).filter((x) => x.box);
  if (items.length <= 1) return null;
  const n = items.length;
  const parent = [...Array(n).keys()];
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const tol = 1e-6;
  const overlap = (a, b) =>
    a.minX <= b.maxX + tol && b.minX <= a.maxX + tol && a.minY <= b.maxY + tol && b.minY <= a.maxY + tol;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (overlap(items[i].box, items[j].box)) parent[find(i)] = find(j);
  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i), b = items[i].box;
    let c = clusters.get(r);
    if (!c) { c = { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, paths: [items[i].d] }; clusters.set(r, c); }
    else { c.minX = Math.min(c.minX, b.minX); c.minY = Math.min(c.minY, b.minY); c.maxX = Math.max(c.maxX, b.maxX); c.maxY = Math.max(c.maxY, b.maxY); c.paths.push(items[i].d); }
  }

  // Containment merge: overlap-clustering chains a part's perimeter into one cluster but leaves
  // interior features (engraved text, holes) that float free of the perimeter as their own
  // clusters. Any cluster whose bbox sits fully inside a LARGER cluster is such a feature —
  // fold it into the smallest enclosing cluster so a single engraved part reads as ONE part,
  // not one-per-letter. (Genuine multi-part layouts sit side by side, so none contains another.)
  let arr = [...clusters.values()];
  const area = (c) => (c.maxX - c.minX) * (c.maxY - c.minY);
  const contains = (a, b) =>
    b.minX >= a.minX - tol && b.minY >= a.minY - tol && b.maxX <= a.maxX + tol && b.maxY <= a.maxY + tol;
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i]) continue;
      let best = -1;
      for (let j = 0; j < arr.length; j++) {
        if (j === i || !arr[j]) continue;
        if (contains(arr[j], arr[i]) && area(arr[j]) > area(arr[i]) + tol && (best === -1 || area(arr[j]) < area(arr[best]))) best = j;
      }
      if (best !== -1) {
        const a = arr[best], b = arr[i];
        a.minX = Math.min(a.minX, b.minX); a.minY = Math.min(a.minY, b.minY);
        a.maxX = Math.max(a.maxX, b.maxX); a.maxY = Math.max(a.maxY, b.maxY);
        a.paths.push(...b.paths);
        arr[i] = null;
        merged = true;
      }
    }
  }
  arr = arr.filter(Boolean);
  if (arr.length <= 1) return null;
  return arr.map((c) => ({
    w: (c.maxX - c.minX) * unitFactor,
    h: (c.maxY - c.minY) * unitFactor,
    // Y-flip within this cluster's own box so DXF (Y-up) renders upright in SVG (Y-down).
    shape: {
      inner: `<g transform="matrix(1 0 0 -1 0 ${c.minY + c.maxY})"><path d="${c.paths.join(" ")}" fill="none" stroke="black" stroke-width="0.1"/></g>`,
      vb: { x: c.minX, y: c.minY, w: c.maxX - c.minX, h: c.maxY - c.minY },
    },
  }));
}

// ---- SPLINE (B-spline / NURBS) evaluation -------------------------------------------------
// Sample a DXF SPLINE into a polyline (raw DXF coords) so it contributes to the bbox, cut
// length, and preview like every other curve. Handles clamped/unclamped, rational (weights),
// and closed splines via De Boor's algorithm; falls back to fit points, then control points.
function splinePoints(cur) {
  const cx = cur.cx || [], cy = cur.cy || [];
  const ctrl = [];
  for (let i = 0; i < Math.min(cx.length, cy.length); i++) ctrl.push([cx[i], cy[i]]);
  const degree = cur.degree > 0 ? cur.degree : 3;
  let knots = cur.knots || [];
  const weights = cur.weights && cur.weights.length === ctrl.length ? cur.weights : null;

  if (ctrl.length >= degree + 1) {
    // A valid knot vector has (ctrlCount + degree + 1) entries; synthesize a clamped uniform
    // one when the file's is missing or malformed rather than dropping the curve.
    if (knots.length !== ctrl.length + degree + 1) knots = clampedUniformKnots(ctrl.length, degree);
    return sampleSpline(ctrl, knots, degree, weights);
  }
  // Fit-point-only spline (control points absent): approximate by connecting the fit points.
  const fx = cur.fx || [], fy = cur.fy || [];
  if (fx.length >= 2) {
    const fp = [];
    for (let i = 0; i < Math.min(fx.length, fy.length); i++) fp.push([fx[i], fy[i]]);
    return fp;
  }
  return ctrl.length >= 2 ? ctrl : null;
}

function clampedUniformKnots(numCtrl, p) {
  const n = numCtrl - 1, m = n + p + 1, knots = [];
  for (let i = 0; i <= m; i++) {
    if (i <= p) knots.push(0);
    else if (i >= numCtrl) knots.push(n - p + 1);
    else knots.push(i - p);
  }
  return knots;
}

function sampleSpline(ctrl, knots, degree, weights) {
  const n = ctrl.length - 1, p = degree;
  const u0 = knots[p], u1 = knots[n + 1];
  if (!(u1 > u0)) return ctrl.length >= 2 ? ctrl : null;
  const N = Math.max(16, (ctrl.length - 1) * 8); // samples/spline; ~8 per control-point span
  const pts = [];
  for (let i = 0; i <= N; i++) pts.push(deBoor(u0 + (u1 - u0) * (i / N), ctrl, knots, p, weights));
  return pts;
}

// Evaluate a (possibly rational) B-spline at parameter u using De Boor's algorithm in
// homogeneous coordinates, then project back. Returns [x, y].
function deBoor(u, ctrl, knots, p, weights) {
  const n = ctrl.length - 1;
  const k = findSpan(n, p, u, knots);
  const d = [];
  for (let j = 0; j <= p; j++) {
    const idx = j + k - p;
    const w = weights ? weights[idx] : 1;
    d.push([ctrl[idx][0] * w, ctrl[idx][1] * w, w]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p;
      const denom = knots[i + p - r + 1] - knots[i];
      const a = denom === 0 ? 0 : (u - knots[i]) / denom;
      d[j][0] = (1 - a) * d[j - 1][0] + a * d[j][0];
      d[j][1] = (1 - a) * d[j - 1][1] + a * d[j][1];
      d[j][2] = (1 - a) * d[j - 1][2] + a * d[j][2];
    }
  }
  const w = d[p][2] || 1;
  return [d[p][0] / w, d[p][1] / w];
}

function findSpan(n, p, u, knots) {
  if (u >= knots[n + 1]) return n;
  if (u <= knots[p]) return p;
  let low = p, high = n + 1, mid = (low + high) >> 1;
  while (u < knots[mid] || u >= knots[mid + 1]) {
    if (u < knots[mid]) high = mid; else low = mid;
    mid = (low + high) >> 1;
  }
  return mid;
}
