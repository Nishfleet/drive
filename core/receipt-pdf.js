const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LEFT = 72;
const AMOUNT_X = 400;
const NOTE_COLUMNS = 88;

/**
 * @typedef {object} ReceiptFacts
 * @property {string} number the receipt number, SB-000123
 * @property {string} date YYYY-MM-DD
 * @property {string|null} email
 * @property {string} creditText the balance added, as money
 * @property {string|null} taxText the tax added at checkout, or null when none
 * @property {string} totalText what was paid, as money
 * @property {string|null} paymentId the provider's payment id
 * @property {string} note the footnote
 */

/**
 * A PDF string literal: only printable Latin-1 survives (the standard fonts
 * are WinAnsi), and the three characters a literal treats specially are
 * escaped.
 * @param {string} text
 * @returns {string}
 */
export function pdfString(text) {
  const safe = Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 63;
    return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) ? char : "?";
  }).join("");
  return `(${safe.replace(/[\\()]/g, (char) => `\\${char}`)})`;
}

/**
 * @param {string} text
 * @param {number} columns
 * @returns {string[]}
 */
function wrap(text, columns) {
  return text.split(" ").reduce((/** @type {string[]} */ lines, word) => {
    const last = lines.length - 1;
    return last >= 0 && lines[last].length + 1 + word.length <= columns
      ? [...lines.slice(0, last), `${lines[last]} ${word}`]
      : [...lines, word];
  }, []);
}

/**
 * @param {string} font F1 regular, F2 bold
 * @param {number} size
 * @param {number} x
 * @param {number} y
 * @param {string} text
 * @returns {string}
 */
function textAt(font, size, x, y, text) {
  return `BT /${font} ${size} Tf ${x} ${y} Td ${pdfString(text)} Tj ET`;
}

/**
 * @param {ReceiptFacts} facts
 * @returns {string}
 */
function pageContent(facts) {
  const rows = [
    ["Balance top-up", facts.creditText, "F1"],
    ...(facts.taxText === null ? [] : [["Tax added at checkout", facts.taxText, "F1"]]),
    ["Total paid", facts.totalText, "F2"],
  ];
  const rowTop = 600;
  const noteTop = rowTop - rows.length * 24 - (facts.paymentId ? 56 : 32);
  return [
    textAt("F2", 14, LEFT, 720, "storagebun"),
    textAt("F2", 22, LEFT, 686, `Receipt ${facts.number}`),
    textAt("F1", 11, LEFT, 660, facts.email ? `${facts.date}  ${facts.email}` : facts.date),
    textAt("F2", 11, LEFT, rowTop + 24, "Item"),
    textAt("F2", 11, AMOUNT_X, rowTop + 24, "Amount"),
    ...rows.flatMap(([label, amount, font], index) => [
      textAt(font, 12, LEFT, rowTop - index * 24, label),
      textAt(font, 12, AMOUNT_X, rowTop - index * 24, amount),
    ]),
    ...(facts.paymentId
      ? [
          textAt(
            "F1",
            10,
            LEFT,
            rowTop - rows.length * 24 - 8,
            `Payment reference: ${facts.paymentId}`,
          ),
        ]
      : []),
    ...wrap(facts.note, NOTE_COLUMNS).map((line, index) =>
      textAt("F1", 10, LEFT, noteTop - index * 14, line),
    ),
  ].join("\n");
}

/**
 * @param {string} text latin1 text
 * @returns {Uint8Array<ArrayBuffer>}
 */
function latin1Bytes(text) {
  return Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
}

/**
 * One receipt as a single-page PDF 1.4, set in the standard Helvetica fonts
 * so nothing is embedded. The cross-reference table is computed from the byte
 * position of each object.
 * @param {ReceiptFacts} facts
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function renderReceiptPdf(facts) {
  const content = pageContent(facts);
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const objects = bodies.reduce(
    (/** @type {{text: string, offsets: number[]}} */ built, body, index) => {
      const object = `${index + 1} 0 obj\n${body}\nendobj\n`;
      return {
        text: built.text + object,
        offsets: [...built.offsets, header.length + built.text.length],
      };
    },
    { text: "", offsets: [] },
  );
  const xrefAt = header.length + objects.text.length;
  const xref = [
    `xref\n0 ${bodies.length + 1}\n`,
    "0000000000 65535 f \n",
    ...objects.offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
  ].join("");
  const trailer = `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return latin1Bytes(header + objects.text + xref + trailer);
}
