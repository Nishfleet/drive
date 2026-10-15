import { escapeHtml } from "./escape-html.js";
import { json } from "./http.js";
import { failureMessage } from "./messages.js";
import { renderReceiptPdf } from "./receipt-pdf.js";
import { unauthorizedResponse } from "./status.js";
import { formatCents } from "./topup.js";

export const RECEIPT_ENDPOINT = "/api/receipts";

/**
 * The receipt number a person quotes to support: stable, from the ledger id.
 * @param {number} ledgerId
 * @returns {string}
 */
export function receiptNumber(ledgerId) {
  return `SB-${String(ledgerId).padStart(6, "0")}`;
}

/**
 * @typedef {object} Receipt
 * @property {number} id the ledger line
 * @property {number} creditCents the balance added
 * @property {number|null} paidCents what the provider took, tax included
 * @property {string|null} paymentId the provider's payment id
 * @property {number} createdAt epoch milliseconds
 */

/**
 * One top-up of one account, or null when the id is not a top-up of this
 * account (another account's, a usage draw, or nothing).
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number} ledgerId
 * @returns {Promise<Receipt|null>}
 */
async function receiptFor(db, accountId, ledgerId) {
  const row = /** @type {Record<string, unknown>|null} */ (
    await db
      .prepare(
        `SELECT id, amount_cents, provider_amount_cents, provider_payment_id, created_at
           FROM balance_ledger
          WHERE id = ?1 AND account_id = ?2 AND kind = 'topup'`,
      )
      .bind(ledgerId, accountId)
      .first()
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    creditCents: Number(row.amount_cents),
    paidCents: row.provider_amount_cents === null ? null : Number(row.provider_amount_cents),
    paymentId: row.provider_payment_id === null ? null : String(row.provider_payment_id),
    createdAt: Number(row.created_at),
  };
}

const STYLE = `
:root { color-scheme: light dark; --paper: #fbf7f0; --ink: #2a241d; --faint: #5a5145; --rule: #d8cdb9; --accent: #b83200; }
@media (prefers-color-scheme: dark) { :root { --paper: #171410; --ink: #f3ecdf; --faint: #b8ae9b; --rule: #3b342a; --accent: #ff8e63; } }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 "Instrument Sans", "Helvetica Neue", Arial, sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 48px 16px; }
h1 { font-size: 28px; margin: 0 0 4px; }
.brand { color: var(--accent); font-weight: 700; letter-spacing: .02em; }
.meta { color: var(--faint); margin: 0 0 32px; }
table { width: 100%; border-collapse: collapse; margin: 0 0 24px; }
th, td { text-align: left; padding: 10px 0; border-bottom: 1px solid var(--rule); }
td:last-child, th:last-child { text-align: right; font-variant-numeric: tabular-nums; }
tr.total td { font-weight: 700; border-bottom: 0; }
.note { color: var(--faint); font-size: 14px; }
@media print { :root { --paper: #fff; --ink: #000; --faint: #444; --rule: #bbb; --accent: #000; } main { padding: 0; } }
`;

const PDF_ID = /^([1-9][0-9]{0,12})\.pdf$/;
const SECURITY_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
  "x-content-type-options": "nosniff",
});

/**
 * The numbers a receipt shows, one place for the page and the PDF.
 * @param {Receipt} receipt
 * @param {{email: string|null}} account
 * @returns {import("./receipt-pdf.js").ReceiptFacts}
 */
function receiptFacts(receipt, account) {
  const taxCents =
    receipt.paidCents !== null && receipt.paidCents > receipt.creditCents
      ? receipt.paidCents - receipt.creditCents
      : 0;
  return {
    number: receiptNumber(receipt.id),
    date: new Date(receipt.createdAt).toISOString().slice(0, 10),
    email: account.email,
    creditText: formatCents(receipt.creditCents),
    taxText: taxCents > 0 ? formatCents(taxCents) : null,
    totalText: formatCents(receipt.paidCents ?? receipt.creditCents),
    paymentId: receipt.paymentId,
    note: "The balance never expires and pays for storage by the month. Issued by Storagebun; the seller's legal name and postal address are on the support page.",
  };
}

/**
 * The receipt page.
 * @param {Receipt} receipt
 * @param {{email: string|null}} account
 * @returns {string}
 */
export function renderReceipt(receipt, account) {
  const facts = receiptFacts(receipt, account);
  const number = facts.number;
  const taxRow =
    facts.taxText === null
      ? ""
      : `<tr><td>Tax added at checkout</td><td>${escapeHtml(facts.taxText)}</td></tr>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Receipt ${escapeHtml(number)} - Storagebun</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="brand">storagebun</p>
<h1>Receipt ${escapeHtml(number)}</h1>
<p class="meta">${escapeHtml(facts.date)}${facts.email ? ` &middot; ${escapeHtml(facts.email)}` : ""}</p>
<table>
<thead><tr><th scope="col">Item</th><th scope="col">Amount</th></tr></thead>
<tbody>
<tr><td>Balance top-up</td><td>${escapeHtml(facts.creditText)}</td></tr>
${taxRow}
<tr class="total"><td>Total paid</td><td>${escapeHtml(facts.totalText)}</td></tr>
</tbody>
</table>
${receipt.paymentId ? `<p class="note">Payment reference: ${escapeHtml(receipt.paymentId)}</p>` : ""}
<p class="note">The balance never expires and pays for storage by the month. Issued by Storagebun; the seller's legal name and postal address are on the <a href="/support">support page</a>. To save a copy as a PDF, use your browser's Print and choose Save as PDF.</p>
</main>
</body>
</html>
`;
}

/**
 * GET /api/receipts/:id.
 * @param {Request} request
 * @param {{id: string, email: string|null}|null} account
 * @param {D1Database|undefined} db
 * @param {string} idText the path segment: the ledger id, with .pdf for the PDF copy
 * @returns {Promise<Response>}
 */
export async function handleReceiptRequest(request, account, db, idText) {
  if (!account) return unauthorizedResponse();
  if (request.method !== "GET") {
    return json({ error: "Method not allowed." }, 405);
  }
  if (!db) {
    return json({ error: failureMessage("drive-not-configured") }, 503);
  }
  const pdf = PDF_ID.exec(idText);
  const idPart = pdf ? pdf[1] : idText;
  const id = /^[1-9][0-9]{0,12}$/.test(idPart) ? Number(idPart) : 0;
  const receipt = id > 0 ? await receiptFor(db, account.id, id) : null;
  if (!receipt) {
    return json({ error: "No receipt with that number on this account." }, 404);
  }
  if (pdf) {
    const facts = receiptFacts(receipt, account);
    return new Response(renderReceiptPdf(facts), {
      headers: {
        ...SECURITY_HEADERS,
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${facts.number}.pdf"`,
      },
    });
  }
  return new Response(renderReceipt(receipt, account), {
    headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}
