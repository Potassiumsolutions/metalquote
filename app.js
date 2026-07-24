// MetalQuote front end — orchestration.
// Set BACKEND_URL to your deployed Worker to price with your HIDDEN markup + live prices.
// Leave it blank to run in DEMO mode (prices come from data/demo-prices.json — visible!).
//
// Material list + layout are ALWAYS loaded from data/materials.json (no prices there).
// Demo prices/markup are loaded from data/demo-prices.json only when BACKEND_URL is blank.
// Edit both with admin.html — never hand-edit the JSON.

import { parseDXF } from "./lib/dxf.js";
import { parseSVG } from "./lib/svg.js";
import { nestPreview, nestSVG, nestMultiSVG } from "./lib/nest.js";
import { packSheets, partFitsUsable, fitsTilted, tiltAngleDeg } from "./lib/pack.js";
import { buildInvoiceIIF, iifDate } from "./lib/qbiif.js";
import { buildQuoteSVG } from "./lib/quotedoc.js";
import { loadInventory, saveInventory, getStock, adjustStock } from "./lib/inventory.js";

const CONFIG = {
  BACKEND_URL: "https://metalquote.ksoldesigns.workers.dev", // e.g. "https://metalquote.you.workers.dev"
  EDITION: "customer", // "internal" (you: full costs + margin) | "customer" (public: price only)
};

// ---- Loaded at startup from the data/ files ----
let MATERIALS = [];       // [{id,name,thicknesses:[{label,in}]}]
let LAYOUT = null;        // {sheet:{widthIn,heightIn}, maxPartIn, marginIn, gapNestIn, gapPlainIn, allowRotate}
let DEMO = null;          // demo mode only: {markup, settings:{...knobs}, prices:{mat:{thk:price}}}

// ---- State ----
// fileParts/fileBBox: the individual panels detected in a multi-part file (null for single-part
// or hand-typed sizes). Used only while the width/height fields still match the loaded file.
const state = { widthIn: 0, heightIn: 0, cutLengthIn: 0, outerCutLengthIn: 0, interiorCutLengthIn: 0, shape: null, shapeOuter: null, fileParts: null, fileBBox: null };

// Engrave-interior mode: the loaded file has interior features (lettering/logos) that are engraved
// separately, so the quote should cut the outer blank only. Toggled by #engrave-interior, and only
// offered for single-part files that actually have interior geometry to exclude.
function engraveInterior() { return !!(els.engraveToggle && els.engraveToggle.checked && !els.engraveField.hidden); }
function activeCutLengthIn() {
  return engraveInterior() ? (state.outerCutLengthIn || 0) : (state.cutLengthIn || 0);
}
function activeShape() {
  return engraveInterior() && state.shapeOuter ? state.shapeOuter : state.shape;
}
// Owner-only setup-fee waiver: "none" (charge per sheet), "after2" (bill only the first 2
// sheets), or "all" (waive entirely). Only honored in the internal edition — the control is
// hidden for customers and the Worker never sees it, so this is always "none" for customers.
function setupWaiveMode() {
  return (INTERNAL && els.setupWaive && els.setupWaive.value) || "none";
}
// Owner-only parts-per-sheet override. The packer nests BOUNDING BOXES, so a tapered part (sword,
// blade, hook) that really interlocks several per sheet is undercounted — this lets the owner set
// the true count. 0/blank = use the computed count. Internal edition only; the Worker never sees
// it (a client-supplied capacity would be a way to talk the price down).
function ppsOverride() {
  if (!INTERNAL || !els.ppsOverride) return 0;
  const n = Math.floor(Number(els.ppsOverride.value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The panels to nest right now: the loaded file's panels if the size fields still match it,
// otherwise a single rectangle from the typed width/height (a manual edit = one part).
function currentParts() {
  const near = (a, b) => Math.abs(a - b) <= 0.02;
  if (state.fileParts && state.fileBBox && near(state.widthIn, state.fileBBox.w) && near(state.heightIn, state.fileBBox.h))
    return state.fileParts;
  return [{ w: state.widthIn, h: state.heightIn }];
}

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const els = {
  drop: $("drop"), file: $("file"), browse: $("browse"), fileStatus: $("file-status"),
  width: $("width"), height: $("height"),
  material: $("material"), thickness: $("thickness"), qty: $("qty"), nest: $("nest"), sheetPref: $("sheet-pref"),
  stockReadout: $("stock-readout"),
  quoteBtn: $("quote-btn"), error: $("error"),
  resultEmpty: $("result-empty"), result: $("result"),
  total: $("total"), perpart: $("perpart"), qtyEcho: $("qty-echo"),
  bdMaterial: $("bd-material"), bdMachine: $("bd-machine"), bdMachineNote: $("bd-machine-note"),
  bdCutRow: $("bd-cut-row"), bdCut: $("bd-cut"), bdCutMetric: $("bd-cut-metric"),
  bdGas: $("bd-gas"), bdGasRow: $("bd-gas-row"),
  bdProcess: $("bd-process"), bdProcessNote: $("bd-process-note"), bdMinRow: $("bd-min-row"), bdMin: $("bd-min"), bdTotal: $("bd-total"),
  setupWaive: $("setup-waive"), setupWaiveField: $("setup-waive-field"),
  ppsOverride: $("pps-override"), ppsField: $("pps-field"),
  metaFit: $("meta-fit"), metaSheets: $("meta-sheets"), minNote: $("min-note"), sheetNote: $("sheet-note"), stockOffer: $("stock-offer"),
  shipLeftover: $("ship-leftover"), leftoverField: $("leftover-field"),
  engraveToggle: $("engrave-interior"), engraveField: $("engrave-field"), engraveNote: $("engrave-note"),
  nestSvg: $("nest-svg"), modeBadge: $("mode-badge"), sheetDim: $("sheet-dim"), sheetCap: $("sheet-cap"),
  expiryBanner: $("expiry-banner"), validityNote: $("validity-note"), shippingNote: $("shipping-note"), leadNote: $("lead-note"),
  pricingNote: $("pricing-note"), requestNote: $("request-note"),
  notCurrentNote: $("notcurrent-note"), driftBanner: $("drift-banner"),
  ownerFreight: $("owner-freight"), ownerBadge: $("owner-badge"),
  costBreakdown: $("cost-breakdown"), cbMaterial: $("cb-material"), cbFreight: $("cb-freight"),
  cbMachine: $("cb-machine"), cbGas: $("cb-gas"), cbGasRow: $("cb-gas-row"), cbProcess: $("cb-process"),
  cbTotalCost: $("cb-totalcost"), cbMarkup: $("cb-markup"), cbPrice: $("cb-price"), cbMargin: $("cb-margin"),
  qbExport: $("qb-export"), qbCustomer: $("qb-customer"), qbDocnum: $("qb-docnum"),
  qbAr: $("qb-ar"), qbIncome: $("qb-income"), qbBtn: $("qb-btn"), qbStatus: $("qb-status"),
  savePdf: $("save-pdf"), saveJpg: $("save-jpg"),
  invDeduct: $("inv-deduct"), invOnhand: $("inv-onhand"), invQty: $("inv-qty"), invBtn: $("inv-btn"), invStatus: $("inv-status"),
  aboutBtn: $("about-btn"), aboutModal: $("about-modal"), aboutLink: $("about-link"), footYear: $("foot-year"),
  termsModal: $("terms-modal"), termsLink: $("terms-link"), termsList: $("terms-list"),
  settingsBtn: $("settings-btn"), inventoryBtn: $("inventory-btn"),
  installBtn: $("install-btn"),
};

// Last rendered quote, kept for the owner-only QuickBooks export.
let lastQuote = null;

// Edition. The INTERNAL view (full cost + margin breakdown, inbound freight, QuickBooks export,
// exact machine time) is for the owner only. The "internal" build shows it by default; the
// "customer" build (public PWA) never does. In the internal build you can preview the customer
// view with ?owner=0, and ?owner=1 restores the internal view.
//
// The preview is deliberately PER-TAB (sessionStorage): it survives reloads while you're looking
// around as a customer, but closing the tool ALWAYS reopens in owner view. It used to persist in
// localStorage, which meant leaving it on customer view silently hid every owner control on the
// next launch — with no way back except hand-typing ?owner=1.
const EDITION = CONFIG.EDITION === "customer" ? "customer" : "internal";
const INTERNAL = (() => {
  if (EDITION === "customer") return false;
  try {
    try { localStorage.removeItem("mq_owner"); } catch { /* clear the old sticky flag */ }
    const p = new URLSearchParams(location.search).get("owner");
    if (p === "0") { sessionStorage.setItem("mq_owner", "0"); return false; }
    if (p === "1") { sessionStorage.removeItem("mq_owner"); return true; }
    return sessionStorage.getItem("mq_owner") !== "0";
  } catch { return true; }
})();
// Back-compat alias — existing gates read OWNER.
const OWNER = INTERNAL;

const DEFAULT_REQUEST_ONLY_MSG =
  "Pricing for this material is too volatile to quote automatically right now. Please contact us for a current price.";

// ---- Init ----
async function init() {
  if (!CONFIG.BACKEND_URL) els.modeBadge.hidden = false;
  // Owner ⇄ customer-view toggle. The internal edition can preview exactly what a customer sees
  // (?owner=0). That used to be URL-only, and previewing hid every owner control INCLUDING this
  // badge — leaving no way back without hand-typing ?owner=1. So the badge is a real two-way
  // button, shown for the whole internal edition (both states) and never in the customer build.
  if (EDITION === "internal" && els.ownerBadge) {
    els.ownerBadge.hidden = false;
    els.ownerBadge.textContent = INTERNAL ? "⇄ Owner view" : "⇄ Customer preview";
    els.ownerBadge.title = INTERNAL
      ? "You're seeing the internal owner view. Click to preview what customers see."
      : "You're previewing the customer view. Click to return — or just close the tool, it always reopens in owner view.";
    els.ownerBadge.classList.toggle("previewing", !INTERNAL);
    els.ownerBadge.addEventListener("click", () => {
      const u = new URL(location.href);
      u.searchParams.set("owner", INTERNAL ? "0" : "1");
      location.href = u.toString();
    });
  }
  // Settings link → the control panel. Internal edition only; the customer build ships no admin.html.
  if (INTERNAL && els.settingsBtn) {
    els.settingsBtn.hidden = false;
    els.settingsBtn.addEventListener("click", () => { window.location.href = "admin.html"; });
  }
  // Inventory link → the standalone stock module. Internal edition only; not shipped to customers.
  if (INTERNAL && els.inventoryBtn) {
    els.inventoryBtn.hidden = false;
    els.inventoryBtn.addEventListener("click", () => { window.location.href = "inventory.html"; });
  }
  // Owner-only reference: what "Setup & handling" covers + its per-size pricing. Reveal the
  // hover flyout on the breakdown line and the note in the About modal. Both stay hidden in the
  // customer edition (INTERNAL false), so customers never see the internal definition.
  if (INTERNAL) {
    const si = document.getElementById("setup-info"); if (si) si.hidden = false;
    const ao = document.getElementById("about-owner"); if (ao) ao.hidden = false;
  }
  // Owner-only setup-fee waiver control. Internal edition only; re-quote when it changes.
  if (INTERNAL && els.setupWaiveField) {
    els.setupWaiveField.hidden = false;
    if (els.setupWaive) els.setupWaive.addEventListener("change", () => { if (!els.result.hidden) getQuote(); });
  }
  // Owner-only parts-per-sheet override. Internal edition only; re-quote when it changes.
  if (INTERNAL && els.ppsField) {
    els.ppsField.hidden = false;
    if (els.ppsOverride) els.ppsOverride.addEventListener("input", () => { if (!els.result.hidden) getQuote(); });
  }

  try {
    const mats = await fetchJSON("data/materials.json");
    MATERIALS = mats.materials || [];
    LAYOUT = mats.layout || defaultLayout();
    if (!CONFIG.BACKEND_URL) DEMO = await fetchJSON("data/demo-prices.json");
  } catch (e) {
    showError("Couldn't load material data. Check data/materials.json.");
    els.quoteBtn.disabled = true;
    return;
  }

  const sheet = LAYOUT.sheet;
  if (els.sheetDim) els.sheetDim.textContent = `${trim(sheet.widthIn)}″ × ${trim(sheet.heightIn)}″`;
  if (els.shippingNote) els.shippingNote.textContent = LAYOUT.shippingNote || "";
  if (els.leadNote) els.leadNote.textContent = LAYOUT.leadTimeNote || "";
  if (els.pricingNote) els.pricingNote.textContent = pricingEstimateNote();
  setupExpiry();

  // Label each material with its stock status so customers see lead-time up front. Price-on-request
  // metals stay listed (we still cut them) but say so instead of claiming a lead time.
  MATERIALS.forEach((m) =>
    els.material.add(new Option(
      `${m.name} · ${quoteOnRequestFor(m.id) ? "Price on request" : fullSheetMinFor(m.id) ? "Custom order" : "In stock"}`,
      m.id)));
  fillThickness();
  labelSheetPrefs();
  els.material.addEventListener("change", fillThickness);

  // file input
  els.browse.addEventListener("click", () => els.file.click());
  els.drop.addEventListener("click", (e) => { if (e.target === els.browse) return; els.file.click(); });
  els.file.addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });

  ["dragover", "dragenter"].forEach((ev) =>
    els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove("drag"); }));
  els.drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

  // recompute readiness / preview when inputs change
  [els.width, els.height, els.qty, els.material, els.thickness].forEach((el) =>
    el.addEventListener("input", onInputs));
  els.nest.addEventListener("change", () => { onInputs(); if (!els.result.hidden) drawPreview(); });
  // Sheet preference changes the chosen sheet/price — re-quote if a quote is on screen.
  if (els.sheetPref) els.sheetPref.addEventListener("change", () => { if (!els.result.hidden) getQuote(); });
  // Leftover choice doesn't change price — just re-render the shown quote so the note + PDF update.
  if (els.shipLeftover) els.shipLeftover.addEventListener("change", () => { if (!els.result.hidden && lastQuote) renderQuote(lastQuote.q, lastQuote.p); });
  // Engrave-interior changes the cut length → the price. Re-quote when a quote is on screen.
  if (els.engraveToggle) els.engraveToggle.addEventListener("change", () => { if (!els.result.hidden) getQuote(); });

  els.quoteBtn.addEventListener("click", getQuote);
  wireQBExport();
  if (els.savePdf) els.savePdf.addEventListener("click", saveQuotePDF);
  if (els.saveJpg) els.saveJpg.addEventListener("click", saveQuoteJPG);
  wireAbout();
  wireInventory();
  wirePWA();
  onInputs();
  // Owner-only supplier-price watch. Fire-and-forget: it must never delay or break the tool.
  checkPriceDrift().catch(() => {});
}

// Customer PWA only: register the app-shell service worker and wire the "Install app" button.
function wirePWA() {
  if (EDITION !== "customer") return;
  if ("serviceWorker" in navigator) {
    const reg = () => navigator.serviceWorker.register("sw.js").catch(() => {});
    if (document.readyState === "complete") reg();
    else window.addEventListener("load", reg);
  }
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    if (els.installBtn) els.installBtn.hidden = false;
  });
  if (els.installBtn) {
    els.installBtn.addEventListener("click", async () => {
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch {}
      deferred = null;
      els.installBtn.hidden = true;
    });
  }
  window.addEventListener("appinstalled", () => { if (els.installBtn) els.installBtn.hidden = true; });
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function defaultLayout() {
  return { sheet: { widthIn: 24, heightIn: 24 }, maxPartIn: 24, marginIn: 0.25,
    gapNestIn: 0.1, gapPlainIn: 0.2, allowRotate: true };
}

// ---- price freshness / expiration ----
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDaysStr(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return "";
  d.setDate(d.getDate() + (Number(days) || 0));
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// HOW PRICE VALIDITY WORKS (reworked 2026-07-23): the window is a CUSTOMER-FACING PROMISE, not a
// gate. Whatever prices are loaded stay quotable indefinitely — they only change when the owner
// changes them (MakerStock ones refresh automatically when the tool is opened). What the customer
// is told is "the material price on THIS quote holds for N days", counted from the DAY THE QUOTE
// IS MADE, so the window is always full and never lapses. Stocked metal gets the longer window
// (default 14 days), custom-order the shorter one (default 7).
function validityDaysFor(isStock) {
  const v = isStock ? (LAYOUT && LAYOUT.stockValidityDays) : (LAYOUT && LAYOUT.customValidityDays);
  return v != null ? v : (isStock ? 14 : 7);
}
function isMakerStockSourced(materialId) {
  const m = MATERIALS.find((x) => x.id === materialId);
  return !!(m && m.makerstockHandle);
}
// "Costs were loaded on <date>" for the customer-facing volatility note. The two anchors record when
// each price source was last repriced (MakerStock stamps itself every time the tool is opened; the
// manual one moves only when a human reprices). Report the OLDEST anchor among materials we actually
// quote — price-on-request metals are excluded, since we're not standing behind a number for them —
// so the date never claims prices are fresher than they are.
const makerstockAnchor = () => (LAYOUT && (LAYOUT.pricesUpdatedMakerstock || LAYOUT.pricesUpdated)) || "";
const manualAnchor = () => (LAYOUT && (LAYOUT.pricesUpdatedManual || LAYOUT.pricesUpdated)) || "";
function pricingLoadedDate() {
  const dates = MATERIALS
    .filter((m) => !quoteOnRequestFor(m.id))
    .map((m) => (isMakerStockSourced(m.id) ? makerstockAnchor() : manualAnchor()))
    .filter(Boolean);
  return dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : makerstockAnchor();
}
// Shown when the Worker priced off a fallback instead of a live MakerStock read. {date} is the day
// the price we actually used was captured.
const DEFAULT_NOT_CURRENT = "Material price not current — price used from {date}.";
const DEFAULT_NOT_CURRENT_QUOTE =
  "Material price not current at time of quote. Material pricing from {date} used.";
function fillDate(tpl, iso) {
  return String(tpl).replace(/\{date\}/g, iso ? fmtDate(iso) : "an earlier date");
}
function notCurrentNote(asOf) {
  return fillDate((LAYOUT && LAYOUT.notCurrentNote) || DEFAULT_NOT_CURRENT, asOf);
}
function notCurrentQuoteNote(asOf) {
  return fillDate((LAYOUT && LAYOUT.notCurrentQuoteNote) || DEFAULT_NOT_CURRENT_QUOTE, asOf);
}

// asOf: the date the price for THE QUOTED MATERIAL actually came from (the Worker's priceAsOf —
// a live MakerStock read for MakerStock metals, the manual anchor for hand-priced ones like 14ga
// stainless). Omitted on the footer, where no material is chosen yet, so that falls back to the
// oldest anchor across everything we quote.
function pricingEstimateNote(asOf) {
  const tpl = (LAYOUT && LAYOUT.pricingEstimateNote) || "";
  if (!tpl) return "";
  const d = asOf || pricingLoadedDate();
  return tpl.replace(/\{date\}/g, d ? fmtDate(d) : "the date shown on your quote");
}
// Rolling from today — a quote made now is good for its material's full window.
function validUntilForStockFlag(isStock) {
  return addDaysStr(todayStr(), validityDaysFor(isStock));
}
function validUntilForMaterial(materialId) {
  return validUntilForStockFlag(!fullSheetMinFor(materialId)); // fullSheetMin=false => stocked
}
function fmtDate(s) {
  const d = new Date(s + "T00:00:00");
  return isNaN(d) ? s : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Footer note: how long a quote made TODAY holds its material price. Nothing ever expires, so the
// old "pricing is being refreshed" banner is gone — it stays hidden.
function setupExpiry() {
  if (els.expiryBanner) els.expiryBanner.hidden = true;
  if (!els.validityNote) return;
  els.validityNote.textContent =
    `Material pricing on a quote is held for ${validityDaysFor(true)} days on stocked metal ` +
    `(through ${fmtDate(validUntilForStockFlag(true))}) and ${validityDaysFor(false)} days on ` +
    `custom-order metal (through ${fmtDate(validUntilForStockFlag(false))}).`;
}

function fillThickness() {
  const m = MATERIALS.find((x) => x.id === els.material.value) || MATERIALS[0];
  els.thickness.innerHTML = "";
  (m ? m.thicknesses : []).forEach((t) => els.thickness.add(new Option(t.label, String(t.in))));
  // The "ship the leftover" toggle only makes sense for custom-order materials, which are cut
  // from a full sheet the customer is billed for. Stock is area-priced, so there's no leftover sheet.
  if (els.leftoverField) els.leftoverField.hidden = !fullSheetMinFor(els.material.value);
  updateRequestOnly();
  updateStockReadout();
}

// Price-on-request material chosen: swap the quote button for the contact message.
function updateRequestOnly() {
  const onRequest = quoteOnRequestFor(els.material.value);
  if (els.requestNote) {
    els.requestNote.hidden = !onRequest;
    els.requestNote.textContent = onRequest ? requestOnlyMsg() : "";
  }
  if (els.quoteBtn) {
    els.quoteBtn.disabled = onRequest;
    els.quoteBtn.textContent = onRequest ? "Price on request" : "Get Quote";
  }
  if (onRequest) { els.result.hidden = true; els.resultEmpty.hidden = false; }
}

// Internal-only: show sheets on hand for the chosen material + thickness, broken out by sheet size,
// as text under the material/thickness fields — a quick "do we have it?" before quoting.
function updateStockReadout() {
  if (!els.stockReadout) return;
  if (!INTERNAL || !els.material.value || els.thickness.value === "") { els.stockReadout.hidden = true; return; }
  const inv = loadInventory();
  const lines = layoutSheets()
    .map((sh) => ({ sh, qty: getStock(inv, els.material.value, els.thickness.value, sh.id) }))
    .filter((x) => x.qty !== 0);
  els.stockReadout.hidden = false;
  if (!lines.length) {
    els.stockReadout.innerHTML = `In stock: <span class="out">none on hand</span>`;
    return;
  }
  const bits = lines.map((x) =>
    `<span class="${x.qty > 0 ? "in" : "out"}">${x.qty} × ${trim(x.sh.widthIn)}×${trim(x.sh.heightIn)}″</span>`);
  els.stockReadout.innerHTML = `In stock: ${bits.join(" · ")}`;
}

function onInputs() {
  state.widthIn = parseFloat(els.width.value) || 0;
  state.heightIn = parseFloat(els.height.value) || 0;
  const ready = state.widthIn > 0 && state.heightIn > 0 && (parseInt(els.qty.value, 10) || 0) >= 1;
  // A price-on-request material stays unquotable no matter how complete the rest of the form is.
  els.quoteBtn.disabled = !ready || quoteOnRequestFor(els.material.value);
  // A hand-typed size that no longer matches the loaded file drops the file geometry (currentParts
  // falls back to a plain rectangle), so the interior split no longer applies — retract the toggle.
  if (els.engraveField && !els.engraveField.hidden && state.fileBBox) {
    const near = (a, b) => Math.abs(a - b) <= 0.02;
    if (!(near(state.widthIn, state.fileBBox.w) && near(state.heightIn, state.fileBBox.h))) {
      els.engraveField.hidden = true;
      if (els.engraveToggle) els.engraveToggle.checked = false;
    }
  }
  updateStockReadout();
}

// Offer the engrave-interior toggle only for single-part files that carry real interior geometry
// (≥0.5″ of interior cut) to exclude. Hidden + reset for manual sizes and multi-part files.
function updateEngraveField(dims) {
  if (!els.engraveField) return;
  const singlePart = !(dims && dims.parts && dims.parts.length > 1);
  const hasInterior = (dims && dims.interiorCutLengthIn || 0) > 0.5;
  const show = singlePart && hasInterior;
  els.engraveField.hidden = !show;
  if (!show && els.engraveToggle) els.engraveToggle.checked = false;
}

// ---- File handling ----
let lastLoadedFile = null; // remembered so a unit change can re-import
async function handleFile(file) {
  hideError();
  lastLoadedFile = file;
  const ext = file.name.split(".").pop().toLowerCase();
  showFileStatus(`Reading ${file.name}…`, false);
  try {
    let dims;
    if (ext === "dxf") {
      dims = parseDXF(await file.text());
    } else if (ext === "svg") {
      dims = await parseSVG(await file.text());
    } else {
      // Laser cutting is 2D — only the flat vector formats that carry the real cut paths (outline
      // + holes) are accepted. STEP was dropped: it gives no interior cut length, so it underpriced.
      throw new Error("Unsupported file. Use a DXF or SVG (the flat cut file). No file? Type the size by hand.");
    }
    if (!dims || !(dims.widthIn > 0) || !(dims.heightIn > 0))
      throw new Error("Couldn't measure that file. Enter the size by hand.");

    applyDims(dims);
    showFileStatus(
      `${file.name} · ${fmtIn(dims.widthIn)} × ${fmtIn(dims.heightIn)} in` +
      (dims.detectedUnit ? ` · units: ${dims.detectedUnit}` : ""), false);
  } catch (e) {
    showFileStatus(e.message || "Couldn't read that file.", true);
  }
}

function applyDims(dims) {
  // The size fields are always shown in inches; parsers convert to inches themselves.
  els.width.value = round3(dims.widthIn);
  els.height.value = round3(dims.heightIn);
  state.cutLengthIn = dims.cutLengthIn || 0;
  state.outerCutLengthIn = dims.outerCutLengthIn || 0;
  state.interiorCutLengthIn = dims.interiorCutLengthIn || 0;
  state.shape = dims.shape || null;
  state.shapeOuter = dims.shapeOuter || dims.shape || null;
  // Keep the panel list only when the file actually has more than one part to nest.
  state.fileParts = dims.parts && dims.parts.length > 1 ? dims.parts : null;
  state.fileBBox = { w: dims.widthIn, h: dims.heightIn };
  // Offer the engrave-interior toggle only for SINGLE-part files that actually have interior
  // geometry to exclude (≥0.5″ of interior cut). Reset it whenever a new file is loaded.
  updateEngraveField(dims);
  lastLoadedFile = null; // typed edits from here on
  onInputs();
}

// ---- Quote ----
async function getQuote() {
  hideError();
  if (quoteOnRequestFor(els.material.value)) { updateRequestOnly(); return; }
  els.quoteBtn.disabled = true;
  els.quoteBtn.textContent = "Pricing…";
  const payload = {
    material: els.material.value,
    thickness: els.thickness.value,
    widthIn: state.widthIn,
    heightIn: state.heightIn,
    qty: parseInt(els.qty.value, 10) || 1,
    nest: els.nest.checked,
    cutLengthIn: activeCutLengthIn() || estimateCut(state.widthIn, state.heightIn), // outer-only when engraving interior
    parts: currentParts().map((pt) => ({ w: pt.w, h: pt.h })), // panels to nest (shape stripped — server needs only w,h)
    sheetPref: els.sheetPref ? els.sheetPref.value : "auto", // auto | small | large
    setupWaive: setupWaiveMode(), // owner-only: none | after2 | all (local edition; Worker ignores it)
    owner: OWNER, // owner view asks the Worker for the inbound-freight estimate
  };
  try {
    const quote = CONFIG.BACKEND_URL ? await quoteRemote(payload) : quoteLocal(payload);
    if (quote.error) throw new Error(quote.error);
    renderQuote(quote, payload);
  } catch (e) {
    showError(e.message || "Something went wrong getting your quote.");
  } finally {
    els.quoteBtn.disabled = false;
    els.quoteBtn.textContent = "Get Quote";
    updateRequestOnly();
    onInputs();
  }
}

async function quoteRemote(payload) {
  const res = await fetch(CONFIG.BACKEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Server error (${res.status}).`);
  return data;
}

// Demo pricing — MUST match backend/worker.js math.
function quoteLocal(p) {
  if (quoteOnRequestFor(p.material)) return { error: requestOnlyMsg() };
  const knobs = DEMO.settings;
  const maxThk = maxThicknessMm(knobs);
  if ((Number(p.thickness) || 0) * 25.4 > maxThk + 1e-6)
    return { error: `We can't cut material thicker than ${maxThk} mm. Please choose a thinner thickness.` };

  const fullSheetMin = fullSheetMinFor(p.material);
  // A multi-part file nests its panels; a single/typed part keeps the original grid path so
  // existing single-part quotes are unchanged. MUST match worker.js.
  const parts = p.parts && p.parts.length ? p.parts : [{ w: p.widthIn, h: p.heightIn }];
  const multi = parts.length > 1;
  const gap = p.nest ? LAYOUT.gapNestIn : LAYOUT.gapPlainIn;

  let sheet, price, sheetsNeeded, perSheet = null;
  if (multi) {
    const chosen = chooseSheetMulti(p, parts, fullSheetMin);
    if (chosen.error) return { error: chosen.error };
    sheet = chosen.sheet; price = chosen.price; sheetsNeeded = chosen.sheetsNeeded;
  } else {
    const chosen = chooseSheetDemo(p, fullSheetMin);
    if (chosen.error) return { error: chosen.error };
    sheet = chosen.sheet; price = chosen.price;
    perSheet = partsPerSheet(p, sheet);
    if (perSheet < 1) return { error: "Part doesn't fit on the chosen sheet with the tool-holder offset." };
    sheetsNeeded = Math.ceil(p.qty / perSheet);
  }

  // Stock materials are area-based on the stocked sheet; custom-order materials pay whole sheets.
  // Inbound freight is SOURCE-AWARE (MakerStock flat per shipment / Online Metals weight-based) —
  // see customOrderFreight / stockFreightPerSheet. MUST match worker.js.
  let materialCost, inboundFreight, materialAreaSqIn = null, stockBilledSheets = 0, stockFullSheetBilled = false;
  if (fullSheetMin) {
    inboundFreight = customOrderFreight(p.material, sheet, p.thickness, sheetsNeeded, knobs);
    materialCost = sheetsNeeded * price + inboundFreight;
  } else {
    const freightPerSheet = stockFreightPerSheet(p.material, sheet, p.thickness, knobs);
    const landed = price + freightPerSheet;
    const sheetA = sheetAreaOf(sheet);
    // Area billed = the blank each panel occupies (+ spacing), summed over panels × qty.
    const blankPerSet = parts.reduce((s, pt) => s + (pt.w + gap) * (pt.h + gap), 0);
    materialAreaSqIn = blankPerSet * p.qty;
    // 90% rule: a partial sheet used past the threshold is billed as a WHOLE sheet.
    const thr = knobs.stockFullSheetThreshold != null ? Number(knobs.stockFullSheetThreshold) : DEFAULT_STOCK_FULLSHEET_THRESHOLD;
    const sheetsUsed = sheetA > 0 ? materialAreaSqIn / sheetA : 0;
    stockBilledSheets = (sheetsUsed - Math.floor(sheetsUsed)) > thr ? Math.ceil(sheetsUsed) : sheetsUsed;
    stockFullSheetBilled = stockBilledSheets > sheetsUsed + 1e-9;
    materialCost = stockBilledSheets * landed;
    inboundFreight = stockBilledSheets * freightPerSheet;
  }

  // Setup & handling is charged PER SHEET (each sheet gets loaded, squared up and unloaded once),
  // not per part — 50 small parts nested on one sheet is still one setup.
  // MUST match worker.js computeQuote.
  // Setup fee is PER SHEET and can vary BY SHEET SIZE (a 24×24 takes longer to load/square than a
  // 12×12). setupFeeBySheet[sheet.id] wins; else the flat processPerSheet; else the default.
  // MUST match worker.js computeQuote.
  const bySize = knobs.setupFeeBySheet && knobs.setupFeeBySheet[sheet.id];
  const perSheetFee = bySize != null
    ? Number(bySize)
    : (knobs.processPerSheet != null ? Number(knobs.processPerSheet) : DEFAULT_PROCESS_PER_SHEET);
  // Owner-only waiver: "after2" bills setup on the first 2 sheets only (a quick-swap sheet costs
  // little handling); "all" waives it entirely. Client-side / internal only — the Worker has no
  // such mode, so customer quotes always charge the full per-sheet fee.
  const setupWaive = p.setupWaive || "none";
  const setupSheets = setupWaive === "all" ? 0
    : setupWaive === "after2" ? Math.min(sheetsNeeded, 2)
    : sheetsNeeded;
  const setupFull = sheetsNeeded * perSheetFee;      // what setup would be with no waiver
  const setupFee = setupSheets * perSheetFee;         // what we actually bill
  const setupWaived = setupFull - setupFee;           // amount waived (0 when nothing was waived)
  const processing = setupFee + (p.cutLengthIn || 0) * p.qty * (knobs.cutRatePerIn || 0);
  const cutMinutes = machineMinutes(p.cutLengthIn, p.thickness, p.qty, knobs);
  // Baked-in per-JOB startup (machine boot + sending the file), billed once per order at the
  // machine rate. It consumes no assist gas, so it's added to machine time only — NOT the gas
  // surcharge, which stays on cutting minutes. Skipped when there's nothing to cut. `!= null` so a
  // deliberate 0 disables it (Number(0)||DEFAULT would wrongly re-add the default). MUST match worker.js.
  const startupMin = cutMinutes > 0
    ? (knobs.machineStartupMin != null ? Number(knobs.machineStartupMin) : DEFAULT_MACHINE_STARTUP_MIN)
    : 0;
  const minutes = cutMinutes + startupMin;
  const machineCost = minutes * (Number(knobs.machineRatePerMin) || DEFAULT_MACHINE_RATE);
  const gasSurcharge = gasSurchargeCost(p.thickness, cutMinutes, knobs, assistGasFor(p.material));
  // MARKUP APPLIES TO MATERIAL ONLY — machine time, gas and setup already bill at the rates you
  // set (machineRatePerMin, shieldingGasPerMin, processPerSheet), so they are NOT marked up again.
  // MUST match worker.js computeQuote.
  let total = materialCost * DEMO.markup + processing + machineCost + gasSurcharge;
  const belowMin = total < knobs.minCharge;
  total = Math.max(total, knobs.minCharge);
  // When a job lands under minCharge the top-up gets its OWN line: setup used to be the plug,
  // so a small order read as a huge setup fee. Whichever line is the plug also absorbs rounding
  // drift, so the lines always sum to total. MUST match worker.js computeQuote.
  const markedMaterial = round2(materialCost * DEMO.markup);
  const markedMachine = round2(machineCost);
  const markedGas = round2(gasSurcharge);
  const markedProcessing = belowMin
    ? round2(processing)
    : round2(total - markedMaterial - markedMachine - markedGas);
  const markedMinTopUp = belowMin
    ? round2(total - markedMaterial - markedMachine - markedGas - markedProcessing)
    : 0;
  // Internal-only raw cost + margin (never shown to customers; also owner-gated in worker.js).
  const totalCost = materialCost + processing + machineCost + gasSurcharge;
  const cost = {
    material: round2(materialCost - inboundFreight), freight: round2(inboundFreight),
    machine: round2(machineCost), gas: round2(gasSurcharge), processing: round2(processing),
    totalCost: round2(totalCost), markup: DEMO.markup, price: round2(total),
    margin: round2(total - totalCost), marginPct: total > 0 ? Math.round((total - totalCost) / total * 100) : 0,
  };
  return {
    total: round2(total), perPart: round2(total / p.qty), qty: p.qty,
    sheetsNeeded, partsPerSheet: perSheet, panels: parts.length, nest: p.nest, minChargeApplied: belowMin,
    machineMinutes: round2(minutes),
    // Mirrors the Worker's fields so the internal quote dates its note the same way. Demo mode
    // prices from the local files, which the refresh stamps — so it's current by definition.
    priceCurrent: true,
    priceAsOf: isMakerStockSourced(p.material) ? makerstockAnchor() : manualAnchor(),
    // Internal-only fabrication detail (see showQuote): total distance the laser travels + the
    // cut-speed band picked for this thickness. Not returned by the Worker → customers never see it.
    cutTotalIn: round2((p.cutLengthIn || 0) * p.qty),
    cutSpeedMmS: speedForThicknessMm((Number(p.thickness) || 0) * 25.4, knobs.cutSpeeds),
    materialAreaSqIn: materialAreaSqIn != null ? round2(materialAreaSqIn) : null,
    sheetId: sheet.id, sheetW: sheet.widthIn, sheetH: sheet.heightIn, fullSheetMin, stockFullSheetBilled,
    // Owner-only setup-fee waiver (see setupWaiveMode): the mode, sheets actually billed for setup,
    // the un-waived setup total, and the dollars waived — drives the "waived" line on the outputs.
    setupWaive, setupSheetsBilled: setupSheets, setupFull: round2(setupFull), setupWaived: round2(setupWaived),
    inboundFreight: round2(inboundFreight), cost,
    breakdown: {
      material: markedMaterial,
      machine: Math.max(0, markedMachine),
      gas: Math.max(0, markedGas),
      processing: Math.max(0, markedProcessing),
      minTopUp: Math.max(0, markedMinTopUp),
    },
  };
}

// Cut-speed by thickness — MUST match backend/worker.js.
const DEFAULT_CUT_SPEEDS = [
  { uptoThkMm: 1, speedMmS: 50 },
  { uptoThkMm: 4, speedMmS: 15 },
  { uptoThkMm: 10, speedMmS: 5 },
];
const DEFAULT_MACHINE_RATE = 1.5;
const DEFAULT_MACHINE_STARTUP_MIN = 10; // per-job machine boot + file send; 0 disables it
const DEFAULT_PROCESS_PER_SHEET = 5; // setup/handling $ per SHEET, if settings.processPerSheet is unset
// Even on STOCK material, if a single order uses more than this fraction of a sheet, the whole
// sheet is billed (the remaining offcut is too small to resell). MUST match worker.js.
const DEFAULT_STOCK_FULLSHEET_THRESHOLD = 0.9;

function speedForThicknessMm(thkMm, cutSpeeds) {
  const bands = (cutSpeeds && cutSpeeds.length ? cutSpeeds : DEFAULT_CUT_SPEEDS)
    .slice().sort((a, b) => a.uptoThkMm - b.uptoThkMm);
  for (const b of bands) if (thkMm <= b.uptoThkMm) return b.speedMmS;
  return bands[bands.length - 1].speedMmS;
}

// Largest thickness we can cut = the top cut-speed band's upper bound (mm).
function maxThicknessMm(knobs) {
  const bands = knobs.cutSpeeds && knobs.cutSpeeds.length ? knobs.cutSpeeds : DEFAULT_CUT_SPEEDS;
  return Math.max(...bands.map((b) => Number(b.uptoThkMm) || 0));
}

function machineMinutes(cutLengthIn, thicknessIn, qty, knobs) {
  const cutLenMm = (cutLengthIn || 0) * 25.4;
  if (cutLenMm <= 0) return 0;
  const thkMm = (Number(thicknessIn) || 0) * 25.4;
  const speed = speedForThicknessMm(thkMm, knobs.cutSpeeds);
  return ((cutLenMm / speed) * qty) / 60;
}

// Gas surcharge — MUST match backend/worker.js.
const DEFAULT_GAS_THICKNESS_IN = 0.2;
const DEFAULT_SHIELDING_GAS_PER_MIN = 0.5;
const DEFAULT_GAS_MULTIPLIER = 2;
function gasSurchargeCost(thicknessIn, minutes, knobs, gasInfo) {
  const gas = String((gasInfo && gasInfo.gas) || "air").toLowerCase();
  if (gas !== "nitrogen" && gas !== "oxygen") return 0; // compressed air / unknown => free
  const airMax = gasInfo && gasInfo.airMaxIn != null
    ? gasInfo.airMaxIn
    : (knobs.gasSurchargeThicknessIn != null ? knobs.gasSurchargeThicknessIn : DEFAULT_GAS_THICKNESS_IN);
  if ((Number(thicknessIn) || 0) <= airMax) return 0; // cut with compressed air
  const gasPerMin = knobs.shieldingGasPerMin != null ? Number(knobs.shieldingGasPerMin) : DEFAULT_SHIELDING_GAS_PER_MIN;
  const mult = Number(knobs.gasSurchargeMultiplier) || DEFAULT_GAS_MULTIPLIER;
  return (minutes || 0) * gasPerMin * mult;
}

// Gas config { gas, airMaxIn } for a material, from the loaded catalog. Air/unknown => free.
function assistGasFor(materialId) {
  const m = MATERIALS.find((x) => x.id === materialId);
  if (!m) return { gas: "air", airMaxIn: null };
  return { gas: String(m.assistGas || "air").toLowerCase(), airMaxIn: m.airMaxThicknessIn != null ? Number(m.airMaxThicknessIn) : null };
}

// ---- sheets & fit (mirror backend/worker.js) ----
function layoutSheets() {
  if (LAYOUT.sheets && LAYOUT.sheets.length) return LAYOUT.sheets;
  const s = LAYOUT.sheet || { widthIn: 24, heightIn: 24 };
  return [{ id: "24x24", widthIn: s.widthIn, heightIn: s.heightIn }];
}
function holderOffset() {
  return LAYOUT.holderOffsetIn != null ? LAYOUT.holderOffsetIn : (LAYOUT.marginIn != null ? LAYOUT.marginIn : 0.25);
}
// Reserved strip on the TOP and BOTTOM (Y) sheet ends to keep the sheet rigid during the cut.
// Separate from the X-end holder offset; 0 or unset = none. MUST match worker.js edgeReserveOf().
function edgeReserve() {
  return LAYOUT.edgeReserveIn != null ? Number(LAYOUT.edgeReserveIn) : 0;
}
function sheetAreaOf(s) { return s.widthIn * s.heightIn; }

// Label the sheet-preference options with the ACTUAL sheet sizes (smallest / largest by area),
// so "prefer smaller" reads "Prefer 12×12" and "fewest" reads "Fewest sheets (24×24)".
function labelSheetPrefs() {
  if (!els.sheetPref) return;
  const sheets = layoutSheets();
  if (sheets.length < 2) return;
  const byArea = sheets.slice().sort((a, b) => sheetAreaOf(a) - sheetAreaOf(b));
  const dim = (s) => `${trim(s.widthIn)}×${trim(s.heightIn)}`;
  const opt = (v) => [...els.sheetPref.options].find((o) => o.value === v);
  const small = opt("small"), large = opt("large");
  if (small) small.textContent = `Prefer ${dim(byArea[0])}`;
  if (large) large.textContent = `Fewest sheets (${dim(byArea[byArea.length - 1])})`;
}
function usable(s) { return { w: s.widthIn - 2 * holderOffset(), h: s.heightIn - 2 * edgeReserve() }; }
// Square-on (0°/90°) OR cornerwise: a long narrow part can clear a smaller sheet on the diagonal.
// MUST match worker.js partFits.
function fits(w, h, s) {
  const u = usable(s), e = 1e-9;
  if ((w <= u.w + e && h <= u.h + e) || (h <= u.w + e && w <= u.h + e)) return true;
  return fitsTilted(w, h, u.w, u.h);
}

// OWNER ALERT: the Worker now prices MakerStock materials LIVE and accepts whatever it finds, so a
// big supplier move reaches customers immediately — correct, but the owner needs to know, because
// the LOCAL baseline (demo-prices.json, which drives the internal cost/margin panel) still holds the
// old number until the refresh script is re-run and the Worker redeployed. This checks MakerStock
// straight from the browser (their feed is CORS-open) and flags anything past the swing threshold.
// INTERNAL only — customers never see it and never fetch MakerStock themselves.
async function checkPriceDrift() {
  if (!INTERNAL || !els.driftBanner) return;
  const threshold = Number((DEMO && DEMO.settings && DEMO.settings.priceSwingAlert) ?? 0.4);
  const byHandle = new Map();
  for (const m of MATERIALS) {
    if (!m.makerstockHandle || quoteOnRequestFor(m.id)) continue;
    if (!byHandle.has(m.makerstockHandle)) byHandle.set(m.makerstockHandle, []);
    byHandle.get(m.makerstockHandle).push(m);
  }
  const moved = [];
  await Promise.all([...byHandle.entries()].map(async ([handle, mats]) => {
    let variants;
    try {
      const r = await fetch(`https://makerstock.com/products/${handle}.json`, { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      variants = {};
      for (const v of (j.product && j.product.variants) || []) if (v && v.sku) variants[String(v.sku).trim()] = Number(v.price);
    } catch { return; } // offline / blocked — silent, this is a convenience check
    for (const m of mats) {
      for (const t of m.thicknesses || []) {
        for (const [skuKey, sizeId] of [["makerstockSku", "24x24"], ["makerstockSku12", "12x12"]]) {
          const sku = t[skuKey];
          const live = sku ? variants[String(sku).trim()] : null;
          const base = demoPriceSize(m.id, String(t.in), sizeId);
          if (!(live > 0) || !(base > 0)) continue;
          if (Math.abs(live - base) / base > threshold) {
            moved.push(`${m.name} ${t.label} ${sizeId}: ${money(base)} → ${money(live)} (${Math.round((live - base) / base * 100)}%)`);
          }
        }
      }
    }
  }));
  if (!moved.length) { els.driftBanner.hidden = true; return; }
  els.driftBanner.hidden = false;
  els.driftBanner.innerHTML =
    `<strong>MakerStock prices moved sharply.</strong> Customers are already being quoted the new ` +
    `numbers (the Worker prices live), but your local baseline and margin panel still show the old ` +
    `ones. Re-run <code>node scripts/refresh-makerstock.mjs --write --force</code>, then redeploy.` +
    `<ul>${moved.map((s) => `<li>${s}</li>`).join("")}</ul>`;
}

// PRICE ON REQUEST — a metal whose cost is moving too fast to hold a number (brass, copper as of
// 2026-07-23). It stays in the dropdown, but the tool refuses to quote it and shows the contact
// message instead. The Worker enforces the same thing, so a stale price can't leak out either way.
function quoteOnRequestFor(materialId) {
  const m = MATERIALS.find((x) => x.id === materialId);
  if (m && m.quoteOnRequest != null) return !!m.quoteOnRequest;
  const dm = DEMO && DEMO.quoteOnRequest;
  return !!(dm && dm[materialId] === true);
}
function requestOnlyMsg() {
  return (LAYOUT && LAYOUT.requestOnlyMessage) || (DEMO && DEMO.requestOnlyMessage) || DEFAULT_REQUEST_ONLY_MSG;
}

function fullSheetMinFor(materialId) {
  const m = MATERIALS.find((x) => x.id === materialId);
  if (m && m.fullSheetMin != null) return !!m.fullSheetMin;
  const dm = DEMO && DEMO.fullSheetMin;
  return dm && dm[materialId] === false ? false : true; // default: custom-order
}

function densityForMat(materialId) {
  const m = MATERIALS.find((x) => x.id === materialId);
  return Number(m && m.densityLbIn3) || 0; // lb/in³
}
function sheetWeightLb(sheet, materialId, thicknessIn) {
  return sheet.widthIn * sheet.heightIn * (Number(thicknessIn) || 0) * densityForMat(materialId);
}
// Inbound freight is SOURCE-AWARE (MUST match worker.js):
//  • MakerStock ships flat — makerstockShipFlat ($) per shipment up to makerstockShipMaxLb (lb).
//      custom order = one real shipment → stepped ceil(orderWeight / maxLb) × flat.
//      stock (stainless, bought in bulk) → amortized linear rate flat/maxLb ($/lb) per sheet.
//  • Online Metals (brass, copper, 14ga SS) stays weight-based: freightBase once + freightPerLb/lb.
function customOrderFreight(materialId, sheet, thicknessIn, sheetsNeeded, knobs) {
  const orderWeight = sheetWeightLb(sheet, materialId, thicknessIn) * sheetsNeeded;
  if (isMakerStockSourced(materialId)) {
    const flat = Number(knobs.makerstockShipFlat) || 12;
    const maxLb = Number(knobs.makerstockShipMaxLb) || 50;
    return Math.max(1, Math.ceil(orderWeight / maxLb)) * flat;
  }
  return (Number(knobs.freightBase) || 0) + (Number(knobs.freightPerLb) || 0) * orderWeight;
}
function stockFreightPerSheet(materialId, sheet, thicknessIn, knobs) {
  const wt = sheetWeightLb(sheet, materialId, thicknessIn);
  if (isMakerStockSourced(materialId)) {
    const flat = Number(knobs.makerstockShipFlat) || 12;
    const maxLb = Number(knobs.makerstockShipMaxLb) || 50;
    return (flat / (maxLb || 50)) * wt;
  }
  return (Number(knobs.freightBase) || 0) + (Number(knobs.freightPerLb) || 0) * wt;
}

// Demo price for material+thickness+size. 24x24 from DEMO.prices, 12x12 from DEMO.prices12.
function demoPriceSize(material, thickness, sizeId) {
  const map = sizeId === "12x12" ? (DEMO && DEMO.prices12) : (DEMO && DEMO.prices);
  const m = (map && map[material]) || {};
  if (m[thickness] != null) return Number(m[thickness]) || null;
  const want = Number(thickness);
  for (const [k, v] of Object.entries(m)) if (Math.abs(Number(k) - want) < 1e-6) return Number(v) || null;
  return null;
}

// Pick {sheet, price} for a part in demo mode. Returns {error} if nothing fits or is priced.
function chooseSheetDemo(p, fullSheetMin) {
  const sheets = layoutSheets();
  const fitting = sheets.filter((s) => fits(p.widthIn, p.heightIn, s));
  if (!fitting.length) {
    const big = sheets.reduce((a, b) => (sheetAreaOf(a) >= sheetAreaOf(b) ? a : b));
    const u = usable(big);
    return { error: `This part is larger than our biggest sheet (usable ${trim(u.w)}×${trim(u.h)}″). Split it or contact us.` };
  }
  const priced = fitting.map((s) => ({ sheet: s, price: demoPriceSize(p.material, p.thickness, s.id) })).filter((x) => x.price != null);
  if (!priced.length) return { error: "No demo price for that material/thickness/size." };
  if (!fullSheetMin) {
    const stock = priced.find((x) => x.sheet.id === (LAYOUT.stockSheetId || "24x24"));
    return stock || priced.sort((a, b) => sheetAreaOf(b.sheet) - sheetAreaOf(a.sheet))[0];
  }
  // Custom order: pick the size with the lowest total cost (per-sheet price + weight freight; base
  // is constant across sizes so it doesn't affect the choice).
  const knobs = DEMO.settings || {};
  const withCost = priced
    .map((x) => {
      const per = partsPerSheet(p, x.sheet);
      const sn = Math.ceil(p.qty / per);
      const cost = per >= 1 ? sn * x.price + customOrderFreight(p.material, x.sheet, p.thickness, sn, knobs) : Infinity;
      return { ...x, per, cost };
    })
    .filter((x) => x.per >= 1);
  if (!withCost.length) return { error: "Part doesn't fit on the chosen sheet with the tool-holder offset." };
  const pref = p.sheetPref || "auto";
  if (pref === "small") withCost.sort((a, b) => sheetAreaOf(a.sheet) - sheetAreaOf(b.sheet) || a.cost - b.cost);
  else if (pref === "large") withCost.sort((a, b) => sheetAreaOf(b.sheet) - sheetAreaOf(a.sheet) || a.cost - b.cost);
  else withCost.sort((a, b) => a.cost - b.cost || sheetAreaOf(a.sheet) - sheetAreaOf(b.sheet));
  return withCost[0];
}

// Multi-part: nest the panels to pick {sheet, price, sheetsNeeded}. Honors sheetPref
// (auto = cheapest, small = smallest size, large = biggest size). MUST match worker.js.
function chooseSheetMulti(p, parts, fullSheetMin) {
  const gap = p.nest ? LAYOUT.gapNestIn : LAYOUT.gapPlainIn;
  const rotate = p.nest && LAYOUT.allowRotate;
  const sheets = layoutSheets();
  // A sheet is usable only if EVERY panel fits its usable area.
  const fitsAll = (s) => { const u = usable(s); return parts.every((pt) => partFitsUsable(pt.w, pt.h, u.w, u.h, rotate)); };
  const fitting = sheets.filter(fitsAll);
  if (!fitting.length) {
    const big = sheets.reduce((a, b) => (sheetAreaOf(a) >= sheetAreaOf(b) ? a : b));
    const u = usable(big);
    return { error: `One of the panels is larger than our biggest sheet (usable ${trim(u.w)}×${trim(u.h)}″). Split it or contact us.` };
  }
  const priced = fitting.map((s) => ({ sheet: s, price: demoPriceSize(p.material, p.thickness, s.id) })).filter((x) => x.price != null);
  if (!priced.length) return { error: "No demo price for that material/thickness/size." };
  const knobs = DEMO.settings || {};
  const packed = priced.map((x) => {
    const u = usable(x.sheet);
    const r = packSheets(parts, p.qty, u.w, u.h, gap, rotate);
    const cost = isFinite(r.sheetsNeeded)
      ? r.sheetsNeeded * x.price + customOrderFreight(p.material, x.sheet, p.thickness, r.sheetsNeeded, knobs)
      : Infinity;
    return { ...x, sheetsNeeded: r.sheetsNeeded, cost };
  }).filter((x) => isFinite(x.sheetsNeeded) && x.sheetsNeeded >= 1);
  if (!packed.length) return { error: "Panels don't fit on the chosen sheet with the tool-holder offset." };

  if (!fullSheetMin) {
    // Stock: bill on the stocked size (area-based); nesting doesn't change stock area.
    const stock = packed.find((x) => x.sheet.id === (LAYOUT.stockSheetId || "24x24"));
    return stock || packed.slice().sort((a, b) => sheetAreaOf(b.sheet) - sheetAreaOf(a.sheet))[0];
  }
  const pref = p.sheetPref || "auto";
  if (pref === "small") packed.sort((a, b) => sheetAreaOf(a.sheet) - sheetAreaOf(b.sheet) || a.cost - b.cost);
  else if (pref === "large") packed.sort((a, b) => sheetAreaOf(b.sheet) - sheetAreaOf(a.sheet) || a.cost - b.cost);
  else packed.sort((a, b) => a.cost - b.cost || sheetAreaOf(a.sheet) - sheetAreaOf(b.sheet));
  return packed[0];
}

// A sheet to draw in the preview (never errors): the size the quote would use, best-effort.
function pickSheetForPreview(material, thickness) {
  const sheets = layoutSheets();
  const fitting = sheets.filter((s) => fits(state.widthIn, state.heightIn, s));
  if (!fitting.length) return sheets.reduce((a, b) => (sheetAreaOf(a) >= sheetAreaOf(b) ? a : b));
  let candidates = fitting;
  if (DEMO) {
    const priced = fitting.filter((s) => demoPriceSize(material, thickness, s.id) != null);
    if (priced.length) candidates = priced;
  }
  if (!fullSheetMinFor(material)) {
    const stock = candidates.find((s) => s.id === (LAYOUT.stockSheetId || "24x24"));
    return stock || candidates.slice().sort((a, b) => sheetAreaOf(b) - sheetAreaOf(a))[0];
  }
  // custom: lowest total whole-sheet cost when we know prices, else smallest that fits
  const qty = parseInt(els.qty.value, 10) || 1;
  const pp = { widthIn: state.widthIn, heightIn: state.heightIn, nest: els.nest.checked, qty };
  if (DEMO && candidates.every((s) => demoPriceSize(material, thickness, s.id) != null)) {
    const knobs = DEMO.settings || {};
    const wc = candidates.map((s) => {
      const per = partsPerSheet(pp, s), price = demoPriceSize(material, thickness, s.id);
      const sn = Math.ceil(qty / per);
      const cost = per >= 1 ? sn * price + customOrderFreight(material, s, thickness, sn, knobs) : Infinity;
      return { s, cost };
    });
    wc.sort((a, b) => a.cost - b.cost || sheetAreaOf(a.s) - sheetAreaOf(b.s));
    return wc[0].s;
  }
  return candidates.slice().sort((a, b) => sheetAreaOf(a) - sheetAreaOf(b))[0];
}

function partsPerSheet(p, sheet) {
  // Owner override wins outright — but only for a part that genuinely fits the sheet, so an
  // override can never conjure a part onto a sheet it can't physically go on.
  const forced = ppsOverride();
  if (forced > 0) return fits(p.widthIn, p.heightIn, sheet) ? forced : 0;
  const u = usable(sheet);
  const gap = p.nest ? LAYOUT.gapNestIn : LAYOUT.gapPlainIn;
  const fit = (w, h) => {
    const aw = u.w, ah = u.h;
    if (w > aw || h > ah) return 0;
    return Math.floor((aw + gap) / (w + gap)) * Math.floor((ah + gap) / (h + gap));
  };
  let best = fit(p.widthIn, p.heightIn);
  if (p.nest && LAYOUT.allowRotate) best = Math.max(best, fit(p.heightIn, p.widthIn));
  // Nothing fits square-on, but the part may still clear the sheet cornerwise. Count exactly 1 —
  // packing SEVERAL tilted parts is a different problem, and 1 is the conservative answer.
  // MUST match worker.js partsPerSheet.
  if (best === 0 && fitsTilted(p.widthIn, p.heightIn, u.w, u.h)) best = 1;
  return best;
}

function estimateCut(w, h) {
  return 2 * (w + h); // fallback perimeter estimate when file has no cut length
}

// ---- Render ----
function renderQuote(q, p) {
  els.resultEmpty.hidden = true;
  els.result.hidden = false;
  lastQuote = { q, p, desc: describeJob(p) };
  if (OWNER && els.qbExport) {
    els.qbExport.hidden = false;
    if (els.qbDocnum && !els.qbDocnum.value) els.qbDocnum.value = suggestDocNum();
    if (els.qbStatus) els.qbStatus.hidden = true;
  }
  els.total.textContent = money(q.total);
  els.perpart.textContent = `${money(q.perPart)} each`;
  els.qtyEcho.textContent = `× ${q.qty}`;
  // The Worker couldn't reach MakerStock and priced from the last figure it did get (or the one
  // bundled at deploy). Say so plainly, with the date — the quote still stands, it's just not live.
  if (els.notCurrentNote) {
    const stale = q.priceCurrent === false;
    els.notCurrentNote.hidden = !stale;
    els.notCurrentNote.textContent = stale ? notCurrentNote(q.priceAsOf) : "";
  }
  els.bdMaterial.textContent = money(q.breakdown.material);
  els.bdMachine.textContent = money(q.breakdown.machine || 0);
  if (els.bdMachineNote) {
    // Customers see the machine-time $ line but NOT the actual minutes — internal view only.
    const mins = q.machineMinutes || 0;
    els.bdMachineNote.textContent = INTERNAL && mins > 0 ? `≈ ${fmtMinutes(mins)}` : "";
  }
  if (els.bdCutRow) {
    // Internal-only: total distance the laser cuts + the speed band applied for this thickness.
    // SAE on top, metric conversion under it — each line keeps ONE length unit (in / mm) and the
    // same time base (per second), so it's a clean unit conversion, not a mixed inch-vs-mm/s line.
    const cutIn = q.cutTotalIn || 0;
    const spdMm = q.cutSpeedMmS || 0;
    const show = INTERNAL && cutIn > 0;
    els.bdCutRow.hidden = !show;
    if (show) {
      els.bdCut.textContent = `${trim(cutIn)}″ @ ${(spdMm / 25.4).toFixed(2)} in/s`;
      if (els.bdCutMetric)
        els.bdCutMetric.textContent = `${Math.round(cutIn * 25.4).toLocaleString()} mm @ ${trim(spdMm)} mm/s`;
    }
  }
  const gas = q.breakdown.gas || 0;
  if (els.bdGasRow) els.bdGasRow.hidden = gas <= 0;
  if (els.bdGas) els.bdGas.textContent = money(gas);
  // Setup & handling — reflect the owner's waiver: "all" reads "Waived", "after2" shows the
  // reduced amount plus how many sheets were billed and the dollars waived. (setupWaive is always
  // "none" for customers, so the note stays blank there.)
  const waivedAmt = Number(q.setupWaived) || 0;
  els.bdProcess.textContent = q.setupWaive === "all" ? "Waived" : money(q.breakdown.processing);
  if (els.bdProcessNote) {
    if (q.setupWaive === "all") els.bdProcessNote.textContent = "· waived";
    else if (q.setupWaive === "after2" && waivedAmt > 0.004)
      els.bdProcessNote.textContent = `· ${q.setupSheetsBilled} of ${q.sheetsNeeded} sheets billed, ${money(waivedAmt)} waived`;
    else els.bdProcessNote.textContent = "";
  }
  // Only shown when the job came in under the minimum — keeps setup reading at its real rate.
  const topUp = Number(q.breakdown.minTopUp) || 0;
  els.bdMinRow.hidden = topUp <= 0.004;
  els.bdMin.textContent = money(topUp);
  els.bdTotal.textContent = money(q.total);
  const sz = q.sheetW && q.sheetH ? `${trim(q.sheetW)}×${trim(q.sheetH)}` : "sheet";
  els.metaFit.textContent = q.panels > 1
    ? `${q.panels} panels nested`
    : `${q.partsPerSheet} per ${sz} sheet${q.nest ? " (nested)" : ""}${ppsOverride() > 0 ? " · manual count" : ""}`;
  els.metaSheets.textContent = q.fullSheetMin
    ? `${q.sheetsNeeded} × ${sz} sheet${q.sheetsNeeded > 1 ? "s" : ""}`
    : (q.materialAreaSqIn != null ? `≈ ${q.materialAreaSqIn} in² material` : "");
  els.minNote.hidden = !q.minChargeApplied;
  // Internal-only cost + margin panel (supersedes the old inline freight line).
  if (els.ownerFreight) els.ownerFreight.hidden = true;
  if (els.costBreakdown) {
    const show = INTERNAL && q.cost;
    els.costBreakdown.hidden = !show;
    if (show) {
      const c = q.cost;
      els.cbMaterial.textContent = money(c.material);
      els.cbFreight.textContent = money(c.freight);
      els.cbMachine.textContent = money(c.machine);
      if (els.cbGasRow) els.cbGasRow.hidden = !(c.gas > 0);
      els.cbGas.textContent = money(c.gas);
      els.cbProcess.textContent = money(c.processing);
      els.cbTotalCost.textContent = money(c.totalCost);
      els.cbMarkup.textContent = `×${Number(c.markup || 1).toFixed(2)}`;
      els.cbPrice.textContent = money(c.price);
      els.cbMargin.textContent = `${money(c.margin)} · ${c.marginPct}%`;
    }
  }
  if (els.sheetNote) {
    if (q.fullSheetMin) {
      const ship = els.shipLeftover && els.shipLeftover.checked;
      els.sheetNote.hidden = false;
      els.sheetNote.textContent = ship
        ? `Custom-order material: a full ${sz}″ sheet is billed and the leftover will ship with your order.`
        : `Custom-order material: a full ${sz}″ sheet is billed. Check "Ship the leftover with my order" above if you'd like the offcut sent with your parts.`;
    } else if (q.stockFullSheetBilled) {
      els.sheetNote.hidden = false;
      els.sheetNote.textContent = `Your parts use most of a ${sz}″ sheet, so a full sheet is billed — the offcut is yours.`;
    } else {
      els.sheetNote.hidden = true;
    }
  }
  // Custom-order materials: offer to stock the material for repeat customers.
  if (els.stockOffer) els.stockOffer.hidden = !q.fullSheetMin;
  // Engrave-interior: flag that the interior was left out of this (cut-only) quote.
  if (els.engraveNote) els.engraveNote.hidden = !engraveInterior();
  renderInventoryDeduct(); // internal-only stock readout + "remove from stock" control
  drawPreview();
}

// ---- Inventory tie-in (internal only) ----
// After a quote, show current on-hand for the exact material + thickness + sheet size this quote
// would consume, and let the owner pull those sheets out of stock before saving the quote.
function renderInventoryDeduct() {
  if (!els.invDeduct) return;
  const show = INTERNAL && lastQuote && lastQuote.q && lastQuote.q.sheetId;
  els.invDeduct.hidden = !show;
  if (!show) return;
  els.invQty.value = lastQuote.q.sheetsNeeded || 0;
  if (els.invStatus) els.invStatus.hidden = true;
  updateOnHand();
}

// Refresh just the on-hand readout for the current quote's material/thickness/size.
function updateOnHand() {
  const q = lastQuote.q, p = lastQuote.p;
  const onHand = getStock(loadInventory(), p.material, p.thickness, q.sheetId);
  const mat = MATERIALS.find((m) => m.id === p.material);
  const size = q.sheetW && q.sheetH ? `${trim(q.sheetW)}×${trim(q.sheetH)}″` : "sheet";
  els.invOnhand.textContent = `On hand: ${onHand} × ${size} · ${mat ? mat.name : p.material} ${trim(Number(p.thickness))}″`;
  els.invOnhand.style.color = onHand <= 0 ? "#ff6b6b" : "";
  return onHand;
}

function wireInventory() {
  if (!(INTERNAL && els.invBtn)) return;
  els.invBtn.addEventListener("click", () => {
    if (!(lastQuote && lastQuote.q && lastQuote.q.sheetId)) return;
    const q = lastQuote.q, p = lastQuote.p;
    const qty = Math.max(0, Math.round(Number(els.invQty.value) || 0));
    if (qty <= 0) { invStatus("Enter how many sheets to remove.", "err"); return; }
    const inv = loadInventory();
    const onHand = getStock(inv, p.material, p.thickness, q.sheetId);
    if (qty > onHand &&
        !confirm(`Only ${onHand} on hand for this material and size. Remove ${qty} anyway? Stock will go negative.`)) return;
    const left = adjustStock(inv, p.material, p.thickness, q.sheetId, -qty);
    saveInventory(inv);
    els.invQty.value = 0;
    updateOnHand();
    updateStockReadout(); // keep the under-the-field readout in sync with the deduction
    invStatus(`Removed ${qty} sheet${qty > 1 ? "s" : ""}. On hand now: ${left}.`, left < 0 ? "err" : "ok");
  });
}

function invStatus(msg, kind) {
  if (!els.invStatus) return;
  els.invStatus.hidden = false;
  els.invStatus.textContent = msg;
  els.invStatus.classList.toggle("err", kind === "err");
  els.invStatus.classList.toggle("ok", kind === "ok");
}

function drawPreview() {
  const parts = currentParts();
  if (parts.length > 1) { drawMultiPreview(parts); return; }
  // Draw the SAME sheet the quote actually billed (honors the sheet-size preference) — re-picking
  // here independently let the preview show 12×12 while the quote billed 24×24. Fall back to a
  // best-effort pick only if there's no quote yet.
  const q = lastQuote && lastQuote.q;
  const sheet = (q && q.sheetW && q.sheetH)
    ? { widthIn: q.sheetW, heightIn: q.sheetH }
    : pickSheetForPreview(els.material.value, els.thickness.value);
  const layout = nestPreview(state.widthIn, state.heightIn, {
    sheetW: sheet.widthIn, sheetH: sheet.heightIn, holderOffset: holderOffset(), edgeReserve: edgeReserve(),
    gapNest: LAYOUT.gapNestIn, gapPlain: LAYOUT.gapPlainIn,
    nest: els.nest.checked, allowRotate: LAYOUT.allowRotate,
  });
  if (els.sheetDim) els.sheetDim.textContent = `${trim(sheet.widthIn)}″ × ${trim(sheet.heightIn)}″`;
  // The layout packs the WHOLE sheet (that's the per-sheet capacity). Only draw as many
  // parts as the customer actually ordered, so Qty 1 shows one part — not a full sheet.
  const qty = parseInt(els.qty.value, 10) || 1;
  const shown = Math.max(1, Math.min(qty, layout.count));
  const view = { ...layout, rects: layout.rects.slice(0, shown) };
  els.nestSvg.innerHTML = layout.count
    ? nestSVG(view, activeShape())
    : `<p class="hint">Part is too big to fit this sheet.</p>`;
  if (els.sheetCap) {
    // A cornerwise (tilted) placement is worth calling out — it's why a long part fits a sheet it
    // overruns square-on, and it's 1 per sheet.
    const tiltNote = layout.tilt ? ` · placed at ${Math.round(layout.tilt)}° to fit` : "";
    // With a manual count the drawing can't show the real nest (the packer only lays out bounding
    // boxes), so say plainly that the quote used the owner's number.
    const forced = ppsOverride();
    if (forced > 0) {
      els.sheetCap.textContent =
        `Quoted at ${forced} per sheet (manual count) · drawing shows the tool's own bounding-box layout${tiltNote}`;
    } else {
      els.sheetCap.textContent = layout.count
        ? (qty >= layout.count
            ? `Showing one full sheet · fits ${layout.count} per ${trim(sheet.widthIn)}×${trim(sheet.heightIn)} sheet${tiltNote}`
            : `Showing your ${qty} part${qty > 1 ? "s" : ""} · up to ${layout.count} fit per sheet${tiltNote}`)
        : "";
    }
  }
}

// Multi-part preview: nest the panels onto the sheet the quote would use and draw the real layout.
function drawMultiPreview(parts) {
  const material = els.material.value, thickness = els.thickness.value;
  const pref = els.sheetPref ? els.sheetPref.value : "auto";
  // Draw the SAME sheet the quote billed (honors the sheet-size preference); fall back only if
  // there's no quote yet. See drawPreview.
  const q = lastQuote && lastQuote.q;
  const sheet = (q && q.sheetW && q.sheetH)
    ? { widthIn: q.sheetW, heightIn: q.sheetH }
    : pickSheetForPreviewMulti(parts, material, thickness, pref);
  const ho = holderOffset(), er = edgeReserve();
  const u = usable(sheet);
  const gap = els.nest.checked ? LAYOUT.gapNestIn : LAYOUT.gapPlainIn;
  const rotate = els.nest.checked && LAYOUT.allowRotate;
  const qty = parseInt(els.qty.value, 10) || 1;
  const r = packSheets(parts, qty, u.w, u.h, gap, rotate);
  if (els.sheetDim) els.sheetDim.textContent = `${trim(sheet.widthIn)}″ × ${trim(sheet.heightIn)}″`;
  if (!isFinite(r.sheetsNeeded) || !r.sheets.length) {
    els.nestSvg.innerHTML = `<p class="hint">A panel is too big to fit this sheet.</p>`;
    if (els.sheetCap) els.sheetCap.textContent = "";
    return;
  }
  els.nestSvg.innerHTML = nestMultiSVG(sheet.widthIn, sheet.heightIn, ho, r.sheets[0], parts, er);
  if (els.sheetCap) {
    const setStr = qty > 1 ? ` × ${qty} sets` : "";
    const more = r.sheetsNeeded > 1 ? ` (showing sheet 1 of ${r.sheetsNeeded})` : "";
    els.sheetCap.textContent =
      `${parts.length} panels${setStr} · ${r.sheetsNeeded} × ${trim(sheet.widthIn)}×${trim(sheet.heightIn)} sheet${r.sheetsNeeded > 1 ? "s" : ""}${more}`;
  }
}

// Preview sheet for a multi-part file: smallest that fits every panel (largest for the "large"
// preference). Prefers priced sizes when we know them.
function pickSheetForPreviewMulti(parts, material, thickness, pref) {
  const sheets = layoutSheets();
  const rotate = els.nest.checked && LAYOUT.allowRotate;
  const fitAll = (s) => { const u = usable(s); return parts.every((pt) => partFitsUsable(pt.w, pt.h, u.w, u.h, rotate)); };
  let cands = sheets.filter(fitAll);
  if (!cands.length) return sheets.reduce((a, b) => (sheetAreaOf(a) >= sheetAreaOf(b) ? a : b));
  if (DEMO) {
    const priced = cands.filter((s) => demoPriceSize(material, thickness, s.id) != null);
    if (priced.length) cands = priced;
  }
  return cands.slice().sort((a, b) =>
    pref === "large" ? sheetAreaOf(b) - sheetAreaOf(a) : sheetAreaOf(a) - sheetAreaOf(b))[0];
}

// ---- QuickBooks (.IIF) export — owner view only ----
// Human-readable job description for the invoice memo, e.g. "Stainless T304 · 16ga (.060) × 10".
function describeJob(p) {
  const mat = MATERIALS.find((m) => m.id === p.material);
  const matName = mat ? mat.name : p.material;
  let thkLabel = p.thickness;
  const opt = [...els.thickness.options].find((o) => o.value === String(p.thickness));
  if (opt) thkLabel = opt.textContent.trim();
  return `${matName} · ${thkLabel} × ${p.qty}`;
}

// Suggest a quote number like Q-260714-1430 (date+time) so each file is unique.
function suggestDocNum() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `Q-${String(d.getFullYear()).slice(2)}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}

const QB_STORE = { ar: "mq_qb_ar", income: "mq_qb_income" };

function wireQBExport() {
  if (!els.qbBtn) return;
  // Restore the account names the owner set previously on this device.
  try {
    if (els.qbAr) els.qbAr.value = localStorage.getItem(QB_STORE.ar) || "";
    if (els.qbIncome) els.qbIncome.value = localStorage.getItem(QB_STORE.income) || "";
  } catch {}
  const persist = () => {
    try {
      if (els.qbAr) localStorage.setItem(QB_STORE.ar, els.qbAr.value.trim());
      if (els.qbIncome) localStorage.setItem(QB_STORE.income, els.qbIncome.value.trim());
    } catch {}
  };
  els.qbAr && els.qbAr.addEventListener("change", persist);
  els.qbIncome && els.qbIncome.addEventListener("change", persist);
  els.qbBtn.addEventListener("click", downloadIIF);
}

function qbStatus(msg, isErr) {
  if (!els.qbStatus) return;
  els.qbStatus.hidden = false;
  els.qbStatus.textContent = msg;
  els.qbStatus.classList.toggle("err", !!isErr);
}

function downloadIIF() {
  if (!lastQuote) { qbStatus("Get a quote first.", true); return; }
  const customer = (els.qbCustomer.value || "").trim();
  if (!customer) { qbStatus("Enter a customer name — QuickBooks requires one.", true); els.qbCustomer.focus(); return; }
  const docNum = (els.qbDocnum.value || "").trim() || suggestDocNum();
  const qb = {};
  const ar = (els.qbAr && els.qbAr.value || "").trim();
  const income = (els.qbIncome && els.qbIncome.value || "").trim();
  if (ar) qb.arAccount = ar;
  if (income) qb.incomeAccount = income;
  try {
    const iif = buildInvoiceIIF(lastQuote.q, { customer, docNum, date: iifDate(), memo: lastQuote.desc, qb });
    const safe = (customer + "-" + docNum).replace(/[^\w.-]+/g, "_").slice(0, 60);
    downloadText(`${safe}.iif`, iif);
    qbStatus(`Saved ${safe}.iif — import in QuickBooks: File ▸ Utilities ▸ Import ▸ IIF Files.`, false);
  } catch (e) {
    qbStatus(e.message || "Couldn't build the QuickBooks file.", true);
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Printable / shareable quote document (everyone) ----
// Gather everything the branded quote SVG needs from the last rendered quote.
function gatherQuoteData() {
  if (!lastQuote) return null;
  const { q, p } = lastQuote;
  const b = q.breakdown || {};
  // Setup & handling: annotate + keep the line when the owner waived some/all of it, so the
  // waiver reads as an explicit line item even when the billed amount is $0.
  const setupWaived = Number(q.setupWaived) || 0;
  const setupNote = q.setupWaive === "all"
    ? "waived"
    : (q.setupWaive === "after2" && setupWaived > 0.004 ? `waived beyond 2 sheets · ${money(setupWaived)}` : "");
  const lines = [
    { label: "Material", amount: Number(b.material) || 0 },
    { label: "Machine time", amount: Number(b.machine) || 0, note: INTERNAL && q.machineMinutes > 0 ? `≈ ${fmtMinutes(q.machineMinutes)}` : "" },
    { label: "Gas surcharge", amount: Number(b.gas) || 0 },
    { label: "Setup & handling", amount: Number(b.processing) || 0, note: setupNote, keep: !!setupNote },
    { label: "Minimum order top-up", amount: Number(b.minTopUp) || 0, note: "job is under our order minimum" },
  ].filter((l) => l.keep || Math.abs(l.amount) > 0.004);
  const sizeText = `${fmtIn(p.widthIn)}″ × ${fmtIn(p.heightIn)}″${p.nest ? " · nested" : ""}`;
  const quoteNo = (els.qbDocnum && els.qbDocnum.value || "").trim() || suggestDocNum();
  return {
    quoteNo,
    date: new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }),
    validUntil: validUntilForMaterial(p.material) ? fmtDate(validUntilForMaterial(p.material)) : "",
    customer: (els.qbCustomer && els.qbCustomer.value || "").trim(),
    jobDesc: lastQuote.desc,
    sizeText,
    qty: q.qty,
    perPart: q.perPart,
    total: q.total,
    lines,
    shippingNote: (LAYOUT && LAYOUT.shippingNote) || "",
    leadTimeNote: (LAYOUT && LAYOUT.leadTimeNote) || "",
    // Costs-as-of date + volatility + who to email. Dated to the material actually quoted.
    pricingNote: pricingEstimateNote(q.priceAsOf),
    // Only when the Worker fell back off live MakerStock pricing — printed on the quote too, so the
    // paper copy carries the same caveat the screen did.
    notCurrentNote: q.priceCurrent === false ? notCurrentQuoteNote(q.priceAsOf) : "",
    // Leftover disposition — only meaningful when a full sheet with an offcut is billed (custom order).
    leftoverNote: q.fullSheetMin
      ? (els.shipLeftover && els.shipLeftover.checked
          ? "Leftover material from the full sheet ships with your order."
          : "Leftover material retained by the shop (not requested).")
      : "",
    engraveNote: engraveInterior()
      ? "Interior features not considered in this quote — priced for the cut outer profile (blank) only; engraving handled separately."
      : "",
    disclaimer: "Prices are estimates. Final quote confirmed after file review.",
    terms: activeTerms(), // printed in fine detail at the foot of the quote (same source as the T&C modal)
    previewSVG: els.nestSvg ? els.nestSvg.innerHTML : "", // the on-screen sheet-layout picture
  };
}

function safeQuoteName(data) {
  const who = data.customer ? data.customer + "-" : "";
  return ("Quote-" + who + data.quoteNo).replace(/[^\w.-]+/g, "_").slice(0, 60);
}

// PDF: open the SVG full-page in a new tab and trigger the browser's print dialog
// (the user chooses "Save as PDF"). Zero dependencies, prints crisply.
function saveQuotePDF() {
  const data = gatherQuoteData();
  if (!data) return;
  const svg = buildQuoteSVG(data);
  const w = window.open("", "_blank");
  if (!w) { alert("Please allow pop-ups for this site to save the quote PDF."); return; }
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${data.quoteNo}</title>` +
    `<style>@page{size:letter;margin:0}html,body{margin:0;background:#fff}svg{width:100%;height:auto;display:block}</style>` +
    `</head><body>${svg}<script>window.onload=function(){setTimeout(function(){window.focus();window.print();},250);};<\/script></body></html>`
  );
  w.document.close();
}

// JPG: rasterize the SVG to a 2× canvas and download. Self-contained SVG => no canvas taint.
function saveQuoteJPG() {
  const data = gatherQuoteData();
  if (!data) return;
  const svg = buildQuoteSVG(data);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = 816 * scale;
    canvas.height = 1056 * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => { if (blob) downloadBlob(`${safeQuoteName(data)}.jpg`, blob); }, "image/jpeg", 0.92);
  };
  img.onerror = () => { URL.revokeObjectURL(url); alert("Couldn't render the quote image."); };
  img.src = url;
}

// Terms & Conditions — the DEFAULT set. The live terms are read from LAYOUT.terms (edited in
// admin.html → Settings) and fall back to this list. Shown to everyone: rendered into the T&C
// modal (each item's leading "Label:" is bolded) AND passed to the quote document as fine print,
// so the two can never drift apart. Plain strings, "Label: body" form.
const DEFAULT_TERMS = [
  "As-cut condition: Unless otherwise specified, parts ship as they come off the laser with no secondary cleanup. This may include dross (slag) on thicker materials (over 0.188″) and can be more pronounced on some materials.",
  "Cosmetic finish: Each part is considered to have one cosmetic (show) side, which we preserve as best we can. The opposite side may have scratches, tooling marks, or other cosmetic defects.",
  "Sharp edges: Laser-cut parts can have sharp edges, burrs, or slag. Handle with appropriate care and protective equipment; deburring is available on request.",
  "Dimensional tolerance: Standard cut tolerance is approximately ±0.010″ unless otherwise agreed in writing. Thicker or reflective materials, small holes, and fine detail may vary more — tell us before ordering if your part needs a tighter tolerance.",
  "Material variation: Metal is supplied to nominal mill standards; actual gauge, temper, finish, mill markings, and color (especially on anodized stock) may vary between sheets and suppliers.",
  "Customer-supplied files: Parts are cut to the dimensions and geometry in the file you provide. Please confirm your file is correct, to scale, and in the intended units; we are not responsible for errors in customer-supplied artwork.",
  "Fitness for use: You are responsible for confirming that the chosen material, thickness, and design are suitable for your intended use, and that you have the right to reproduce the design.",
  "Lead times: Lead times are approximate and can vary based on material source. We will do what we can to make and ship your parts as soon as possible.",
  "Changes & cancellation: Once cutting has begun, changes or cancellations are billed for the material and labor already incurred.",
  "Custom work & claims: All parts are made to order and are non-returnable except in the case of our error or a verified material or workmanship defect. Please inspect your order on arrival and report any problem within 14 days; our liability is limited to repair, replacement, or refund of the affected parts.",
  "Leftover material: If “Ship the leftover with my order” is selected, the drop (offcut) from the sheet ships with your ordered parts, and you are charged the actual shipping cost of the order, including any additional fees the added drop causes you to incur. If it is not selected, the leftover material becomes the property of Potassium Solutions and may be scrapped or used to fulfill other orders.",
];
// Live terms: use the admin-editable LAYOUT.terms when present, else the defaults above.
function activeTerms() {
  return (LAYOUT && Array.isArray(LAYOUT.terms) && LAYOUT.terms.length) ? LAYOUT.terms : DEFAULT_TERMS;
}

// ---- About / How-to + Terms modals ----
function wireAbout() {
  if (els.footYear) els.footYear.textContent = String(new Date().getFullYear());
  wireModal(els.aboutModal, [els.aboutBtn, els.aboutLink]);
  // Fill the Terms modal from the live terms (bold the "Label:" lead), then wire it.
  if (els.termsList) {
    els.termsList.innerHTML = activeTerms().map((t) => {
      const i = t.indexOf(":");
      const label = i > 0 ? t.slice(0, i + 1) : "";
      const body = i > 0 ? t.slice(i + 1) : t;
      const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<li>${label ? `<strong>${esc(label)}</strong>` : ""}${esc(body)}</li>`;
    }).join("");
  }
  wireModal(els.termsModal, [els.termsLink]);
}

// Open a modal from any of the given triggers; close on ×, backdrop, or Escape.
function wireModal(modal, openers) {
  if (!modal) return;
  const open = (e) => { if (e) e.preventDefault(); modal.hidden = false; };
  const close = () => { modal.hidden = true; };
  openers.forEach((el) => { if (el) el.addEventListener("click", open); });
  modal.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", close));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
}

// ---- Small helpers ----
function money(n) { return "$" + Number(n).toFixed(2); }
function fmtMinutes(m) {
  const total = m * 60; // seconds
  if (total < 60) return `${Math.round(total)} sec`;
  const mm = Math.floor(m), ss = Math.round((m - mm) * 60);
  return ss ? `${mm} min ${ss} sec` : `${mm} min`;
}
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }
function trim(n) { return (Math.round(n * 1000) / 1000).toString(); }
function fmtIn(n) { return (Math.round(n * 100) / 100).toString(); }
function showFileStatus(msg, isErr) { els.fileStatus.hidden = false; els.fileStatus.textContent = msg; els.fileStatus.classList.toggle("err", !!isErr); }
function showError(msg) { els.error.hidden = false; els.error.textContent = msg; }
function hideError() { els.error.hidden = true; }

init();
