import assert from "node:assert/strict";
import { test } from "node:test";
import { pdfString, renderReceiptPdf } from "../core/receipt-pdf.js";

const FACTS = Object.freeze({
  number: "SB-000123",
  date: "2026-10-04",
  email: "me@example.com",
  creditText: "$15.00",
  taxText: "$3.00",
  totalText: "$18.00",
  paymentId: "pay_123",
  note: "The balance never expires and pays for storage by the month. Issued by Storagebun; the seller's legal name and postal address are on the support page.",
});

/** @param {Uint8Array} bytes */
const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

test("the PDF opens with the 1.4 header and ends with %%EOF", () => {
  const text = latin1(renderReceiptPdf(FACTS));
  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));
});

test("every cross-reference offset is the byte position of its object", () => {
  const text = latin1(renderReceiptPdf(FACTS));
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
  assert.ok(text.slice(startxref).startsWith("xref\n0 7\n"));
  const entries = [...text.slice(startxref).matchAll(/^(\d{10}) (\d{5}) ([nf]) \n/gm)];
  assert.equal(entries.length, 7);
  assert.equal(entries[0][3], "f");
  entries.slice(1).forEach((entry, index) => {
    assert.ok(
      text.slice(Number(entry[1])).startsWith(`${index + 1} 0 obj\n`),
      `object ${index + 1} sits at offset ${Number(entry[1])}`,
    );
  });
  assert.match(text, /trailer\n<< \/Size 7 \/Root 1 0 R >>/);
});

test("the stream length is the number of bytes between stream and endstream", () => {
  const text = latin1(renderReceiptPdf(FACTS));
  const length = Number(/\/Length (\d+) >>\nstream\n/.exec(text)?.[1]);
  const body = text.slice(text.indexOf("stream\n") + 7, text.indexOf("\nendstream"));
  assert.equal(body.length, length);
});

test("the page is Helvetica and carries the receipt number, amounts and reference", () => {
  const text = latin1(renderReceiptPdf(FACTS));
  assert.match(text, /\/BaseFont \/Helvetica /);
  assert.match(text, /\/Count 1 /);
  for (const shown of [
    "(storagebun)",
    "(Receipt SB-000123)",
    "(2026-10-04  me@example.com)",
    "(Balance top-up)",
    "($15.00)",
    "(Tax added at checkout)",
    "($3.00)",
    "(Total paid)",
    "($18.00)",
    "(Payment reference: pay_123)",
    "(The balance never expires and pays for storage by the month.",
  ]) {
    assert.ok(text.includes(shown), `the page shows ${shown}`);
  }
  assert.doesNotMatch(text, /Print/);
});

test("with no tax and no reference those rows are left out", () => {
  const text = latin1(renderReceiptPdf({ ...FACTS, taxText: null, paymentId: null, email: null }));
  assert.doesNotMatch(text, /Tax added/);
  assert.doesNotMatch(text, /Payment reference/);
  assert.ok(text.includes("(2026-10-04)"));
});

test("parentheses and backslashes in a string are escaped, and other text is kept printable", () => {
  assert.equal(pdfString("a(b)c\\d"), "(a\\(b\\)c\\\\d)");
  assert.equal(pdfString("line\nbreak☃"), "(line?break?)");
  const text = latin1(renderReceiptPdf({ ...FACTS, email: "x)(\\@e.co" }));
  assert.ok(text.includes("(2026-10-04  x\\)\\(\\\\@e.co)"));
});

test("the offsets stay right when the text has Latin-1 characters beyond ASCII", () => {
  const bytes = renderReceiptPdf({ ...FACTS, email: "café@e.co" });
  const text = latin1(bytes);
  const startxref = Number(/startxref\n(\d+)\n/.exec(text)?.[1]);
  assert.ok(text.slice(startxref).startsWith("xref"));
  assert.equal(bytes.length, text.length);
});
