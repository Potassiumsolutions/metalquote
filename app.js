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
import { loadInventory, saveInventory, getStock, consumeSheets, lineKey, getLots, activeLotPrice, priceSheetsFIFO, syncInventoryToServer } from "./lib/inventory.js";

const CONFIG = {
  BACKEND_URL: "https://metalquote.ksoldesigns.workers.dev", // e.g. "https://metalquote.you.workers.dev"
  EDITION: "customer", // "internal" (you: full costs + margin) | "customer" (public: price only)
};

// ---- Loaded at startup from the data/ files ----
let MATERIALS = [];       // [{id,name,thicknesses:[{label,in}]}]
let LAYOUT = null;        // {sheet:{widthIn,heightIn}, maxPartIn, marginIn, gapNestIn, gapPlainIn, allowRotate}
let DEMO = null;          // demo mode only: {markup, settings:{...knobs}, prices:{mat:{thk:price}}}

// ---- State ----
// filePartsAll/fileBBox: the candidate panels detected in a file that decomposes into >1 piece
// (null for a genuinely single piece or a hand-typed size). Used only while the width/height
// fields still match the loaded file.
// multiDefault: the heuristic's guess (true = looks like a real multi-part layout, false = one
// design made of many strokes/letters, e.g. a logo). multiOverride: the user's manual toggle
// (null = follow the guess, true/false = force). Effective decision = multiOverride ?? multiDefault.
const state = { widthIn: 0, heightIn: 0, cutLengthIn: 0, outerCutLengthIn: 0, interiorCutLengthIn: 0, interiorBBoxIn: null, shape: null, shapeOuter: null, filePartsAll: null, multiDefault: false, multiOverride: null, hasInterior: false, fileBBox: null };

// Interior-features mode (#cut-mode), offered only for single-part files that actually have
// interior geometry (lettering/logos/cut-outs floating inside the outline):
//   "all"     — cut every line in the file, interior included (the default)
//   "outer"   — cut the outer blank only; the interior is left OUT of the quote entirely
//   "engrave" — cut the outer blank AND raster-engrave the interior on the same machine, priced as
//               an "Engraving" line from the interior's bounding box (see engraveMinutes). Only
//               offered where the material's machine has an engrave profile (the CO2, not the xTool).
function cutMode() {
  if (!els.cutMode || !els.engraveField || els.engraveField.hidden) return "all";
  const v = els.cutMode.value;
  if (v === "engrave") return engraveOfferedFor(els.material.value) && state.interiorBBoxIn ? "engrave" : "outer";
  return v === "outer" ? "outer" : "all";
}
// True when the interior is NOT cut through (outer-only or engraved) → the cut length is the outer profile.
function engraveInterior() { return cutMode() !== "all"; }
function engraveMode() { return cutMode() === "engrave"; }
function activeCutLengthIn() {
  return engraveInterior() ? (state.outerCutLengthIn || 0) : (state.cutLengthIn || 0);
}
// Outer-only mode drops the interior from the preview (it isn't made); engrave mode keeps it (it is).
function activeShape() {
  return cutMode() === "outer" && state.shapeOuter ? state.shapeOuter : state.shape;
}
// Engraving machines that can take this material at the current part size (LAYOUT.engravers is the
// public list: label, bed, categories, priority — rates/speeds live only in the private files).
function engraversFor(materialId) {
  const m = MATERIALS.find((x) => x.id === materialId);
  return eligibleEngravers(LAYOUT && LAYOUT.engravers, materialCategory(m), state.widthIn, state.heightIn);
}
function engraveOfferedFor(materialId) { return engraversFor(materialId).length > 0; }
// The engraver the quote will use: the selector's pick when still eligible, else the best fit.
function selectedEngraverId() {
  const list = engraversFor(els.material.value);
  const want = els.engraveMachine ? els.engraveMachine.value : "";
  const hit = list.find(([id]) => id === want);
  return hit ? hit[0] : (list[0] ? list[0][0] : "");
}
// Rebuild the "Engrave on" selector for the current material + part size, keeping the pick when it
// still fits. Shown only while the interior mode is "engrave".
function updateEngraveMachineField() {
  if (!els.engraveMachine || !els.engraveMachineField) return;
  const list = engraversFor(els.material.value);
  const prev = els.engraveMachine.value;
  els.engraveMachine.innerHTML = "";
  list.forEach(([id, e]) => els.engraveMachine.add(new Option(e.label || id, id)));
  els.engraveMachine.value = list.some(([id]) => id === prev) ? prev : (list[0] ? list[0][0] : "");
  // Always shown in engrave mode — even a single option tells the customer which machine engraves.
  els.engraveMachineField.hidden = !(cutMode() === "engrave" && list.length > 0);
}
// Owner-only setup-fee waiver: "none" (charge per sheet), "after2" (bill only the first 2
// sheets), or "all" (waive entirely). Only honored in the internal edition — the control is
// hidden for customers and the Worker never sees it, so this is always "none" for customers.
function setupWaiveMode() {
  return (INTERNAL && els.setupWaive && els.setupWaive.value) || "none";
}
// Owner-only order-minimum waiver: when on, a job that lands under the order minimum is quoted at
// its real calculated price instead of being topped up to the minimum. Internal edition only — the
// control is hidden for customers and the Worker never sees it, so it's always false for customers.
function waiveMinMode() {
  return !!(INTERNAL && els.waiveMin && els.waiveMin.checked);
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
// Owner-only, per-quote controls (internal edition only; the Worker never honors either — a
// customer-supplied sheet or price would let them talk the price down).
//   forceSheetId(): pin the quote to one sheet size (else "" = auto pick).
//   priceOverride(): charge a flat total for THIS quote (negotiated deal, or handling-only on a
//     sheet the customer brought). 0/blank = normal calculated quote.
function forceSheetId() {
  return (INTERNAL && els.ovSheet && els.ovSheet.value) || "";
}
function priceOverride() {
  if (!INTERNAL || !els.ovPrice) return 0;
  const n = Number(els.ovPrice.value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
// Fill the owner sheet-size picker with the SELECTED material's machine sheets (12×12 / 24×24 /
// 24×36 for acrylic), largest last. Keeps the current pick if it still exists.
function populateOverrideSheets() {
  if (!els.ovSheet) return;
  const prev = els.ovSheet.value;
  const sheets = layoutSheets().slice().sort((a, b) => sheetAreaOf(a) - sheetAreaOf(b));
  els.ovSheet.innerHTML = "";
  els.ovSheet.add(new Option("Sheet: auto", ""));
  sheets.forEach((s) => els.ovSheet.add(new Option(`Sheet: ${trim(s.widthIn)}×${trim(s.heightIn)}″`, s.id)));
  els.ovSheet.value = [...els.ovSheet.options].some((o) => o.value === prev) ? prev : "";
}

// The panels to nest right now: the loaded file's panels ONLY when (a) the size fields still match
// the file and (b) we're treating it as a real multi-part layout. Otherwise a single rectangle from
// the typed width/height (a manual edit, a single design, or a logo = one part).
function currentParts() {
  if (sizeMatchesFile() && effectiveMulti()) return state.filePartsAll;
  return [{ w: state.widthIn, h: state.heightIn }];
}

// True while the typed width/height still describe the loaded file's overall bounding box.
function sizeMatchesFile() {
  if (!state.fileBBox) return false;
  const near = (a, b) => Math.abs(a - b) <= 0.02;
  return near(state.widthIn, state.fileBBox.w) && near(state.heightIn, state.fileBBox.h);
}

// The effective single-vs-multi decision: the user's manual override if set, else the auto guess.
// Only meaningful when the file actually decomposed into candidate panels.
function effectiveMulti() {
  if (!state.filePartsAll) return false;
  return state.multiOverride == null ? state.multiDefault : state.multiOverride;
}

// Decide whether a >1-panel decomposition is a GENUINE multi-part layout (several separate parts
// laid out to cut and nest together) versus ONE design that merely fragments into many disconnected
// pieces (a logo/wordmark: letters, dots, a frame drawn as loose line segments). Auto-detection
// can't be perfect, so this errs toward "single" — under-splitting quotes the whole envelope (safe,
// never under-charges) and the user can flip the toggle on. Signals of a real multi-part layout:
//   • no DEGENERATE panels — a zero-area stroke (a construction/frame line) never bounds a real part;
//   • at least two SUBSTANTIAL, comparable panels (not one big piece surrounded by fragments);
//   • few stray tiny fragments relative to the biggest piece.
function classifyMulti(parts, overallW, overallH) {
  if (!parts || parts.length < 2) return false;
  const boxes = parts.map((p) => ({ w: Math.max(0, p.w), h: Math.max(0, p.h), area: Math.max(0, p.w) * Math.max(0, p.h) }));
  const maxArea = Math.max(...boxes.map((b) => b.area));
  if (!(maxArea > 0)) return false;
  const overallArea = Math.max(overallW, 0) * Math.max(overallH, 0);
  // A panel is degenerate if either side is essentially zero (a line, not a part outline).
  const degenerate = boxes.filter((b) => b.w < 0.02 || b.h < 0.02).length;
  // Substantial = a meaningful fraction of BOTH the largest panel and the whole design.
  const substantial = boxes.filter((b) => b.area >= maxArea * 0.12 && b.area >= overallArea * 0.03);
  // Tiny fragment = under 5% of the largest panel (dots, serifs, stray marks).
  const tiny = boxes.filter((b) => b.area < maxArea * 0.05).length;
  return degenerate === 0 && substantial.length >= 2 && tiny <= 1;
}

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const els = {
  drop: $("drop"), file: $("file"), browse: $("browse"), fileStatus: $("file-status"),
  samplePart: $("sample-part"),
  width: $("width"), height: $("height"),
  material: $("material"), thickness: $("thickness"), qty: $("qty"), nest: $("nest"), sheetPref: $("sheet-pref"), sheetPrefField: $("sheet-pref-field"),
  typeFilter: $("type-filter"), finishFilter: $("finish-filter"), finishFilterWrap: $("finish-filter-wrap"),
  showAllSheets: $("show-all-sheets"), allSheetsField: $("allsheets-field"),
  partCheck: $("part-check"), partView: $("part-view"),
  stockReadout: $("stock-readout"),
  quoteBtn: $("quote-btn"), error: $("error"),
  resultEmpty: $("result-empty"), result: $("result"),
  total: $("total"), perpart: $("perpart"), qtyEcho: $("qty-echo"),
  bdMaterial: $("bd-material"), bdMachine: $("bd-machine"), bdMachineNote: $("bd-machine-note"),
  bdGas: $("bd-gas"), bdGasRow: $("bd-gas-row"),
  bdProcess: $("bd-process"), bdProcessNote: $("bd-process-note"), bdMinRow: $("bd-min-row"), bdMin: $("bd-min"), bdTotal: $("bd-total"),
  setupWaive: $("setup-waive"), setupWaiveField: $("setup-waive-field"),
  waiveMin: $("waive-min"), waiveMinField: $("min-waive-field"),
  ppsOverride: $("pps-override"), ppsField: $("pps-field"),
  ovField: $("ov-field"), ovSheet: $("ov-sheet"), ovPrice: $("ov-price"),
  breakdown: $("breakdown"), bdOverrideRow: $("bd-override-row"), bdOverride: $("bd-override"),
  metaFit: $("meta-fit"), metaSheets: $("meta-sheets"), minNote: $("min-note"), sheetNote: $("sheet-note"), stockOffer: $("stock-offer"),
  shipLeftover: $("ship-leftover"), leftoverField: $("leftover-field"),
  cutMode: $("cut-mode"), cutModeHint: $("cut-mode-hint"), engraveField: $("engrave-field"), engraveNote: $("engrave-note"),
  engraveMachine: $("engrave-machine"), engraveMachineField: $("engrave-machine-field"),
  bdEngraveRow: $("bd-engrave-row"), bdEngrave: $("bd-engrave"), bdEngraveNote: $("bd-engrave-note"),
  cbEngraveRow: $("cb-engrave-row"), cbEngrave: $("cb-engrave"),
  multiToggle: $("multi-parts"), multiField: $("multi-field"), multiHint: $("multi-hint"),
  nestSvg: $("nest-svg"), modeBadge: $("mode-badge"), sheetDim: $("sheet-dim"), sheetCap: $("sheet-cap"),
  expiryBanner: $("expiry-banner"), validityNote: $("validity-note"), shippingNote: $("shipping-note"), leadNote: $("lead-note"),
  pricingNote: $("pricing-note"), requestNote: $("request-note"), asCutNote: $("ascut-note"),
  notCurrentNote: $("notcurrent-note"), driftBanner: $("drift-banner"),
  ownerFreight: $("owner-freight"), ownerBadge: $("owner-badge"),
  costBreakdown: $("cost-breakdown"), cbInvNote: $("cb-invnote"), cbMaterial: $("cb-material"), cbFreight: $("cb-freight"),
  cbMachine: $("cb-machine"), cbGas: $("cb-gas"), cbGasRow: $("cb-gas-row"), cbProcess: $("cb-process"),
  cbTotalCost: $("cb-totalcost"), cbMarkup: $("cb-markup"), cbPrice: $("cb-price"), cbMargin: $("cb-margin"),
  qbExport: $("qb-export"), qbCustomer: $("qb-customer"), qbDocnum: $("qb-docnum"),
  qbAr: $("qb-ar"), qbIncome: $("qb-income"), qbBtn: $("qb-btn"), qbStatus: $("qb-status"),
  savePdf: $("save-pdf"), saveJpg: $("save-jpg"), emailBtn: $("email-quote"), emailNote: $("email-note"),
  actionsNote: $("actions-note"),
  leadCapture: $("lead-capture"), leadName: $("lead-name"), leadEmail: $("lead-email"),
  leadPhone: $("lead-phone"), leadNotes: $("lead-notes"), leadSend: $("lead-send"), leadStatus: $("lead-status"),
  invDeduct: $("inv-deduct"), invOnhand: $("inv-onhand"), invQty: $("inv-qty"), invBtn: $("inv-btn"), invStatus: $("inv-status"),
  aboutBtn: $("about-btn"), aboutModal: $("about-modal"), aboutLink: $("about-link"), footYear: $("foot-year"),
  termsModal: $("terms-modal"), termsLink: $("terms-link"), termsList: $("terms-list"),
  settingsBtn: $("settings-btn"), inventoryBtn: $("inventory-btn"),
  installBtn: $("install-btn"),
};

// Last rendered quote, kept for the owner-only QuickBooks export.
let lastQuote = null;

// Customer save-gate: a customer can SEE the price on screen, but a saved/printable copy (PDF/JPG)
// is locked until they send us their quote request (lead form). Owners are never gated. Reset to
// locked on every fresh quote (see getQuote); unlocked by a successful sendLead for that quote.
let saveUnlocked = false;
function saveGateLocked() { return !OWNER && !saveUnlocked; }
function applySaveGate() {
  const locked = saveGateLocked();
  for (const b of [els.savePdf, els.saveJpg]) {
    if (!b) continue;
    b.disabled = locked;
    b.title = locked ? "Send your quote request to unlock a saved / printable copy" : "";
  }
  // In customer mode the "Email this quote to us" mailto is redundant with the lead form — hide it
  // so there's one clear path. Owners keep it.
  if (els.emailBtn) els.emailBtn.hidden = !OWNER;
  if (els.actionsNote) {
    els.actionsNote.hidden = !locked;
    els.actionsNote.textContent = locked
      ? "You can view your price here. To get a saved or printable copy (PDF/JPG), send your quote request below."
      : "";
  }
}
// If a locked save is attempted anyway, point the customer at the lead form.
function nudgeSaveGate() {
  if (els.actionsNote) {
    els.actionsNote.hidden = false;
    els.actionsNote.textContent = "Please send your quote request below first — then your saved / printable copy unlocks.";
  }
  if (els.leadCapture && !els.leadCapture.hidden) els.leadCapture.scrollIntoView({ behavior: "smooth", block: "center" });
}

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
// Shown on every quoting surface (footer + quote PDF/JPG). Editable in admin via LAYOUT.asCutNote.
const DEFAULT_ASCUT_NOTE =
  "Pricing is for parts as they come off the laser — any surface finishing or edge prep (deburring, sanding, polishing) is not included.";
function asCutNote() { return (LAYOUT && LAYOUT.asCutNote) || DEFAULT_ASCUT_NOTE; }

// ---- Init ----
async function init() {
  if (!CONFIG.BACKEND_URL) els.modeBadge.hidden = false;
  // On open, hand the owner's Inventory to the local launcher so it can update the online prices to
  // match (non-MakerStock lines). Owner edition only; no-ops off localhost (see syncInventoryToServer).
  if (EDITION === "internal") syncInventoryToServer();
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
  // Owner-only order-minimum waiver toggle. Internal edition only; re-quote when it changes.
  if (INTERNAL && els.waiveMinField) {
    els.waiveMinField.hidden = false;
    if (els.waiveMin) els.waiveMin.addEventListener("change", () => { if (!els.result.hidden) getQuote(); });
  }
  // Owner-only parts-per-sheet override. Internal edition only; re-quote when it changes.
  if (INTERNAL && els.ppsField) {
    els.ppsField.hidden = false;
    if (els.ppsOverride) els.ppsOverride.addEventListener("input", () => { if (!els.result.hidden) getQuote(); });
  }
  // Owner-only per-quote price override + sheet-size picker. Internal edition only; re-quote on change.
  if (INTERNAL && els.ovField) {
    els.ovField.hidden = false;
    if (els.ovSheet) els.ovSheet.addEventListener("change", () => { if (!els.result.hidden) getQuote(); });
    if (els.ovPrice) els.ovPrice.addEventListener("input", () => { if (!els.result.hidden) getQuote(); });
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
  if (els.asCutNote) els.asCutNote.textContent = asCutNote();
  if (els.pricingNote) els.pricingNote.textContent = pricingEstimateNote();
  setupExpiry();

  // Type + finish filters, then the material list they narrow. Keeps the picker short as the
  // catalogue grows (many acrylic colours). Both filters populate from what's loaded.
  populateTypeFilter();
  populateFinishFilter();
  applyMaterialFilter();
  if (els.typeFilter) els.typeFilter.addEventListener("change", () => { populateFinishFilter(); applyMaterialFilter(); });
  if (els.finishFilter) els.finishFilter.addEventListener("change", applyMaterialFilter);
  // A material change can move the part to a different machine (metal xTool ↔ CO2), which decides
  // whether the "engrave the interior" option is offered — re-evaluate the interior-features field.
  els.material.addEventListener("change", (e) => { fillThickness(e); updateEngraveField(); });

  // file input
  els.browse.addEventListener("click", () => els.file.click());
  els.drop.addEventListener("click", (e) => { if (e.target === els.browse) return; els.file.click(); });
  els.file.addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  if (els.samplePart) els.samplePart.addEventListener("click", loadSamplePart);

  ["dragover", "dragenter"].forEach((ev) =>
    els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove("drag"); }));
  els.drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

  // recompute readiness / preview when inputs change
  [els.width, els.height, els.qty, els.material, els.thickness].forEach((el) =>
    el.addEventListener("input", onInputs));
  els.nest.addEventListener("change", () => { onInputs(); if (!els.result.hidden) drawPreview(); });
  // "Show all sheets" only changes the preview picture — redraw, no re-quote.
  if (els.showAllSheets) els.showAllSheets.addEventListener("change", () => { if (!els.result.hidden) drawPreview(); });
  // Sheet preference changes the chosen sheet/price — re-quote if a quote is on screen.
  if (els.sheetPref) els.sheetPref.addEventListener("change", () => { if (!els.result.hidden) getQuote(); });
  // Leftover choice doesn't change price — just re-render the shown quote so the note + PDF update.
  if (els.shipLeftover) els.shipLeftover.addEventListener("change", () => { if (!els.result.hidden && lastQuote) renderQuote(lastQuote.q, lastQuote.p); });
  // The interior-features mode changes the cut length and adds/removes the engraving line → the
  // price. Re-quote when a quote is on screen.
  if (els.cutMode) els.cutMode.addEventListener("change", () => { updateCutModeHint(); updateEngraveMachineField(); if (!els.result.hidden) getQuote(); });
  // Engraving machine changes the engraving line (speed, rate, extra setup) → re-quote.
  if (els.engraveMachine) els.engraveMachine.addEventListener("change", () => { if (!els.result.hidden) getQuote(); });
  // Multiple-parts override switches between nesting the panels and quoting the whole envelope as
  // one part → different price and preview. It also gates the engrave toggle (single-part only).
  if (els.multiToggle) els.multiToggle.addEventListener("change", () => {
    state.multiOverride = els.multiToggle.checked;
    updateEngraveField();
    if (!els.result.hidden) getQuote(); else onInputs();
  });

  els.quoteBtn.addEventListener("click", getQuote);
  wireQBExport();
  if (els.savePdf) els.savePdf.addEventListener("click", saveQuotePDF);
  if (els.saveJpg) els.saveJpg.addEventListener("click", saveQuoteJPG);
  if (els.emailBtn) els.emailBtn.addEventListener("click", emailQuote);
  if (els.leadSend) els.leadSend.addEventListener("click", sendLead);
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
  // Sheet-size preference is meaningless for STOCK: it's area-priced on the stocked size, so the
  // pick can't change the price. Hide the control for any stock material (keyed on the stock flag,
  // so a material switched to stock later inherits this automatically). See the stock #sheet-note.
  if (els.sheetPrefField) els.sheetPrefField.hidden = !fullSheetMinFor(els.material.value);
  buildSheetPrefOptions(); // list this material's real sheet sizes (12×12 / 24×24 / 24×36 for acrylic)
  populateOverrideSheets(); // owner sheet-size picker tracks the material's machine sheets
  updateRequestOnly();
  updateStockReadout();
}

// Price-on-request material chosen. For CUSTOMERS it swaps the quote button for the contact message.
// For the OWNER (INTERNAL) it stays quotable — the owner maintains the price in admin and can still
// quote it here — with a note reminding them customers can't. The Worker enforces the customer block
// server-side regardless, so a price-on-request material never quotes through the public path.
function updateRequestOnly() {
  const flagged = quoteOnRequestFor(els.material.value);
  const blockCustomer = flagged && !INTERNAL;
  if (els.requestNote) {
    els.requestNote.hidden = !flagged;
    els.requestNote.textContent = !flagged ? ""
      : INTERNAL ? "Customers see “price on request” for this material — you can still quote it here using the price on file (set it in Settings)."
      : requestOnlyMsg();
  }
  if (els.quoteBtn) {
    els.quoteBtn.disabled = blockCustomer;
    els.quoteBtn.textContent = blockCustomer ? "Price on request" : "Get Quote";
  }
  if (blockCustomer) { els.result.hidden = true; els.resultEmpty.hidden = false; }
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
  // A price-on-request material stays unquotable for CUSTOMERS no matter how complete the form is;
  // the owner (INTERNAL) can still quote it from the price on file.
  els.quoteBtn.disabled = !ready || (quoteOnRequestFor(els.material.value) && !INTERNAL);
  // Keep the file-dependent controls in sync with the current size. A hand-typed size that no
  // longer matches the loaded file drops the file geometry (currentParts falls back to a plain
  // rectangle), so both the multiple-parts override and the interior-engrave toggle retract;
  // returning to the matching size restores them.
  if (state.fileBBox) {
    updateMultiField();
    updateEngraveField();
  }
  updateStockReadout();
}

// Offer the engrave-interior toggle only when the file is being treated as a SINGLE part and it
// carries real interior geometry (≥0.5″ of interior cut) to exclude. Hidden + reset for manual
// sizes and for files treated as multi-part. Pass `dims` on load to refresh the interior flag;
// call with no args (e.g. from the multi-parts toggle) to re-evaluate using the stored flag.
function updateEngraveField(dims) {
  if (!els.engraveField) return;
  if (dims) state.hasInterior = (dims.interiorCutLengthIn || 0) > 0.5;
  const show = !effectiveMulti() && !!state.hasInterior && sizeMatchesFile();
  els.engraveField.hidden = !show;
  if (!show && els.cutMode) els.cutMode.value = "all";
  // The engrave option exists only where the material's machine engraves (CO2 acrylic/wood — not
  // the metal xTool) and the file gave us an interior region to scan. Otherwise it's a 2-way choice.
  const opt = els.cutMode && els.cutMode.querySelector('option[value="engrave"]');
  if (opt) {
    const ok = engraveOfferedFor(els.material.value) && !!state.interiorBBoxIn;
    opt.hidden = !ok; opt.disabled = !ok;
    if (!ok && els.cutMode.value === "engrave") els.cutMode.value = "outer";
  }
  updateCutModeHint();
  updateEngraveMachineField();
}
// One-line explanation under the interior-features select, per mode.
function updateCutModeHint() {
  if (!els.cutModeHint) return;
  const m = cutMode();
  els.cutModeHint.textContent = m === "engrave"
    ? "The outer blank is cut through and the interior detail is engraved into the surface on the same machine — priced as a separate Engraving line."
    : m === "outer"
      ? "Only the outer profile (the blank) is cut and priced. The interior detail is not included in this quote."
      : "Every line in the file is cut through, including the interior features.";
}

// Show the multiple-parts override only when the file actually decomposed into candidate panels
// and the typed size still matches it; keep the switch in sync with the effective decision.
function updateMultiField() {
  if (!els.multiField) return;
  const show = !!state.filePartsAll && sizeMatchesFile();
  els.multiField.hidden = !show;
  if (show && els.multiToggle) els.multiToggle.checked = effectiveMulti();
}

// ---- File handling ----
let lastLoadedFile = null; // remembered so a unit change can re-import
// Load the bundled sample part (bison.svg) so a customer with no DXF/SVG on hand can still try the
// tool. Fetched from the app's own origin and fed through the exact same handleFile path as a real
// upload, so it measures + prices identically.
async function loadSamplePart() {
  showFileStatus("Loading sample part…", false);
  try {
    const res = await fetch("bison.svg", { cache: "force-cache" });
    if (!res.ok) throw new Error("sample not found");
    const text = await res.text();
    // Wrap as a File so handleFile sees a normal .svg upload (it reads .name + .text()).
    const file = new File([text], "Bison-sample.svg", { type: "image/svg+xml" });
    await handleFile(file);
  } catch (e) {
    showFileStatus("Couldn't load the sample part — please try uploading a DXF or SVG.", true);
  }
}

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
  state.interiorBBoxIn = dims.interiorBBoxIn && dims.interiorBBoxIn.w > 0 && dims.interiorBBoxIn.h > 0 ? dims.interiorBBoxIn : null;
  state.shape = dims.shape || null;
  state.shapeOuter = dims.shapeOuter || dims.shape || null;
  // Keep the candidate panels whenever the file decomposes into more than one piece, and let the
  // heuristic guess whether that's a real multi-part layout or a single fragmented design (logo).
  // A fresh file clears any prior manual override.
  state.filePartsAll = dims.parts && dims.parts.length > 1 ? dims.parts : null;
  state.multiDefault = state.filePartsAll ? classifyMulti(dims.parts, dims.widthIn, dims.heightIn) : false;
  state.multiOverride = null;
  state.fileBBox = { w: dims.widthIn, h: dims.heightIn };
  updateMultiField();
  // Offer the engrave-interior toggle only for SINGLE-part files that actually have interior
  // geometry to exclude (≥0.5″ of interior cut). Reset it whenever a new file is loaded.
  updateEngraveField(dims);
  lastLoadedFile = null; // typed edits from here on
  onInputs();
}

// ---- Quote ----
async function getQuote() {
  hideError();
  // Customers can't quote a price-on-request material; the owner (INTERNAL) can.
  if (quoteOnRequestFor(els.material.value) && !INTERNAL) { updateRequestOnly(); return; }
  els.quoteBtn.disabled = true;
  els.quoteBtn.textContent = "Pricing…";
  const payload = {
    material: els.material.value,
    thickness: els.thickness.value,
    widthIn: state.widthIn,
    heightIn: state.heightIn,
    qty: parseInt(els.qty.value, 10) || 1,
    nest: els.nest.checked,
    cutLengthIn: activeCutLengthIn() || estimateCut(state.widthIn, state.heightIn), // outer-only when the interior isn't cut through
    // Interior-features mode + the interior's bounding box (inches) the engrave is priced from.
    cutMode: cutMode(),
    engraveWIn: engraveMode() && state.interiorBBoxIn ? round3(state.interiorBBoxIn.w) : 0,
    engraveHIn: engraveMode() && state.interiorBBoxIn ? round3(state.interiorBBoxIn.h) : 0,
    engraveMachine: engraveMode() ? selectedEngraverId() : "", // which engraving machine (see engraversFor)
    parts: currentParts().map((pt) => ({ w: pt.w, h: pt.h })), // panels to nest (shape stripped — server needs only w,h)
    sheetPref: els.sheetPref ? els.sheetPref.value : "auto", // auto | small | large
    setupWaive: setupWaiveMode(), // owner-only: none | after2 | all (local edition; Worker ignores it)
    waiveMin: waiveMinMode(),     // owner-only: skip the order-minimum top-up (local edition; Worker ignores it)
    forceSheet: forceSheetId(), // owner-only: pin a sheet size (local edition; Worker ignores it)
    priceOverride: priceOverride(), // owner-only: flat total for this quote (local edition; Worker ignores it)
    owner: OWNER, // owner view asks the Worker for the inbound-freight estimate
  };
  try {
    const quote = CONFIG.BACKEND_URL ? await quoteRemote(payload) : quoteLocal(payload);
    if (quote.error) throw new Error(quote.error);
    saveUnlocked = false; // a fresh quote re-locks the saved copy until this one's request is sent
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
  // Customers (and the owner's customer-preview, INTERNAL=false) can't quote a price-on-request
  // material; the owner quotes it from the local price. The Worker enforces the same for real customers.
  if (quoteOnRequestFor(p.material) && !INTERNAL) return { error: requestOnlyMsg() };
  // Effective machine knobs for THIS material (metal/xTool by default, or the acrylic CO2). Carries
  // the machine's rate, cut-speed bands, startup and setup fees. MUST match worker.js computeQuote.
  const knobs = effKnobs(p.material);
  const maxThk = maxThicknessMm(knobs);
  if ((Number(p.thickness) || 0) * 25.4 > maxThk + 1e-6)
    return { error: `We can't cut material thicker than ${maxThk} mm. Please choose a thinner thickness.` };
  // "Cut the outer profile + engrave the interior": only where this material's machine engraves,
  // with a speed on file and an interior region to scan. MUST match worker.js validate/computeQuote.
  const engraving = p.cutMode === "engrave";
  const matCat = materialCategory(MATERIALS.find((x) => x.id === p.material));
  const engr = engraving ? pickEngraver(DEMO && DEMO.settings && DEMO.settings.engravers, matCat, p.widthIn, p.heightIn, p.engraveMachine) : null;
  const engraveSpeed = engr ? engraveSpeedFor(p.material, engr.id, engr.e, DEMO && DEMO.engraveSpeed) : 0;
  if (engraving) {
    if (!engr) return { error: ENGRAVE_NOT_OFFERED_MSG };
    if (!(engraveSpeed > 0)) return { error: ENGRAVE_NO_SPEED_MSG };
    if (!((Number(p.engraveWIn) || 0) > 0 && (Number(p.engraveHIn) || 0) > 0)) return { error: ENGRAVE_NOTHING_MSG };
  }

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
  // OWNER INVENTORY PRICING (internal only): while priced stock is on hand for this material+size,
  // bill AREA-based on the stocked sheet with the cost drawn FIFO from the purchase lots (the price
  // the owner actually paid), landed — no separate inbound freight. Overrides the market/auto price
  // until the stock is used up, then normal pricing resumes. Markup still applies downstream, so the
  // margin panel + QuickBooks reflect true cost + markup.
  const invKey = lineKey(p.material, p.thickness, sheet.id);
  const invLots = INTERNAL ? getLots(loadInventory(), invKey) : [];
  const invPriced = invLots.some((l) => l.sheets > 0 && l.price != null);
  let invShort = false;
  if (invPriced) {
    const sheetA = sheetAreaOf(sheet);
    const blankPerSet = parts.reduce((s, pt) => s + (pt.w + gap) * (pt.h + gap), 0);
    materialAreaSqIn = blankPerSet * p.qty;
    const thr = knobs.stockFullSheetThreshold != null ? Number(knobs.stockFullSheetThreshold) : DEFAULT_STOCK_FULLSHEET_THRESHOLD;
    const sheetsUsed = sheetA > 0 ? materialAreaSqIn / sheetA : 0;
    stockBilledSheets = (sheetsUsed - Math.floor(sheetsUsed)) > thr ? Math.ceil(sheetsUsed) : sheetsUsed;
    stockFullSheetBilled = stockBilledSheets > sheetsUsed + 1e-9;
    const market = demoPriceSize(p.material, p.thickness, sheet.id); // overflow past stock, if any
    const fifo = priceSheetsFIFO(invLots, stockBilledSheets, market);
    materialCost = fifo.cost;
    inboundFreight = 0;
    invShort = fifo.short;
  } else if (fullSheetMin) {
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
  // Raster-engraving minutes for the interior region (0 unless cutMode is "engrave"). Same machine,
  // same rate, billed as its own "Engraving" line. It's a second pass in the same job, so the
  // per-job startup below is NOT charged twice. MUST match worker.js computeQuote.
  const engraveMin = engr ? engraveMinutes(p.engraveWIn, p.engraveHIn, p.qty, engr.e.engrave, engraveSpeed) : 0;
  // Engraving on a DIFFERENT physical machine than the cut adds that machine's own startup once.
  const engraveStartupMin = engr && engraveMin > 0 && engr.id !== (knobs.engraverId || null)
    ? (engr.e.machineStartupMin != null ? Number(engr.e.machineStartupMin) : DEFAULT_MACHINE_STARTUP_MIN)
    : 0;
  const engraveRate = engr ? (Number(engr.e.machineRatePerMin) || Number(knobs.machineRatePerMin) || DEFAULT_MACHINE_RATE) : 0;
  // …and that second machine's own SETUP & handling fee (load, fixture, focus), once per job, into
  // the Setup & handling line (outside the owner's per-sheet waiver). MUST match worker.js.
  const engraveSetupFee = engraveStartupMin > 0
    ? (engr.e.setupFee != null ? Number(engr.e.setupFee) || 0 : DEFAULT_ENGRAVER_SETUP_FEE)
    : 0;
  const processingTotal = processing + engraveSetupFee;
  // Baked-in per-JOB startup (machine boot + sending the file), billed once per order at the
  // machine rate. It consumes no assist gas, so it's added to machine time only — NOT the gas
  // surcharge, which stays on cutting minutes. Skipped when there's nothing to cut or engrave. `!= null`
  // so a deliberate 0 disables it (Number(0)||DEFAULT would wrongly re-add the default). MUST match worker.js.
  const startupMin = cutMinutes > 0 || engraveMin > 0
    ? (knobs.machineStartupMin != null ? Number(knobs.machineStartupMin) : DEFAULT_MACHINE_STARTUP_MIN)
    : 0;
  const minutes = cutMinutes + startupMin;
  const machineRate = Number(knobs.machineRatePerMin) || DEFAULT_MACHINE_RATE;
  const machineCost = minutes * machineRate;
  const engraveCost = (engraveMin + engraveStartupMin) * engraveRate;
  const gasSurcharge = gasSurchargeCost(p.thickness, cutMinutes, knobs, assistGasFor(p.material));
  // MARKUP APPLIES TO MATERIAL ONLY — machine time, engraving, gas and setup already bill at the
  // rates you set (machineRatePerMin, shieldingGasPerMin, processPerSheet), so they are NOT marked
  // up again. MUST match worker.js computeQuote.
  let total = materialCost * DEMO.markup + processingTotal + machineCost + engraveCost + gasSurcharge;
  const belowMin = total < knobs.minCharge;
  // Owner-only waiver (waiveMin): quote a sub-minimum job at its real price instead of topping it
  // up. Internal edition only — the Worker never sees the flag, so customers always pay the minimum.
  const waiveMin = INTERNAL && !!p.waiveMin;
  const applyMin = belowMin && !waiveMin;
  const realTotal = total;
  if (applyMin) total = knobs.minCharge;
  // Dollars given up by waiving the minimum (owner record only; 0 unless actually waived).
  const minWaived = belowMin && waiveMin ? round2(knobs.minCharge - realTotal) : 0;
  // When a job lands under minCharge the top-up gets its OWN line: setup used to be the plug,
  // so a small order read as a huge setup fee. Whichever line is the plug also absorbs rounding
  // drift, so the lines always sum to total. MUST match worker.js computeQuote.
  const markedMaterial = round2(materialCost * DEMO.markup);
  const markedMachine = round2(machineCost);
  const markedEngrave = round2(engraveCost);
  const markedGas = round2(gasSurcharge);
  const markedProcessing = applyMin
    ? round2(processingTotal)
    : round2(total - markedMaterial - markedMachine - markedEngrave - markedGas);
  const markedMinTopUp = applyMin
    ? round2(total - markedMaterial - markedMachine - markedEngrave - markedGas - markedProcessing)
    : 0;
  // Internal-only raw cost + margin (never shown to customers; also owner-gated in worker.js).
  const totalCost = materialCost + processingTotal + machineCost + engraveCost + gasSurcharge;
  const cost = {
    material: round2(materialCost - inboundFreight), freight: round2(inboundFreight),
    machine: round2(machineCost), engrave: round2(engraveCost), gas: round2(gasSurcharge), processing: round2(processingTotal),
    totalCost: round2(totalCost), markup: DEMO.markup, price: round2(total),
    margin: round2(total - totalCost), marginPct: total > 0 ? Math.round((total - totalCost) / total * 100) : 0,
  };
  const out = {
    total: round2(total), perPart: round2(total / p.qty), qty: p.qty,
    sheetsNeeded, partsPerSheet: perSheet, panels: parts.length, nest: p.nest, minChargeApplied: applyMin,
    // Owner-only order-minimum waiver: whether it was on, and the dollars given up by waiving.
    minWaive: waiveMin && belowMin, minWaived,
    machineMinutes: round2(minutes),
    // Internal-only engraving detail: minutes on the raster pass, the speed used, and the scanned
    // region. 0/absent unless the interior was engraved. Not returned by the Worker.
    engraveMinutes: round2(engraveMin),
    engraveStartupMin: round2(engraveStartupMin),
    engraveSpeedMmS: engr ? engraveSpeed : 0,
    engraveWIn: engr ? Number(p.engraveWIn) || 0 : 0,
    engraveHIn: engr ? Number(p.engraveHIn) || 0 : 0,
    engraveMachine: engr ? engr.id : "",
    engraveMachineLabel: engr ? (engr.e.label || engr.id) : "",
    engraveSetupFee: round2(engraveSetupFee), // $ of Setup & handling that is the 2nd machine's setup
    // Mirrors the Worker's fields so the internal quote dates its note the same way. Demo mode
    // prices from the local files, which the refresh stamps — so it's current by definition.
    priceCurrent: true,
    priceAsOf: isMakerStockSourced(p.material) ? makerstockAnchor() : manualAnchor(),
    // Internal-only fabrication detail (see showQuote): total distance the laser travels + the
    // cut-speed band picked for this thickness. Not returned by the Worker → customers never see it.
    cutTotalIn: round2((p.cutLengthIn || 0) * p.qty),
    cutSpeedMmS: speedForThicknessMm((Number(p.thickness) || 0) * 25.4, knobs.cutSpeeds),
    materialAreaSqIn: materialAreaSqIn != null ? round2(materialAreaSqIn) : null,
    // Owner inventory pricing (internal only): this quote's material cost came from purchase lots,
    // the active per-sheet purchase price, and whether the job needed more sheets than are stocked.
    materialFromInventory: invPriced,
    inventoryUnitPrice: invPriced ? invActivePrice(p.material, p.thickness, sheet.id) : null,
    inventoryShort: invShort,
    sheetId: sheet.id, sheetW: sheet.widthIn, sheetH: sheet.heightIn, fullSheetMin, stockFullSheetBilled,
    // Owner-only setup-fee waiver (see setupWaiveMode): the mode, sheets actually billed for setup,
    // the un-waived setup total, and the dollars waived — drives the "waived" line on the outputs.
    setupWaive, setupSheetsBilled: setupSheets, setupFull: round2(setupFull), setupWaived: round2(setupWaived),
    inboundFreight: round2(inboundFreight), cost,
    breakdown: {
      material: markedMaterial,
      machine: Math.max(0, markedMachine),
      engrave: Math.max(0, markedEngrave),
      gas: Math.max(0, markedGas),
      processing: Math.max(0, markedProcessing),
      minTopUp: Math.max(0, markedMinTopUp),
    },
  };
  // OWNER PRICE OVERRIDE (internal only): charge a flat total for this quote. The itemised lines are
  // replaced on the outputs by a single "Custom quote (as agreed)" line; the cost & margin panel
  // still reflects real cost, so the owner sees the margin on the negotiated price (even a loss).
  const ovr = Number(p.priceOverride) || 0;
  if (INTERNAL && ovr > 0) {
    out.overridePrice = round2(ovr);
    out.total = round2(ovr);
    out.perPart = round2(ovr / p.qty);
    out.minChargeApplied = false;
    out.cost = {
      ...out.cost, price: round2(ovr), margin: round2(ovr - totalCost),
      marginPct: ovr > 0 ? Math.round((ovr - totalCost) / ovr * 100) : 0,
    };
  }
  return out;
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
// Per-sheet setup/handling fee for a sheet size: setupFeeBySheet[id] → processPerSheet → default.
// Used by computeQuote AND by the sheet pickers, so the "cheapest sheet" comparison counts the
// handling of each extra sheet (5 small panels aren't cheaper than one big one once each is
// loaded, squared and unloaded). MUST match worker.js.
function setupFeeForSheet(knobs, sheetId) {
  const bySize = knobs.setupFeeBySheet && knobs.setupFeeBySheet[sheetId];
  if (bySize != null) return Number(bySize) || 0;
  return knobs.processPerSheet != null ? Number(knobs.processPerSheet) : DEFAULT_PROCESS_PER_SHEET;
}
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

// ---- Raster engraving (interior features) — MUST match backend/worker.js ----
// The engraver's head sweeps the interior's bounding box line by line: lines = height ÷ line
// interval; each line travels the width plus overscan (run-in/run-out where a gantry head reverses;
// 0 for a galvo) at the engrave speed. Speed = the material's per-engraver speed when set (wood
// species differ — see the machines guide), else the engraver's default.
const DEFAULT_ENGRAVE_LINE_INTERVAL_MM = 0.1; // ≈ 254 DPI — the usual CO2 fill interval
const DEFAULT_ENGRAVE_OVERSCAN_MM = 4;        // per side; LightBurn's 2.5% of speed ≈ 4.4 mm at 175 mm/s
const DEFAULT_ENGRAVER_SETUP_FEE = 5;         // $ per job to set the part up on a SECOND machine for engraving
const ENGRAVE_NOT_OFFERED_MSG = "Engraving isn't offered for this material. Choose \"Cut the outer profile only\" or \"Cut everything\".";
const ENGRAVE_NO_SPEED_MSG = "No engraving speed is set for this material yet — please contact us for an engraved quote.";
const ENGRAVE_NOTHING_MSG = "Nothing to engrave — the file has no interior features inside the outline.";

// ---- Engraving machines (settings.engravers) — MUST match backend/worker.js ----
// Engraving is its own machine choice, separate from the cutting machine. Each engraver carries its
// bed (bedWIn × bedHIn), the material CATEGORIES it can engrave, a priority (lower = preferred), its
// own $/min + startup, and engrave = { speedMmS, lineIntervalMm, overscanMm }. A cutting machine names
// its physical engraver via engraverId (the CO2 profiles → "co2", the metal default → "metalfab") so
// engraving on the SAME machine doesn't charge a second startup.
function engraverEligible(e, category, wIn, hIn) {
  if (!e || !Array.isArray(e.materials) || !e.materials.includes(category)) return false;
  const bw = Number(e.bedWIn) || 0, bh = Number(e.bedHIn) || 0;
  if (!(bw > 0 && bh > 0)) return true; // no bed limit
  const eps = 1e-9, w = Number(wIn) || 0, h = Number(hIn) || 0;
  return (w <= bw + eps && h <= bh + eps) || (h <= bw + eps && w <= bh + eps);
}
// [id, profile] pairs that can engrave this category at this part size, best first.
function eligibleEngravers(engravers, category, wIn, hIn) {
  return Object.entries(engravers || {})
    .filter(([, e]) => engraverEligible(e, category, wIn, hIn))
    .sort((a, b) => (Number(a[1].priority) || 99) - (Number(b[1].priority) || 99) || a[0].localeCompare(b[0]));
}
// Per-material engrave speed for an engraver: engraveSpeed[material] is a number (every engraver) or
// { engraverId: mmS, "*": mmS }; falls back to the engraver's own default.
function engraveSpeedFor(material, engId, eng, speedMap) {
  const v = speedMap && speedMap[material];
  let s = 0;
  if (typeof v === "number") s = v;
  else if (v && typeof v === "object") s = Number(v[engId] != null ? v[engId] : v["*"]) || 0;
  if (s > 0) return s;
  return eng && eng.engrave && Number(eng.engrave.speedMmS) > 0 ? Number(eng.engrave.speedMmS) : 0;
}
function engraveMinutes(wIn, hIn, qty, cfg, speedMmS) {
  if (!cfg || !(speedMmS > 0)) return 0;
  const wMm = (Number(wIn) || 0) * 25.4, hMm = (Number(hIn) || 0) * 25.4;
  if (!(wMm > 0) || !(hMm > 0)) return 0;
  const interval = Number(cfg.lineIntervalMm) > 0 ? Number(cfg.lineIntervalMm) : DEFAULT_ENGRAVE_LINE_INTERVAL_MM;
  const overscan = cfg.overscanMm != null ? Math.max(0, Number(cfg.overscanMm) || 0) : DEFAULT_ENGRAVE_OVERSCAN_MM;
  const lines = Math.ceil(hMm / interval);
  const secPerLine = (wMm + 2 * overscan) / speedMmS;
  return (lines * secPerLine * (qty || 1)) / 60;
}
// Resolve the engraver for a quote: the requested id when eligible, else the best eligible one.
function pickEngraver(engravers, category, wIn, hIn, requestedId) {
  const list = eligibleEngravers(engravers, category, wIn, hIn);
  if (!list.length) return null;
  const hit = requestedId && list.find(([id]) => id === requestedId);
  const [id, e] = hit || list[0];
  return { id, e };
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

// ---- machine profiles (mirror backend/worker.js effectiveSettings) ----
// A material may be cut on a machine other than the default metal one (e.g. acrylic on the OMTech
// CO2). The profile overrides sheets, holder/edge offset, cut speeds, rate, startup and setup fees.
// Sheet-side fields live in LAYOUT.machines[id] (materials.json), machine-time-side fields in
// DEMO.settings.machines[id] (demo-prices.json) — the same split the base config already uses.
// Every sheet helper below operates on the CURRENTLY SELECTED material, which is always the one
// being quoted or previewed, so resolving the profile from the dropdown keeps app == worker.
function machineIdForMat(materialId) {
  const m = MATERIALS.find((x) => x.id === materialId);
  return (m && m.machine) || null;
}
function activeMat() { return (els && els.material && els.material.value) || ""; }
function effLayoutFor(materialId) {
  const id = machineIdForMat(materialId);
  const prof = id && LAYOUT && LAYOUT.machines && LAYOUT.machines[id];
  return prof ? { ...LAYOUT, ...prof } : LAYOUT;
}
function effLayout() { return effLayoutFor(activeMat()); }
function effKnobs(materialId) {
  const base = (DEMO && DEMO.settings) || {};
  const id = machineIdForMat(materialId);
  const prof = id && base.machines && base.machines[id];
  return prof ? { ...base, ...prof } : base;
}

// ---- sheets & fit (mirror backend/worker.js) ----
function layoutSheets() {
  const L = effLayout();
  if (L.sheets && L.sheets.length) return L.sheets;
  const s = L.sheet || { widthIn: 24, heightIn: 24 };
  return [{ id: "24x24", widthIn: s.widthIn, heightIn: s.heightIn }];
}
function holderOffset() {
  const L = effLayout();
  return L.holderOffsetIn != null ? L.holderOffsetIn : (L.marginIn != null ? L.marginIn : 0.25);
}
// Reserved strip on the TOP and BOTTOM (Y) sheet ends to keep the sheet rigid during the cut.
// Separate from the X-end holder offset; 0 or unset = none. MUST match worker.js edgeReserveOf().
function edgeReserve() {
  const L = effLayout();
  return L.edgeReserveIn != null ? Number(L.edgeReserveIn) : 0;
}
function sheetAreaOf(s) { return s.widthIn * s.heightIn; }

// Rebuild the sheet-preference dropdown to list EVERY real sheet size for the current material
// (smallest→largest), so acrylic's three sizes (12×12, 24×24, 24×36) each appear as their own
// "Prefer N×N" choice instead of being squeezed into a fixed auto/small/large trio that couldn't
// name the middle size. Option value = the sheet id, which chooseSheet pins to. Keeps "Best price".
function buildSheetPrefOptions() {
  if (!els.sheetPref) return;
  const prev = els.sheetPref.value;
  const sheets = layoutSheets().slice().sort((a, b) => sheetAreaOf(a) - sheetAreaOf(b));
  els.sheetPref.innerHTML = "";
  els.sheetPref.add(new Option("Best price (automatic)", "auto"));
  sheets.forEach((s) => els.sheetPref.add(new Option(`Prefer ${trim(s.widthIn)}×${trim(s.heightIn)}`, s.id)));
  // Keep the prior choice if that size still exists for this material; otherwise fall back to auto.
  els.sheetPref.value = [...els.sheetPref.options].some((o) => o.value === prev) ? prev : "auto";
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
        for (const [skuKey, sizeId] of [["makerstockSku", "24x24"], ["makerstockSku12", "12x12"], ["makerstockSku36", "24x36"]]) {
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

// ---- material Type + Finish filters (keep the picker short) ----
// A material's Type is its category (metal / acrylic), falling back to its machine so untagged data
// still sorts sensibly. Finish only applies to acrylic (Solid / Transparent / Mirror / …).
function materialCategory(m) { return (m && m.category) || (m && m.machine === "acrylic" ? "acrylic" : "metal"); }
function titleCaseWord(s) { return String(s || "").replace(/\b\w/g, (c) => c.toUpperCase()); }
function populateTypeFilter() {
  if (!els.typeFilter) return;
  const prev = els.typeFilter.value;
  const cats = [...new Set(MATERIALS.map(materialCategory))]
    .sort((a, b) => (a === "metal" ? -1 : b === "metal" ? 1 : a.localeCompare(b))); // metal first
  els.typeFilter.innerHTML = "";
  cats.forEach((c) => els.typeFilter.add(new Option(titleCaseWord(c), c)));
  els.typeFilter.value = cats.includes(prev) ? prev : (cats[0] || "");
}
function populateFinishFilter() {
  if (!els.finishFilter) return;
  const cat = els.typeFilter ? els.typeFilter.value : "";
  const prev = els.finishFilter.value;
  const finishes = [...new Set(MATERIALS.filter((m) => materialCategory(m) === cat && m.finish).map((m) => m.finish))].sort();
  // No finishes for this type (e.g. metal) → hide the filter entirely and clear it.
  if (els.finishFilterWrap) els.finishFilterWrap.hidden = finishes.length === 0;
  els.finishFilter.innerHTML = "";
  els.finishFilter.add(new Option("All finishes", ""));
  finishes.forEach((f) => els.finishFilter.add(new Option(titleCaseWord(f), f)));
  els.finishFilter.value = finishes.includes(prev) ? prev : "";
}
// Rebuild the material dropdown to those matching the current Type (+ Finish), preserving the
// selection when it still qualifies, else selecting the first match. Then refresh thickness etc.
function applyMaterialFilter() {
  if (!els.material) return;
  const cat = els.typeFilter ? els.typeFilter.value : "";
  const fin = els.finishFilter && els.finishFilterWrap && !els.finishFilterWrap.hidden ? els.finishFilter.value : "";
  const prev = els.material.value;
  const list = MATERIALS.filter((m) => materialCategory(m) === cat && (!fin || m.finish === fin));
  els.material.innerHTML = "";
  list.forEach((m) =>
    els.material.add(new Option(
      `${m.name} · ${quoteOnRequestFor(m.id) ? "Price on request" : fullSheetMinFor(m.id) ? "Custom order" : "In stock"}`,
      m.id)));
  els.material.value = list.some((m) => m.id === prev) ? prev : (list[0] && list[0].id) || "";
  fillThickness();
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
  // Per-size price maps. 24x24 = DEMO.prices; other sizes get their own map. MUST match worker.js
  // SIZE_FIELDS and admin.js exports.
  const map = sizeId === "12x12" ? (DEMO && DEMO.prices12)
    : sizeId === "24x36" ? (DEMO && DEMO.prices36)
    : sizeId === "8x12" ? (DEMO && DEMO.prices8)
    : (DEMO && DEMO.prices);
  const m = (map && map[material]) || {};
  if (m[thickness] != null) return Number(m[thickness]) || null;
  const want = Number(thickness);
  for (const [k, v] of Object.entries(m)) if (Math.abs(Number(k) - want) < 1e-6) return Number(v) || null;
  return null;
}

// OWNER INVENTORY PRICING (internal edition only). The owner tracks sheets they bought at the price
// they paid (localStorage, per material+thickness+size). While priced stock is on hand, quotes price
// from the front purchase lot (FIFO, auto-advancing) INSTEAD of the market/auto price — see the
// quoteLocal material-cost branch. Returns the active per-sheet purchase price, or null (unstocked,
// unpriced, or customer edition) so callers fall back to demoPriceSize.
function invActivePrice(material, thickness, sheetId) {
  if (!INTERNAL) return null;
  return activeLotPrice(loadInventory(), lineKey(material, thickness, sheetId));
}
// Effective sheet price for the OWNER's sheet selection: inventory purchase price wins while stocked,
// else the market/auto price. Lets the owner quote a gauge that has no market price (e.g. 18 ga,
// Galvalume) purely from inventory.
function ownerSheetPrice(material, thickness, sheetId) {
  const inv = invActivePrice(material, thickness, sheetId);
  return inv != null ? inv : demoPriceSize(material, thickness, sheetId);
}
// Shown when a material+thickness has neither a market price nor priced inventory. For the owner it
// points at the fix; a customer never hits this path (the Worker sends them to "contact us").
function noPriceMsg(material, thickness) {
  const m = MATERIALS.find((x) => x.id === material);
  const nm = m ? m.name : material;
  return INTERNAL
    ? `No price on file for ${nm} at ${trim(Number(thickness))}″. Add sheets with a purchase price on the Inventory page, or set a market price in Settings.`
    : ((LAYOUT && LAYOUT.noAutoPriceNote) || "We don't have an instant online price for this material and thickness yet. Please contact us for a quote.");
}

// Pick {sheet, price} for a part in demo mode. Returns {error} if nothing fits or is priced.
function chooseSheetDemo(p, fullSheetMin) {
  // Owner may pin the quote to one sheet size; else consider all of the material's machine sheets.
  const sheets = p.forceSheet ? layoutSheets().filter((s) => s.id === p.forceSheet) : layoutSheets();
  const fitting = sheets.filter((s) => fits(p.widthIn, p.heightIn, s));
  if (!fitting.length) {
    const big = sheets.reduce((a, b) => (sheetAreaOf(a) >= sheetAreaOf(b) ? a : b));
    const u = usable(big);
    return { error: `This part is larger than our biggest sheet (usable ${trim(u.w)}×${trim(u.h)}″). Split it or contact us.` };
  }
  const priced = fitting.map((s) => ({ sheet: s, price: ownerSheetPrice(p.material, p.thickness, s.id) })).filter((x) => x.price != null);
  if (!priced.length) return { error: noPriceMsg(p.material, p.thickness) };
  if (!fullSheetMin) {
    const stock = priced.find((x) => x.sheet.id === (LAYOUT.stockSheetId || "24x24"));
    return stock || priced.sort((a, b) => sheetAreaOf(b.sheet) - sheetAreaOf(a.sheet))[0];
  }
  // Custom order: pick the size with the lowest total cost (per-sheet price + weight freight; base
  // is constant across sizes so it doesn't affect the choice).
  const knobs = effKnobs(p.material); // this material's MACHINE profile: per-sheet setup fees + freight knobs (MUST match worker.js, which passes the effective settings)
  const withCost = priced
    .map((x) => {
      const per = partsPerSheet(p, x.sheet);
      const sn = Math.ceil(p.qty / per);
      const cost = per >= 1 ? sn * (x.price + setupFeeForSheet(knobs, x.sheet.id)) + customOrderFreight(p.material, x.sheet, p.thickness, sn, knobs) : Infinity;
      return { ...x, per, cost };
    })
    .filter((x) => x.per >= 1);
  if (!withCost.length) return { error: "Part doesn't fit on the chosen sheet with the tool-holder offset." };
  return orderBySheetPref(withCost, p.sheetPref)[0];
}

// Order priced candidates by the sheet-size preference. pref: "auto" (lowest total cost) |
// "small" (smallest) | "large" (biggest) | a specific sheet id (pin to exactly that size; if it
// isn't among the fitting/priced candidates, fall back to "auto"). MUST match worker.js.
function orderBySheetPref(cands, pref) {
  pref = pref || "auto";
  if (pref !== "auto" && pref !== "small" && pref !== "large") {
    const pinned = cands.find((x) => x.sheet.id === pref);
    if (pinned) return [pinned];
    pref = "auto"; // requested size doesn't fit / has no price → best price
  }
  const c = cands.slice();
  if (pref === "small") c.sort((a, b) => sheetAreaOf(a.sheet) - sheetAreaOf(b.sheet) || a.cost - b.cost);
  else if (pref === "large") c.sort((a, b) => sheetAreaOf(b.sheet) - sheetAreaOf(a.sheet) || a.cost - b.cost);
  else c.sort((a, b) => a.cost - b.cost || sheetAreaOf(a.sheet) - sheetAreaOf(b.sheet));
  return c;
}

// Multi-part: nest the panels to pick {sheet, price, sheetsNeeded}. Honors sheetPref
// (auto = cheapest, small = smallest size, large = biggest size). MUST match worker.js.
function chooseSheetMulti(p, parts, fullSheetMin) {
  const gap = p.nest ? LAYOUT.gapNestIn : LAYOUT.gapPlainIn;
  const rotate = p.nest && LAYOUT.allowRotate;
  const sheets = p.forceSheet ? layoutSheets().filter((s) => s.id === p.forceSheet) : layoutSheets();
  // A sheet is usable only if EVERY panel fits its usable area.
  const fitsAll = (s) => { const u = usable(s); return parts.every((pt) => partFitsUsable(pt.w, pt.h, u.w, u.h, rotate)); };
  const fitting = sheets.filter(fitsAll);
  if (!fitting.length) {
    const big = sheets.reduce((a, b) => (sheetAreaOf(a) >= sheetAreaOf(b) ? a : b));
    const u = usable(big);
    return { error: `One of the panels is larger than our biggest sheet (usable ${trim(u.w)}×${trim(u.h)}″). Split it or contact us.` };
  }
  const priced = fitting.map((s) => ({ sheet: s, price: ownerSheetPrice(p.material, p.thickness, s.id) })).filter((x) => x.price != null);
  if (!priced.length) return { error: noPriceMsg(p.material, p.thickness) };
  const knobs = effKnobs(p.material); // this material's MACHINE profile: per-sheet setup fees + freight knobs (MUST match worker.js, which passes the effective settings)
  const packed = priced.map((x) => {
    const u = usable(x.sheet);
    const r = packSheets(parts, p.qty, u.w, u.h, gap, rotate);
    const cost = isFinite(r.sheetsNeeded)
      ? r.sheetsNeeded * (x.price + setupFeeForSheet(knobs, x.sheet.id)) + customOrderFreight(p.material, x.sheet, p.thickness, r.sheetsNeeded, knobs)
      : Infinity;
    return { ...x, sheetsNeeded: r.sheetsNeeded, cost };
  }).filter((x) => isFinite(x.sheetsNeeded) && x.sheetsNeeded >= 1);
  if (!packed.length) return { error: "Panels don't fit on the chosen sheet with the tool-holder offset." };

  if (!fullSheetMin) {
    // Stock: bill on the stocked size (area-based); nesting doesn't change stock area.
    const stock = packed.find((x) => x.sheet.id === (LAYOUT.stockSheetId || "24x24"));
    return stock || packed.slice().sort((a, b) => sheetAreaOf(b.sheet) - sheetAreaOf(a.sheet))[0];
  }
  return orderBySheetPref(packed, p.sheetPref)[0];
}

// A sheet to draw in the preview (never errors): the size the quote would use, best-effort.
function pickSheetForPreview(material, thickness) {
  const sheets = layoutSheets();
  const fitting = sheets.filter((s) => fits(state.widthIn, state.heightIn, s));
  if (!fitting.length) return sheets.reduce((a, b) => (sheetAreaOf(a) >= sheetAreaOf(b) ? a : b));
  let candidates = fitting;
  if (DEMO) {
    const priced = fitting.filter((s) => ownerSheetPrice(material, thickness, s.id) != null);
    if (priced.length) candidates = priced;
  }
  if (!fullSheetMinFor(material)) {
    const stock = candidates.find((s) => s.id === (LAYOUT.stockSheetId || "24x24"));
    return stock || candidates.slice().sort((a, b) => sheetAreaOf(b) - sheetAreaOf(a))[0];
  }
  // custom: lowest total whole-sheet cost when we know prices, else smallest that fits
  const qty = parseInt(els.qty.value, 10) || 1;
  const pp = { widthIn: state.widthIn, heightIn: state.heightIn, nest: els.nest.checked, qty };
  if (DEMO && candidates.every((s) => ownerSheetPrice(material, thickness, s.id) != null)) {
    const knobs = effKnobs(material); // this material's MACHINE profile (MUST match worker.js)
    const wc = candidates.map((s) => {
      const per = partsPerSheet(pp, s), price = ownerSheetPrice(material, thickness, s.id);
      const sn = Math.ceil(qty / per);
      const cost = per >= 1 ? sn * (price + setupFeeForSheet(knobs, s.id)) + customOrderFreight(material, s, thickness, sn, knobs) : Infinity;
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
  // Customer-only lead capture — reveal it with the quote so a customer can send us their details.
  // The owner already has the QuickBooks export + Save PDF, so it's hidden for them.
  if (els.leadCapture) els.leadCapture.hidden = OWNER;
  // Gate the PDF/JPG buttons for customers until they've sent this quote's request.
  applySaveGate();
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
  // Engraving (interior raster pass) — only when the customer chose to engrave the interior.
  const engraveAmt = q.breakdown.engrave || 0;
  if (els.bdEngraveRow) els.bdEngraveRow.hidden = engraveAmt <= 0;
  if (els.bdEngrave) els.bdEngrave.textContent = money(engraveAmt);
  if (els.bdEngraveNote) {
    // Owners see the minutes, speed and scanned region; customers just the dollar line.
    els.bdEngraveNote.textContent = INTERNAL && q.engraveMinutes > 0
      ? `≈ ${fmtMinutes(q.engraveMinutes)} · ${fmtIn(q.engraveWIn)}×${fmtIn(q.engraveHIn)}″ @ ${q.engraveSpeedMmS} mm/s · ${q.engraveMachineLabel || ""}${q.engraveStartupMin > 0 ? ` (+${fmtMinutes(q.engraveStartupMin)} setup)` : ""}`
      : (q.engraveMachineLabel ? `· ${q.engraveMachineLabel}` : "");
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
    // Engraved on a second machine: say that its setup is in this line.
    if (Number(q.engraveSetupFee) > 0.004)
      els.bdProcessNote.textContent += ` · incl. ${money(q.engraveSetupFee)} setup on the ${q.engraveMachineLabel || "engraver"}`;
  }
  // Only shown when the job came in under the minimum — keeps setup reading at its real rate.
  const topUp = Number(q.breakdown.minTopUp) || 0;
  els.bdMinRow.hidden = topUp <= 0.004;
  els.bdMin.textContent = money(topUp);
  // Owner price override: collapse the itemised lines to a single "Custom quote (as agreed)" row
  // (CSS hides the rest via .overridden); the total row keeps showing the agreed price.
  const overridden = Number(q.overridePrice) > 0;
  if (els.breakdown) els.breakdown.classList.toggle("overridden", overridden);
  if (els.bdOverrideRow) {
    els.bdOverrideRow.hidden = !overridden;
    if (overridden && els.bdOverride) els.bdOverride.textContent = money(q.overridePrice);
  }
  els.bdTotal.textContent = money(q.total);
  const sz = q.sheetW && q.sheetH ? `${trim(q.sheetW)}×${trim(q.sheetH)}` : "sheet";
  els.metaFit.textContent = q.panels > 1
    ? `${q.panels} panels nested`
    : `${q.partsPerSheet} per ${sz} sheet${q.nest ? " (nested)" : ""}${ppsOverride() > 0 ? " · manual count" : ""}`;
  els.metaSheets.textContent = q.fullSheetMin
    ? `${q.sheetsNeeded} × ${sz} sheet${q.sheetsNeeded > 1 ? "s" : ""}`
    : (q.materialAreaSqIn != null ? `≈ ${q.materialAreaSqIn} in² material` : "");
  // Order-minimum note. Owner waiver takes precedence: when this quote was under the minimum and
  // the owner waived it, show an owner-only note recording the dollars given up (accent-styled).
  // Otherwise the normal "minimum applied" note (customers only ever see this branch).
  if (INTERNAL && q.minWaive) {
    els.minNote.hidden = false;
    els.minNote.textContent = `Order minimum waived — ${money(q.minWaived)} given up; quoted at real price.`;
    els.minNote.style.color = "var(--accent)";
    els.minNote.style.fontWeight = "600";
  } else {
    els.minNote.hidden = !q.minChargeApplied;
    els.minNote.textContent = "Minimum order charge applied.";
    els.minNote.style.color = "";
    els.minNote.style.fontWeight = "";
  }
  // Internal-only cost + margin panel (supersedes the old inline freight line).
  if (els.ownerFreight) els.ownerFreight.hidden = true;
  if (els.costBreakdown) {
    const show = INTERNAL && q.cost;
    els.costBreakdown.hidden = !show;
    if (show) {
      const c = q.cost;
      if (els.cbInvNote) {
        if (q.materialFromInventory) {
          const unit = q.inventoryUnitPrice != null ? ` at ${money(q.inventoryUnitPrice)}/sheet` : "";
          els.cbInvNote.textContent = `Material priced from your inventory${unit}${q.inventoryShort ? " — stock was short; the extra used the market/last price" : ""}.`;
          els.cbInvNote.hidden = false;
        } else {
          els.cbInvNote.hidden = true;
        }
      }
      els.cbMaterial.textContent = money(c.material);
      els.cbFreight.textContent = money(c.freight);
      els.cbMachine.textContent = money(c.machine);
      if (els.cbEngraveRow) els.cbEngraveRow.hidden = !(c.engrave > 0);
      if (els.cbEngrave) els.cbEngrave.textContent = money(c.engrave || 0);
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
      // In-stock material is priced by the area actually used (not by the sheet), and the tool
      // always quotes it on the sheet size we keep in stock — so the sheet-size preference can't
      // change the price. Tell the customer why, rather than silently ignoring their choice.
      els.sheetNote.hidden = false;
      els.sheetNote.textContent = `Defaulting to the ${sz}″ size we keep in stock. In-stock material is priced by the area of metal actually used, so the sheet size doesn't change your price.`;
    }
  }
  // Custom-order materials: offer to stock the material for repeat customers.
  if (els.stockOffer) els.stockOffer.hidden = !q.fullSheetMin;
  // Interior-features note: say what happened to the interior when it wasn't simply cut through.
  if (els.engraveNote) {
    const note = interiorNote(q);
    els.engraveNote.hidden = !note;
    els.engraveNote.textContent = note;
  }
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
        !confirm(`Only ${onHand} on hand for this material and size. Remove all ${onHand}? (Can't go below zero.)`)) return;
    // Draw sheets FIFO from the purchase lots (front lot first), so the active price auto-advances.
    const removed = consumeSheets(inv, lineKey(p.material, p.thickness, q.sheetId), qty);
    saveInventory(inv);
    els.invQty.value = 0;
    const left = updateOnHand();
    updateStockReadout(); // keep the under-the-field readout in sync with the deduction
    invStatus(`Removed ${removed} sheet${removed !== 1 ? "s" : ""}. On hand now: ${left}.`, left <= 0 ? "err" : "ok");
  });
}

function invStatus(msg, kind) {
  if (!els.invStatus) return;
  els.invStatus.hidden = false;
  els.invStatus.textContent = msg;
  els.invStatus.classList.toggle("err", kind === "err");
  els.invStatus.classList.toggle("ok", kind === "ok");
}

const showAllSheetsOn = () => !!(els.showAllSheets && els.showAllSheets.checked);
// Show/hide the "Show all sheets" toggle — it's only meaningful for multi-sheet jobs.
function setAllSheetsToggle(nSheets) {
  if (els.allSheetsField) els.allSheetsField.hidden = !(nSheets > 1);
}
// Compose several single-sheet preview SVGs (all the same size) into ONE labelled grid SVG, so the
// "all sheets" view is a single <svg> — which the quote PDF's embedPreview can pick up whole.
function combineSheetSVGs(svgs) {
  if (svgs.length === 1) return svgs[0];
  const parsed = svgs.map((s) => {
    const m = s.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    const open = s.indexOf(">"), close = s.lastIndexOf("</svg>");
    return { w: m ? parseFloat(m[1]) : 0, h: m ? parseFloat(m[2]) : 0, inner: s.slice(open + 1, close) };
  });
  const W = parsed[0].w, H = parsed[0].h, n = parsed.length;
  const cols = n <= 2 ? n : (n <= 6 ? 2 : 3);
  const rows = Math.ceil(n / cols);
  const gap = 16, labelH = 16;
  const cellW = W, cellH = H + labelH;
  const totalW = cols * cellW + (cols - 1) * gap;
  const totalH = rows * cellH + (rows - 1) * gap;
  let body = "";
  parsed.forEach((p, i) => {
    const x = (i % cols) * (cellW + gap), yTop = Math.floor(i / cols) * (cellH + gap);
    body += `<text x="${x + W / 2}" y="${yTop + 12}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--accent)">Sheet ${i + 1}</text>`;
    body += `<g transform="translate(${x},${yTop + labelH})">${p.inner}</g>`;
  });
  return `<svg viewBox="0 0 ${totalW} ${totalH}" width="100%" xmlns="http://www.w3.org/2000/svg" ` +
    `style="max-height:560px;background:var(--sheet-bg);border-radius:6px">${body}</svg>`;
}

// Enlarged, to-scale drawing of the actual part (or all panels in a multi-part file) with the
// measured width/height called out — a scaling sanity check so the customer catches a units/scale
// mishap (e.g. a Vectric artboard or mm↔in mixup) BEFORE ordering. Uses state.shape (the whole-file
// outline) when a file was read, else a plain rectangle for typed dimensions.
function dimensionedPartSVG(shape, wIn, hIn) {
  if (!(wIn > 0) || !(hIn > 0)) return "";
  const PAD = 52, MAXPART = 340;
  const scale = MAXPART / Math.max(wIn, hIn);
  const pw = wIn * scale, ph = hIn * scale;
  const W = pw + PAD * 2, H = ph + PAD * 2;
  const x0 = PAD, y0 = PAD;
  const hasShape = shape && shape.inner && shape.vb && shape.vb.w > 0 && shape.vb.h > 0;
  let body;
  if (hasShape) {
    const vb = `${shape.vb.x} ${shape.vb.y} ${shape.vb.w} ${shape.vb.h}`;
    body =
      `<rect x="${x0}" y="${y0}" width="${pw}" height="${ph}" fill="none" stroke="var(--border)" stroke-width="1" stroke-dasharray="4 3"/>` +
      `<svg x="${x0}" y="${y0}" width="${pw}" height="${ph}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" class="ps-shape">${shape.inner}</svg>`;
  } else {
    body = `<rect x="${x0}" y="${y0}" width="${pw}" height="${ph}" rx="2" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5"/>`;
  }
  const MU = "var(--muted)";
  // width dimension below, with end ticks
  const dy = y0 + ph + 24;
  const widthDim =
    `<line x1="${x0}" y1="${dy}" x2="${x0 + pw}" y2="${dy}" stroke="${MU}" stroke-width="1"/>` +
    `<line x1="${x0}" y1="${dy - 5}" x2="${x0}" y2="${dy + 5}" stroke="${MU}" stroke-width="1"/>` +
    `<line x1="${x0 + pw}" y1="${dy - 5}" x2="${x0 + pw}" y2="${dy + 5}" stroke="${MU}" stroke-width="1"/>` +
    `<text x="${x0 + pw / 2}" y="${dy + 18}" text-anchor="middle" font-size="14" font-weight="700" fill="var(--text)">${fmtIn(wIn)}″ W</text>`;
  // height dimension to the left, label rotated
  const dx = x0 - 24;
  const heightDim =
    `<line x1="${dx}" y1="${y0}" x2="${dx}" y2="${y0 + ph}" stroke="${MU}" stroke-width="1"/>` +
    `<line x1="${dx - 5}" y1="${y0}" x2="${dx + 5}" y2="${y0}" stroke="${MU}" stroke-width="1"/>` +
    `<line x1="${dx - 5}" y1="${y0 + ph}" x2="${dx + 5}" y2="${y0 + ph}" stroke="${MU}" stroke-width="1"/>` +
    `<text x="${dx - 14}" y="${y0 + ph / 2}" text-anchor="middle" font-size="14" font-weight="700" fill="var(--text)" transform="rotate(-90 ${dx - 14} ${y0 + ph / 2})">${fmtIn(hIn)}″ H</text>`;
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" ` +
    `style="max-height:420px;background:var(--sheet-bg);border-radius:6px">` +
    `<style>.ps-shape *{fill:none!important;stroke:var(--accent)!important;stroke-width:1.4px!important;vector-effect:non-scaling-stroke;}</style>` +
    body + widthDim + heightDim + `</svg>`
  );
}
function drawPartCheck() {
  if (!els.partCheck || !els.partView) return;
  const w = state.widthIn, h = state.heightIn;
  if (!(w > 0) || !(h > 0)) { els.partCheck.hidden = true; return; }
  els.partView.innerHTML = dimensionedPartSVG(activeShape(), w, h);
  els.partCheck.hidden = false;
}

function drawPreview() {
  drawPartCheck();
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
  const per = layout.count;
  const nSheets = per > 0 ? Math.max(1, Math.ceil(qty / per)) : 1;
  setAllSheetsToggle(nSheets);
  if (!layout.count) {
    els.nestSvg.innerHTML = `<p class="hint">Part is too big to fit this sheet.</p>`;
  } else if (showAllSheetsOn() && nSheets > 1) {
    // One SVG per sheet: full sheets show `per` parts, the last shows the remainder.
    const svgs = [];
    for (let i = 0; i < nSheets; i++) {
      const onThis = Math.min(per, qty - i * per);
      svgs.push(nestSVG({ ...layout, rects: layout.rects.slice(0, onThis) }, activeShape()));
    }
    els.nestSvg.innerHTML = combineSheetSVGs(svgs);
  } else {
    const shown = Math.max(1, Math.min(qty, layout.count));
    els.nestSvg.innerHTML = nestSVG({ ...layout, rects: layout.rects.slice(0, shown) }, activeShape());
  }
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
    } else if (!layout.count) {
      els.sheetCap.textContent = "";
    } else if (showAllSheetsOn() && nSheets > 1) {
      els.sheetCap.textContent =
        `Showing all ${nSheets} sheets · ${qty} parts, up to ${layout.count} per ${trim(sheet.widthIn)}×${trim(sheet.heightIn)} sheet${tiltNote}`;
    } else {
      els.sheetCap.textContent = qty >= layout.count
        ? `Showing one full sheet · fits ${layout.count} per ${trim(sheet.widthIn)}×${trim(sheet.heightIn)} sheet${nSheets > 1 ? ` · needs ${nSheets} sheets` : ""}${tiltNote}`
        : `Showing your ${qty} part${qty > 1 ? "s" : ""} · up to ${layout.count} fit per sheet${tiltNote}`;
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
    setAllSheetsToggle(0);
    return;
  }
  const nSheets = r.sheets.length;
  setAllSheetsToggle(nSheets);
  const allSheets = showAllSheetsOn() && nSheets > 1;
  els.nestSvg.innerHTML = allSheets
    ? combineSheetSVGs(r.sheets.map((placements) => nestMultiSVG(sheet.widthIn, sheet.heightIn, ho, placements, parts, er)))
    : nestMultiSVG(sheet.widthIn, sheet.heightIn, ho, r.sheets[0], parts, er);
  if (els.sheetCap) {
    const setStr = qty > 1 ? ` × ${qty} sets` : "";
    const more = r.sheetsNeeded > 1 ? (allSheets ? ` (showing all ${r.sheetsNeeded})` : ` (showing sheet 1 of ${r.sheetsNeeded})`) : "";
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
    const priced = cands.filter((s) => ownerSheetPrice(material, thickness, s.id) != null);
    if (priced.length) cands = priced;
  }
  // A specific-size preference pins the preview to that sheet when it fits every panel.
  const pinned = cands.find((s) => s.id === pref);
  if (pinned) return pinned;
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
  const setupNote = [
    q.setupWaive === "all" ? "waived" : (q.setupWaive === "after2" && setupWaived > 0.004 ? `waived beyond 2 sheets · ${money(setupWaived)}` : ""),
    Number(q.engraveSetupFee) > 0.004 ? `incl. ${money(q.engraveSetupFee)} setup on the ${q.engraveMachineLabel || "engraver"}` : "",
  ].filter(Boolean).join(" · ");
  // Owner override: the quote shows a single agreed-price line instead of the itemised breakdown.
  const lines = Number(q.overridePrice) > 0
    ? [{ label: "Custom quote (as agreed)", amount: Number(q.overridePrice) }]
    : [
        { label: "Material", amount: Number(b.material) || 0 },
        { label: "Machine time", amount: Number(b.machine) || 0, note: INTERNAL && q.machineMinutes > 0 ? `≈ ${fmtMinutes(q.machineMinutes)}` : "" },
        { label: "Engraving", amount: Number(b.engrave) || 0, note: [q.engraveMachineLabel || "", INTERNAL && q.engraveMinutes > 0 ? `≈ ${fmtMinutes(q.engraveMinutes)}` : ""].filter(Boolean).join(" · ") },
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
    asCutNote: asCutNote(),
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
    engraveNote: interiorNote(q),
    disclaimer: "Prices are estimates. Final quote confirmed after file review.",
    terms: activeTerms(), // printed in fine detail at the foot of the quote (same source as the T&C modal)
    previewSVG: els.nestSvg ? els.nestSvg.innerHTML : "", // the on-screen sheet-layout picture
    partViewSVG: dimensionedPartSVG(activeShape(), p.widthIn, p.heightIn), // to-scale part w/ W×H dims
  };
}

function safeQuoteName(data) {
  const who = data.customer ? data.customer + "-" : "";
  return ("Quote-" + who + data.quoteNo).replace(/[^\w.-]+/g, "_").slice(0, 60);
}

// PDF: open the SVG full-page in a new tab and trigger the browser's print dialog
// (the user chooses "Save as PDF"). Zero dependencies, prints crisply.
function saveQuotePDF() {
  if (saveGateLocked()) { nudgeSaveGate(); return; }
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
  if (saveGateLocked()) { nudgeSaveGate(); return; }
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

// Email the quote to the shop. Uses a mailto: link — it opens the customer's own email app,
// pre-addressed and pre-filled with the quote, so the message comes FROM the customer (the shop can
// just reply). No backend or email service needed. The recipient is LAYOUT.quoteEmail (admin-set).
function quoteRecipient() { return (LAYOUT && LAYOUT.quoteEmail) || "Paul@ksoldesigns.com"; }
function emailQuote() {
  const data = gatherQuoteData();
  if (!data) return;
  const to = quoteRecipient();
  const ref = data.quoteNo ? ` (ref ${data.quoteNo})` : "";
  const subject = `Quote request — ${data.jobDesc || "laser-cut parts"}${ref}`;
  const lineRows = (data.lines || [])
    .filter((l) => l && l.label && Math.abs(Number(l.amount) || 0) > 0.004)
    .map((l) => `  • ${l.label}: ${money(l.amount)}`);
  const body = [
    "Hi, I'd like to request the following laser-cut quote:",
    "",
    `Material: ${data.jobDesc || ""}`,
    `Part size: ${data.sizeText || ""}`,
    `Quantity: ${data.qty}`,
    ...(lineRows.length ? ["", "Estimate:", ...lineRows] : []),
    `Total: ${money(data.total)}${data.qty > 1 ? ` (${money(data.perPart)} each)` : ""}`,
    data.validUntil ? `Price held through: ${data.validUntil}` : null,
    data.quoteNo ? `Reference #: ${data.quoteNo}` : null,
    "",
    "My details (please fill in):",
    "  Name: ",
    "  Phone: ",
    "  Notes / questions: ",
    "",
    "I can attach my cut file (DXF or SVG) to this email.",
  ].filter((l) => l != null).join("\n");
  // mailto with encoded subject/body (kept well under client URL limits). An anchor click is more
  // reliable than setting window.location for mailto across browsers.
  const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const a = document.createElement("a");
  a.href = href; a.style.display = "none";
  document.body.appendChild(a); a.click(); a.remove();
  // Fallback for browsers with no mail handler (common with webmail on desktop): show the address.
  if (els.emailNote) {
    els.emailNote.hidden = false;
    els.emailNote.textContent = `Opening your email app to ${to}… If nothing happened, email us at ${to} with the details above (you can also Save as PDF/JPG and attach it).`;
  }
}

// Customer lead capture — POST the current quote + the customer's contact details to the Worker,
// which emails the shop (see handleLead in worker.js). Needs BACKEND_URL (always set in the customer
// build). Never destructive: on any failure we point the customer at the shop email so they're never
// stuck. Reuses gatherQuoteData() so the emailed summary matches what's on screen and on the PDF.
function leadStatus(msg, kind) {
  if (!els.leadStatus) return;
  els.leadStatus.hidden = false;
  els.leadStatus.textContent = msg;
  els.leadStatus.className = "hint" + (kind ? " " + kind : "");
}
async function sendLead() {
  const name = (els.leadName && els.leadName.value || "").trim();
  const email = (els.leadEmail && els.leadEmail.value || "").trim();
  const shop = quoteRecipient();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    leadStatus("Please enter your name and a valid email.", "err");
    return;
  }
  const data = gatherQuoteData();
  if (!data) { leadStatus("Please get a quote first.", "err"); return; }
  if (!CONFIG.BACKEND_URL) {
    // Demo/owner build with no Worker — can't email server-side. Fall back to the mailto path.
    leadStatus(`Email isn't wired up in this build. Please email us at ${shop}.`, "err");
    return;
  }

  const payload = {
    action: "lead",
    lead: {
      name, email,
      phone: (els.leadPhone && els.leadPhone.value || "").trim(),
      notes: (els.leadNotes && els.leadNotes.value || "").trim(),
      quote: {
        jobDesc: data.jobDesc, sizeText: data.sizeText, qty: data.qty,
        perPart: data.perPart, total: data.total,
        lines: (data.lines || []).map((l) => ({ label: l.label, amount: l.amount })),
        validUntil: data.validUntil, quoteNo: data.quoteNo,
      },
    },
  };

  els.leadSend.disabled = true;
  leadStatus("Sending…", null);
  try {
    const res = await fetch(CONFIG.BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.emailed) {
      els.leadCapture.classList.add("sent");
      if (els.leadSend) els.leadSend.hidden = true;
      saveUnlocked = true; // they sent this quote's request — release the saved/printable copy
      applySaveGate();
      leadStatus(`Thanks, ${name.split(/\s+/)[0]} — your request is in. Your saved / printable copy `
        + `is unlocked above. If our price works for you, reach out to place an order `
        + `(we accept PayPal & Venmo). Questions? ${shop}.`, "ok");
    } else {
      // Reached the Worker but it didn't send (email not configured yet, or Resend hiccup). Don't
      // leave the customer empty-handed — hand them the shop address.
      leadStatus(`We couldn't send it automatically. Please email us at ${shop} and we'll help right away.`, "err");
      els.leadSend.disabled = false;
    }
  } catch (e) {
    leadStatus(`We couldn't reach our server. Please email us at ${shop}.`, "err");
    els.leadSend.disabled = false;
  }
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
// The on-screen + printed note for a quote whose interior features weren't simply cut through.
function interiorNote(q) {
  const m = cutMode();
  const on = q && q.engraveMachineLabel ? ` on the ${q.engraveMachineLabel}` : "";
  if (m === "engrave") return `Interior features are engraved into the surface${on} (not cut through) — see the Engraving line. The outer profile is cut.`;
  if (m === "outer") return "Interior features not considered in this quote — priced for the cut outer profile (blank) only; engraving handled separately.";
  return "";
}
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
