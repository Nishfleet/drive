// The home page redesign (drive #152). The page is hand-written HTML, so every
// figure it prints before the slider first asks /api/quote is typed into the
// markup. This gate ties each one to the one price source, so a price change
// in src/pricing.js or src/billing.js fails CI until the page moves with it:
//
// 1. The calculator's first view (1 TB) and the receipt print the bill that
//    quoteForStoredTb() returns for 1 TB, the same function /api/quote serves.
// 2. The usual-plan tiers the slider compares against are rivalMonthlyUsd(),
//    and the "you keep" / "you saved" figures are the difference.
// 3. The slider asks /api/quote and does no bill arithmetic of its own.
// 4. The page keeps its accessibility and font contract: one h1, a main
//    landmark, a reduced-motion reset, only the hero face preloaded, and no
//    font request to a third party.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { quoteForStoredTb } from "../src/billing.js";
import { rivalMonthlyUsd } from "../src/pricing.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/site.css", import.meta.url), "utf8");
const script = (html.match(/<script>([\s\S]*?)<\/script>/) ?? [])[1] ?? "";

/** @param {number} usd */
const cents = (usd) => `$${usd.toFixed(2)}`;
/** @param {number} usd */
const whole = (usd) => (Number.isInteger(usd) ? `$${usd}` : cents(usd));

test("the calculator's first view prints the 1 TB quote", () => {
  const quote = quoteForStoredTb(1);
  assert.match(html, /<input id="quote-gb" name="gb" type="range"[^>]*value="1000"/);
  assert.match(html, new RegExp(`<span id="quote-bill">${quote.billUsd}</span>`));
  assert.ok(
    html.includes(
      `1 TB kept all month: ${quote.labels.bill} this month. Flat-plan ceiling: ${quote.labels.ceiling}.`,
    ),
    "the quote note's first line must be the 1 TB quote",
  );
  assert.match(html, new RegExp(`id="bar-us-v">\\${whole(quote.billUsd)}<`));
});

test("the usual-plan tiers are rivalMonthlyUsd, and the saving is the difference", () => {
  const tiers = (html.match(/data-usual-plans="([^"]+)"/) ?? [])[1];
  assert.ok(tiers, "the calculator must carry data-usual-plans");
  for (const pair of tiers.split(",")) {
    const [gb, usd] = pair.split(":").map(Number);
    assert.equal(usd, rivalMonthlyUsd(gb / 1000), `usual plan for ${gb} GB`);
  }
  const ours = quoteForStoredTb(1).billUsd;
  const usual = rivalMonthlyUsd(1);
  assert.match(html, new RegExp(`id="bar-them-v">\\${whole(usual)}<`));
  assert.ok(html.includes(`You keep <em>${whole(usual - ours)}</em> a month.`));
  assert.ok(html.includes(`data-receipt="ours">${cents(ours)}<`));
  assert.ok(html.includes(`data-receipt="usual">${cents(usual)}<`));
  assert.ok(html.includes(`data-receipt="saved">${cents(usual - ours)}<`));
  assert.ok(html.includes(`<b>${cents(ours)}</b>`), "the receipt total is the 1 TB bill");
});

test("the slider asks /api/quote and works out no bill itself", () => {
  assert.match(script, /fetch\(`\/api\/quote\?gb=\$\{gb\}`\)/);
  assert.match(script, /quote\.billUsd/);
  // No price constants in the script: the rate, the ceiling and the slope
  // live in src/pricing.js only.
  for (const constant of [/0\.02\b/, /\b12\s*\*/, /\*\s*8\b/, /\bMath\.max\(\s*12/]) {
    assert.doesNotMatch(script, constant);
  }
});

test("one h1, a main landmark, a skip link and a reduced-motion reset", () => {
  assert.equal(html.match(/<h1[\s>]/g)?.length, 1);
  assert.match(html, /<main id="main">/);
  assert.match(html, /<a class="skip-link" href="#main">/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none !important/);
});

test("the main action is Start 7 days free, to /signin, with the trial terms", () => {
  assert.match(html, /<a class="btn" href="\/signin">Start 7 days free/);
  assert.ok(
    html.includes("$0 for the first 7 days. Card at sign-up. Cancel in the trial and you pay $0."),
  );
});

test("fonts are self-hosted, swap, and only the hero face is preloaded", () => {
  assert.doesNotMatch(html + css, /fonts\.(googleapis|gstatic)\.com/);
  const preloads = html.match(/<link rel="preload"[^>]*>/g) ?? [];
  assert.equal(preloads.length, 1);
  assert.match(preloads[0], /href="\/fonts\/big-shoulders-display-latin-900-normal\.woff2"/);
  const faces = (css.match(/@font-face\s*\{[\s\S]*?\}/g) ?? []).filter((face) =>
    face.includes("url("),
  );
  assert.equal(faces.length, 6);
  for (const face of faces) {
    assert.match(face, /font-display: swap/);
    const file = (face.match(/url\("\/fonts\/([^"]+\.woff2)"\)/) ?? [])[1];
    assert.ok(file, "each face points at a file under /fonts/");
    readFileSync(new URL(`../public/fonts/${file}`, import.meta.url));
  }
  for (const family of ["big-shoulders-display", "instrument-sans", "jetbrains-mono"]) {
    const licence = readFileSync(
      new URL(`../public/fonts/${family}-OFL.txt`, import.meta.url),
      "utf8",
    );
    assert.match(licence, /SIL OPEN FONT LICENSE/i);
  }
});
