// The home page redesign (drive #152). The page is hand-written HTML, so every
// figure it prints before the slider first asks /api/quote is typed into the
// markup. This gate ties each one to the one price source, so a price change
// in core/pricing.js or core/billing.js fails CI until the page moves with it:
//
// 1. The calculator's first view (1 TB) and the receipt print the bill that
//    quoteForStoredTb() returns for 1 TB, the same function /api/quote serves.
// 2. The usual 1 TB plan the slider and the receipt compare against is
//    usualPlanMonthlyUsd(), and the "you keep" / "you saved" figures are the
//    difference (drive#463).
// 3. The slider asks /api/quote and does no bill arithmetic of its own.
// 4. The page's cap and sign-up lines use only PRICE's numbers and
//    DEFAULT_CAP_USD, and no trial or membership survives (drive#463, #464).
// 5. The page keeps its accessibility and font contract: one h1, a main
//    landmark, a reduced-motion reset, only the hero face preloaded, and no
//    font request to a third party.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { monthlyBillForStoredTb, quoteForStoredTb } from "../core/billing.js";
import { DEFAULT_CAP_USD } from "../core/cap-default.js";
import { PREPAID, PRICE, usualPlanMonthlyUsd } from "../core/pricing.js";

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
      `1 TB kept all month: ${quote.labels.bill} this month. Our maximum: ${quote.labels.maximum}. A usual 1 TB plan: ${quote.labels.plan}.`,
    ),
    "the quote note's first line must be the 1 TB quote",
  );
  assert.match(html, new RegExp(`id="bar-us-v">\\${whole(quote.billUsd)}<`));
});

test("the usual plan is usualPlanMonthlyUsd, and the saving is the difference", () => {
  const quote = quoteForStoredTb(1);
  const ours = quote.billUsd;
  const usual = usualPlanMonthlyUsd(1);
  assert.equal(quote.planUsd, usual, "the slider reads the plan from the quote");
  const plan = PRICE.usualPlan;
  assert.ok(
    html.includes(
      `${plan.label} elsewhere: $${plan.monthlyUsd} a month, even billed yearly, then $${plan.extraStepUsd} for each extra ${plan.extraStepTb * 1000}&nbsp;GB.`,
    ),
    "the fine print names the usual plan's own numbers",
  );
  const metered = PRICE.rateUsdPerGbMonth * 1000;
  assert.ok(html.includes(`data-receipt="metered">${cents(metered)}<`));
  assert.ok(html.includes(`<span class="d">${PRICE.maxLine.replace(/\.$/, "")}</span>`));
  assert.equal(monthlyBillForStoredTb(1).maximumUsd, ours, "1 TB sits at the maximum");
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
  assert.match(script, /quote\.planUsd/);
  // No price constants in the script: the rate, the ceiling and the slope
  // live in core/pricing.js only.
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

test("the main action is Get drive, to the waitlist while sign-up is closed, with a true pay-as-you-go line", () => {
  // drive#545: the buttons used to point at /signin, which refuses anyone
  // without an invite. While sign-up is closed the action is the waitlist
  // form on this page, tagged with where the person came from; the plain
  // Sign in link keeps serving invited accounts.
  assert.doesNotMatch(html, /<a class="btn" href="\/signin">Get drive/);
  const buttons =
    html.match(/<a class="btn" href="#waitlist" data-waitlist-source="[^"]+">Get drive/g) ?? [];
  assert.equal(
    buttons.length,
    3,
    `the page carries three Get drive buttons to the waitlist, found ${buttons.length}`,
  );
  for (const source of ["nav", "hero", "footer"]) {
    assert.match(
      html,
      new RegExp(`data-waitlist-source="${source}"`),
      `the ${source} button tags its source`,
    );
  }
  // drive#586: prepaid. The line names the smallest top-up and what 200 GB
  // draws from it.
  const cta = html.match(
    /<p class="cta-note">Add \$(\d+), store 200&nbsp;GB, and it draws \$(\d+) a month\.<\/p>/,
  );
  assert.ok(cta, "the hero carries the top-up-and-200-GB line");
  assert.equal(Number(cta[1]), PREPAID.minTopUpUsd);
  assert.equal(Number(cta[2]), monthlyBillForStoredTb(0.2).billUsd);
  // No trial, no membership, no first-month discount (drive#463).
  for (const stale of [/days free/i, /trial/i, /membership/i, /first month/i, /\$12/, /ceiling/i]) {
    assert.doesNotMatch(html, stale);
  }
  assert.ok(html.includes(PRICE.needCard), "the footer says why a card is needed");
});

test("the home page carries no founding block, and the cap uses the price source's numbers", () => {
  assert.doesNotMatch(html, /founding/i, "founding pricing is removed from the page");
  assert.doesNotMatch(html, /1,000 (paying|members)/i, "never show a count");
  assert.ok(html.includes(`Your spending cap starts at $${DEFAULT_CAP_USD}.`));
  assert.ok(html.includes(`of $${DEFAULT_CAP_USD} cap`));
  assert.ok(html.includes(`The default cap is $${DEFAULT_CAP_USD}.`));
  assert.ok(html.includes(`Past $${DEFAULT_CAP_USD}, writes stop.`));
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
