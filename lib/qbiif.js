// qbiif.js — build a QuickBooks Desktop invoice .IIF from a MetalQuote quote.
//
// QuickBooks Desktop imports transactions via IIF (tab-delimited text):
//   File > Utilities > Import > IIF Files.
// We emit ONE invoice per file. The four customer-facing breakdown lines
// (Material / Machine time / Gas surcharge / Setup) become four invoice lines
// (SPL rows) mapped to four QuickBooks Items; QuickBooks converts an accepted
// quote straight into a posted invoice with no re-entry.
//
// IIF invoice sign rule (this is what keeps QB from rejecting it as "out of balance"):
//   TRNS AMOUNT  = +total          -> debit to Accounts Receivable (customer owes)
//   each SPL     = -lineAmount     -> credit to income
//   TRNS + sum(SPL) MUST equal 0.
// The MetalQuote breakdown is built so material+machine+gas+processing === total,
// so the file balances by construction; we still add a penny-rounding guard.

const NL = "\r\n"; // QuickBooks is happiest with CRLF line endings.

// IIF is tab-delimited, so tabs and newlines inside a field would break the row.
// Quote the field and strip control chars if any sneak in.
function iifField(v) {
  const s = String(v == null ? "" : v).replace(/[\t\r\n]+/g, " ").trim();
  return /["]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function row(cells) {
  return cells.map(iifField).join("\t");
}

function money(n) {
  return (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2);
}

// MM/DD/YYYY — the format QuickBooks Desktop expects in IIF regardless of locale.
export function iifDate(d = new Date()) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

// Default mapping. `incomeAccount` / `arAccount` and the four item names must match
// (or will be auto-created in) the customer's QuickBooks chart of accounts + item list.
export const DEFAULT_QB = {
  arAccount: "Accounts Receivable",
  incomeAccount: "Sales",
  items: {
    material: "Laser Cutting - Material",
    machine: "Laser Cutting - Machine Time",
    gas: "Laser Cutting - Gas Surcharge",
    setup: "Laser Cutting - Setup & Handling",
    minTopUp: "Laser Cutting - Minimum Order",
  },
};

/**
 * Build the .IIF text for one invoice.
 * @param {object} q     quote object (needs q.total and q.breakdown.{material,machine,gas,processing})
 * @param {object} meta  { customer, docNum, date?, memo?, qb? }  qb overrides DEFAULT_QB
 * @returns {string} IIF file contents
 */
export function buildInvoiceIIF(q, meta = {}) {
  const qb = { ...DEFAULT_QB, ...(meta.qb || {}), items: { ...DEFAULT_QB.items, ...((meta.qb || {}).items || {}) } };
  const customer = (meta.customer || "").trim();
  if (!customer) throw new Error("Customer name is required for a QuickBooks invoice.");

  const date = meta.date || iifDate();
  const docNum = (meta.docNum || "").trim();
  const memo = (meta.memo || "").trim();
  const b = q.breakdown || {};

  // Assemble the item lines, skipping any that are zero (e.g. gas surcharge on thin cuts).
  const lines = [
    { item: qb.items.material, amount: Number(b.material) || 0, desc: "Material" },
    { item: qb.items.machine, amount: Number(b.machine) || 0, desc: "Machine time" },
    { item: qb.items.gas, amount: Number(b.gas) || 0, desc: "Gas surcharge" },
    { item: qb.items.setup, amount: Number(b.processing) || 0, desc: "Setup & handling" },
    // Must be mapped: an unmapped line would be dropped here and the balance guard below would
    // silently fold it into setup — the very distortion this line exists to prevent.
    { item: qb.items.minTopUp, amount: Number(b.minTopUp) || 0, desc: "Minimum order top-up" },
  ].filter((l) => Math.abs(l.amount) > 0.004);

  // Balance guard: force the split total to equal the invoice total to the penny.
  const total = Math.round((Number(q.total) + Number.EPSILON) * 100) / 100;
  const splitSum = lines.reduce((s, l) => s + l.amount, 0);
  const drift = Math.round((total - splitSum) * 100) / 100;
  if (Math.abs(drift) >= 0.005 && lines.length) {
    lines[lines.length - 1].amount = Math.round((lines[lines.length - 1].amount + drift) * 100) / 100;
  }

  const out = [];
  // Headers (define the columns). INVITEM belongs on SPL only, never on TRNS.
  out.push(row(["!TRNS", "TRNSTYPE", "DATE", "ACCNT", "NAME", "AMOUNT", "DOCNUM", "MEMO"]));
  out.push(row(["!SPL", "TRNSTYPE", "DATE", "ACCNT", "NAME", "AMOUNT", "INVITEM", "MEMO"]));
  out.push(row(["!ENDTRNS"]));
  // Transaction: positive total to Accounts Receivable against the customer.
  out.push(row(["TRNS", "INVOICE", date, qb.arAccount, customer, money(total), docNum, memo]));
  // Splits: negative amounts to income, one per item line.
  for (const l of lines) {
    out.push(row(["SPL", "INVOICE", date, qb.incomeAccount, customer, money(-l.amount), l.item, l.desc]));
  }
  out.push(row(["ENDTRNS"]));
  return out.join(NL) + NL;
}
