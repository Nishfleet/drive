// The pricing copy is a decision, not a suggestion, so it is pinned here: a
// later run cannot quietly reword the headline, add a per-minute price, bring
// back a minimum, or reintroduce "unlimited" without failing a test.
//
// drive#463 (Nish 2026-10-04): pay only for what you store.
//
//     charge = min(2¢ x avg GB, MAX_USD_PER_TB x max(1, avg TB))
//
// The numbers and every sentence rendered from them live in core/pricing.js
// (PRICE), the one price source, and the bill is core/billing.js's
// monthBillCents(). The expectations here are built from that config and that
// function, so page copy that drifts from either fails this file. core/seo.js
// builds the meta tags and the JSON-LD from the same PRICE, so the copy, the
// tags and llms.txt cannot disagree.
//
// MAX_USD_PER_TB is the one value Nish may move. The test "the copy and the
// bill both follow the maximum at 8, 10 and 12" proves every sentence and the
// bill move with it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { billingConfigFor, monthlyBillForStoredTb } from "../core/billing.js";
import { buildPrice, PREPAID, PRICE, usualPlanMonthlyUsd } from "../core/pricing.js";
import { BILLING, SITE, softwareApplicationLd } from "../core/seo.js";
import { markerValues } from "../src/docs.js";
import { RIVAL_PRODUCT } from "./rival-terms.mjs";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const llms = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");
// HTML entities the spec's plain-text copy is written with, folded so a test
// asserts on the words a reader sees, not on the markup.
const words = page
  .replaceAll("&nbsp;", " ")
  .replaceAll("&middot;", "-")
  .replaceAll("&times;", "×")
  .replaceAll("&rarr;", "→")
  .replaceAll("&amp;", "&");

// The bill for a size in TB kept all month: core/billing.js's monthBillCents(),
// the one function the invoice, the page and the cap all read.
const billForAllMonth = monthlyBillForStoredTb;

// Dollars, the way the page writes them: no cents where there are none.
/** @param {number} amount */
function usd(amount) {
  return `$${amount.toFixed(2).replace(/\.00$/, "")}`;
}

// Every public surface the price words may appear on. The ban tests below
// read all of them, so a banned word cannot hide on a page nobody checked.
const PUBLIC_FILES = [
  "public/index.html",
  "public/llms.txt",
  "public/og-card.html",
  "public/signin.html",
  "public/starter.html",
  "docs-site/pricing.md",
  "docs-site/how-it-works.md",
  "docs-site/limits.md",
  "docs-site/quickstart.md",
  "docs-site/index.md",
];
/** @type {Array<[string, string]>} */
const publicTexts = PUBLIC_FILES.map((file) => [
  file,
  // A docs marker ({{NO_PLANS}}) renders from PRICE, which the tests above
  // check, so the marker's own name is not copy.
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    .replaceAll("&nbsp;", " ")
    .replace(/\{\{[A-Z_]+\}\}/g, ""),
]);

test("the headline is the issue's sentence, from config", () => {
  // drive#586: prepaid. The lead names the smallest top-up from PREPAID, so
  // the headline and the checkout cannot disagree on it.
  assert.equal(
    PRICE.headline,
    "Add $10 or more. Pay 2 cents per GB from your balance. Never more than $10 per TB.",
  );
  assert.equal(PRICE.leadLine, `Add $${PREPAID.minTopUpUsd} or more.`);
  assert.equal(PRICE.headline, `${PRICE.leadLine} ${PRICE.rateLine} ${PRICE.maxLine}`);
  // The page sets the sentence as three lines in the h1, in this order.
  const h1 = words.slice(words.indexOf("<h1"), words.indexOf("</h1>"));
  for (const [className, line] of [
    ["lead", PRICE.leadLine],
    ["amount", PRICE.rateLine],
    ["unit", PRICE.maxLine],
  ]) {
    assert.ok(
      h1.includes(`<span class="${className}">${line}</span>`),
      `the h1 must carry the .${className} line "${line}"`,
    );
  }
  assert.ok(h1.indexOf(PRICE.leadLine) < h1.indexOf(PRICE.rateLine));
  assert.ok(h1.indexOf(PRICE.rateLine) < h1.indexOf(PRICE.maxLine));
});

test("no plans and a balance that never expires sit under the headline", () => {
  const headline = words.indexOf("</h1>");
  const noPlans = words.indexOf(PRICE.noPlansLine);
  assert.equal(PRICE.noPlansLine, "No plans. Your balance never expires.");
  assert.ok(noPlans > headline, "the no-plans line must follow the headline");
});

test("the card line says the first top-up opens storage, with no old minimum", () => {
  // drive#586: a card is needed, and the first $10 top-up opens storage. The
  // old "There is no minimum" claim is false once a top-up is $10 or more.
  assert.ok(PRICE.needCard.includes(`Your first $${PREPAID.minTopUpUsd} top-up opens storage.`));
  assert.doesNotMatch(PRICE.needCard, /no minimum/i);
  assert.match(PRICE.needCard, /no free tier/);
});

test("the trash billing rule is stated on the landing page and the pricing doc (drive#521)", () => {
  // The sentence is a decision ("stop paying for what you delete" is THIS),
  // so it is pinned here word for word, and both surfaces must carry it.
  assert.equal(
    PRICE.trashLine,
    "A deleted file stops counting as soon as it lands in Recently deleted. After 30 days it is removed for good.",
  );
  assert.ok(
    words.includes(PRICE.trashLine),
    "public/index.html must carry the trash billing line verbatim",
  );
  // The doc carries it through the {{TRASH_BILLING}} marker, so the marker's
  // presence is the assertion: the rendered page builds it from PRICE.
  assert.ok(
    readFileSync(new URL("../docs-site/pricing.md", import.meta.url), "utf8").includes(
      "{{TRASH_BILLING}}",
    ),
    "docs-site/pricing.md must place the {{TRASH_BILLING}} marker",
  );
  // The marker must actually resolve, or the built page would print the
  // marker's name instead of the rule.
  const values = markerValues();
  assert.equal(values.TRASH_BILLING, PRICE.trashLine);
});

test("the formula edges, as the bill computes them", () => {
  // [TB, $], kept all month.
  for (const [tb, dollars] of [
    [0, 0],
    [0.001, 0.02],
    [0.499, 9.98],
    [0.5, 10],
    [1, 10],
    [1.5, 15],
    [4, 40],
  ]) {
    assert.equal(billForAllMonth(tb).billUsd, dollars, `${tb} TB bills $${dollars}`);
  }
  assert.equal(billForAllMonth(0.2).billUsd, 4, "200 GB is $4");
  assert.equal(billForAllMonth(3).billUsd, 30, "3 TB is $30");
});

test("the copy and the bill both follow the maximum at 8, 10 and 12", () => {
  // MAX_USD_PER_TB is one config value. Build the whole price at each value
  // and check every sentence names it, nothing names a stale one, and the bill
  // computed from the same price charges it.
  for (const max of [8, 10, 12]) {
    const price = buildPrice({ maxUsdPerTb: max });
    const config = billingConfigFor(price);
    const reaches = (max * 100) / price.rateCents;
    assert.equal(price.maxUsdPerTb, max);
    assert.equal("founding" in price, false, "there is one price, no second tier");
    assert.equal(price.reachesMaxGb, reaches);
    assert.equal(price.maxLine, `Never more than $${max} per TB.`);
    assert.ok(price.headline.endsWith(`Never more than $${max} per TB.`));
    assert.ok(price.titleLine.endsWith(`never more than $${max} per TB`));
    assert.ok(price.rule.includes(`until the bill reaches $${max}, at ${reaches} GB`));
    assert.ok(price.rule.includes(`never pay more than $${max} for each TB`));
    assert.equal(price.examples[2].label, `${reaches} GB to 1 TB`);
    // No sentence keeps a number from another maximum.
    const sentences = Object.values(price).filter((value) => typeof value === "string");
    for (const other of [8, 10, 12].filter((n) => n !== max)) {
      for (const sentence of sentences) {
        assert.equal(
          sentence.includes(`$${other} per TB`),
          false,
          `at ${max}, "${sentence}" must not name $${other} per TB`,
        );
      }
    }
    // The bill reads the same config value.
    const bill = (/** @type {number} */ tb) => monthlyBillForStoredTb(tb, config).billUsd;
    assert.equal(bill(1), max, `1 TB is $${max}`);
    assert.equal(bill(4), 4 * max, `4 TB is $${4 * max}`);
    assert.equal(bill(1.5), 1.5 * max);
    assert.equal(bill(reaches / 1000), max, "the rate reaches the maximum where the copy says");
    assert.equal(bill(0.2), 4, "the rate does not move with the maximum");
  }
  // A maximum that is not whole dollars is refused rather than rounded into
  // copy the bill does not charge.
  assert.throws(() => buildPrice({ maxUsdPerTb: 9.5 }), /whole number of dollars/);
});

test("the example rows are the bill's figures, with the usual plan and the saving", () => {
  assert.deepEqual(
    PRICE.examples.map((row) => row.label),
    ["50 GB", "200 GB", "500 GB to 1 TB", "3 TB"],
  );
  for (const row of PRICE.examples) {
    const sizes = row.toGb === undefined ? [row.gb] : [row.gb, (row.gb + row.toGb) / 2, row.toGb];
    const bills = sizes.map((gb) => billForAllMonth(gb / 1000).billUsd);
    assert.ok(
      bills.every((bill) => bill === bills[0]),
      `the ${row.label} row must be one price across its range`,
    );
    const top = (row.toGb ?? row.gb) / 1000;
    const plan = usualPlanMonthlyUsd(top);
    const bill = bills[0];
    assert.equal(
      exampleSentence(`${row.label} kept all month`),
      `you pay ${usd(bill)}. A usual 1 TB plan costs ${usd(plan)}, so you save ${usd(plan - bill)}.`,
    );
    assert.ok(
      llms.includes(
        `- ${row.label} = ${usd(bill)} (a usual 1 TB plan: ${usd(plan)}, so you save ${usd(plan - bill)})`,
      ),
      `llms.txt must quote the ${row.label} row`,
    );
  }
  // The issue's own figures, typed once here as the acceptance check.
  assert.match(words, /50 GB kept all month[\s\S]{0,80}?\$1</);
  assert.match(words, /200 GB kept all month[\s\S]{0,80}?\$4</);
  assert.match(words, /500 GB to 1 TB kept all month[\s\S]{0,80}?\$10</);
  assert.match(words, /3 TB kept all month[\s\S]{0,80}?\$30</);
  assert.doesNotMatch(section("examples"), /→/);
  assert.equal(page.includes("&rarr;"), false, "the page must not carry an arrow entity");
});

test("the usual 1 TB plan is $15, then $6 for each extra 500 GB", () => {
  assert.equal(usualPlanMonthlyUsd(0), 15);
  assert.equal(usualPlanMonthlyUsd(1), 15);
  assert.equal(usualPlanMonthlyUsd(1.1), 21, "part of a step is a whole step");
  assert.equal(usualPlanMonthlyUsd(1.5), 21);
  assert.equal(usualPlanMonthlyUsd(2), 27);
  assert.equal(usualPlanMonthlyUsd(3), 39);
  assert.equal(PRICE.usualPlan.label, "a usual 1 TB plan");
});

test("the strip's 60%-full drive bills what the page prints", () => {
  assert.equal(billForAllMonth(0.6).billUsd, 10);
  assert.match(words, /60% full - \$10</);
  assert.ok(stripCaption().includes("A 1 TB drive kept 60% full bills $10 a month."));
  assert.ok(llms.includes("A 1 TB drive kept 60% full bills $10 a month."));
  assert.ok(examplesNote().includes(PRICE.rule), "the examples note must carry the rule");
});

test("the retired price words are gone from every public surface", () => {
  for (const [file, text] of publicTexts) {
    // The rival is named only by the neutral label (drive#463).
    assert.doesNotMatch(text, RIVAL_PRODUCT, `${file} must not name the rival`);
    // "minimum" only in "no minimum".
    for (const match of text.matchAll(/minimum/gi)) {
      const before = text.slice(Math.max(0, match.index - 3), match.index).toLowerCase();
      assert.equal(before, "no ", `${file} may write "minimum" only as "no minimum"`);
    }
    // The membership, the first-month half price and the old ceiling.
    for (const stale of [
      /membership/i,
      /first month/i,
      /\$12 a TB/,
      /\$8 a TB/,
      /\$5 a month/,
      /ceiling/i,
      /\$20 (per|a) TB/,
      // Founding pricing was removed (drive#586): every account pays one price.
      /founding/i,
    ]) {
      assert.doesNotMatch(text, stale, `${file} must not carry ${stale}`);
    }
    // Never a per-minute price.
    assert.doesNotMatch(text, /[$¢]\s?[\d.,]*\s*(\/|per\s|a\s)\s*min/i, `${file} per-minute price`);
    assert.doesNotMatch(text, /\d\s*¢\s*(\/|per\s|a\s)\s*min/i, `${file} per-minute price`);
  }
});

test("the per-save hour the copy states is the meter's own floor", () => {
  // drive#535, finish line 2. The pricing pages say billing is "counted by the
  // minute", and a customer who reads that and saves a file five times inside
  // one hour is billed five hours: every saved version is booked for at least
  // the meter's MINIMUM_MINUTES_PER_VERSION. The sentence is the promise that
  // makes the minute-counting copy honest, so its hour and the meter's floor
  // are pinned together here - if the floor ever moves, this fails rather than
  // shipping a page that promises an hour and bills two.
  const meter = readFileSync(new URL("../core/meter.js", import.meta.url), "utf8");
  const floor = meter.match(/MINIMUM_MINUTES_PER_VERSION\s*=\s*(\d+)/);
  assert.ok(floor, "src/meter.js must state its per-version floor as a number");
  assert.equal(Number(floor[1]), 60, "the meter's smallest booking is the hour the copy states");
  assert.match(PRICE.versionMinimumLine, /at least one hour/);
  assert.match(PRICE.versionMinimumLine, /billed for at least/);
  // The pages that name the minute carry the marker, so the sentence renders
  // with the rest of the price words; llms.txt is a hand-written surface and
  // carries it verbatim. The remaining static pages (index, og-card, signin,
  // starter) carry the headline and the rule, and this gate's other tests hold
  // them to that. Read from the source: `publicTexts` strips {{MARKER}}s on
  // purpose, because a marker's name is not copy.
  for (const file of ["docs-site/pricing.md", "docs-site/how-it-works.md"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(
      source.includes("{{VERSION_MINIMUM}}"),
      `${file} must carry the per-save hour marker`,
    );
  }
  assert.ok(llms.includes(PRICE.versionMinimumLine), "llms.txt must state the per-save hour");
});

test("the bill's figures are exact cents, not a rounding near-miss", () => {
  /** @param {number} tb */
  const cents = (tb) => {
    const bill = monthlyBillForStoredTb(tb);
    return {
      storage: Math.round(bill.storageUsd * 100),
      maximum: Math.round(bill.maximumUsd * 100),
      total: Math.round(bill.billUsd * 100),
    };
  };
  assert.deepEqual(cents(0), { storage: 0, maximum: 1000, total: 0 });
  assert.deepEqual(cents(0.05), { storage: 100, maximum: 1000, total: 100 });
  assert.deepEqual(cents(0.8), { storage: 1000, maximum: 1000, total: 1000 });
  assert.deepEqual(cents(1.6), { storage: 1600, maximum: 1600, total: 1600 });
  assert.deepEqual(cents(3), { storage: 3000, maximum: 3000, total: 3000 });
});

test("the worked-example helpers fail closed on a size that cannot be billed", () => {
  for (const bad of [-1, Number.NaN, "2", undefined, null]) {
    assert.throws(() => monthlyBillForStoredTb(bad), TypeError);
    assert.throws(() => usualPlanMonthlyUsd(bad), TypeError);
  }
  assert.equal(monthlyBillForStoredTb(0).storageUsd, 0, "an empty drive is a size, not an error");
});

test("copy, meta tags and llms.txt all render from the one price source", () => {
  assert.equal(BILLING.headline, PRICE.headline, "seo.js must reuse the config's sentence");
  assert.equal(BILLING.rule, PRICE.rule);
  assert.equal(BILLING.noPlansLine, PRICE.noPlansLine);
  assert.equal(SITE.description.endsWith(PRICE.headline), true);
  assert.ok(page.includes(`<title>Drive — ${PRICE.titleLine}</title>`));
  const descriptionMetas = new Set([
    "name=description",
    "property=og:description",
    "property=og:image:alt",
    "name=twitter:description",
  ]);
  const seen = [];
  for (const [name, content] of metaContents(page)) {
    seen.push(name);
    if (descriptionMetas.has(name)) {
      assert.ok(content.includes(PRICE.headline), `the ${name} meta must carry the headline`);
    }
  }
  for (const required of descriptionMetas) {
    assert.ok(seen.includes(required), `the page must carry ${required}`);
  }
  // llms.txt, twice: the summary line and the Pricing section.
  assert.equal(llms.split(PRICE.headline).length - 1, 2, "llms.txt must carry the headline twice");
  for (const line of [PRICE.rule, PRICE.noPlansLine, PRICE.needCard]) {
    assert.ok(llms.includes(line), `llms.txt must carry "${line}"`);
  }
  const jsonLd = page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  assert.ok(jsonLd, "the page must ship the JSON-LD block");
  assert.ok(jsonLd[1].includes(PRICE.headline));
  assert.ok(jsonLd[1].includes(PRICE.rule));
  const ld = softwareApplicationLd();
  assert.ok(ld.offers.description.includes(PRICE.headline));
  assert.ok(ld.offers.description.includes(PRICE.rule));
  assert.equal(Number(ld.offers.price), PRICE.maxUsdPerTb);
});

test("Business is a Talk to us column on the page", () => {
  assert.match(words, /Business[\s\S]{0,400}?Talk to us/);
});

test("nothing the spec forbids appears anywhere on the page", () => {
  // No credit units and no "unlimited" (build-spec.md "Never do").
  for (const banned of ["unlimited", "credit", "credits"]) {
    assert.equal(
      words.toLowerCase().includes(banned),
      false,
      `the page must not contain "${banned}"`,
    );
  }
  // No per-minute price: never a money amount attached to a minute
  // (build-spec.md: "Never advertise a per-minute price").
  assert.doesNotMatch(words, /\$\s?[\d.,]+\s*(\/|per\s)\s*min/i);
});

test("the sign-up points at the waitlist API and works without JavaScript", () => {
  assert.match(page, /<form[^>]+action="\/api\/waitlist"[^>]+method="post"/i);
  assert.match(page, /name="email"/i);
  assert.match(page, /type="email"/i);
});

test("the first viewport says who it is for and what it does", () => {
  const masthead = page.slice(0, page.indexOf("</header>"));
  assert.match(masthead, /A Finder drive for people and their agents/);
});

test("no unsourced claims appear anywhere on the page", () => {
  // The owner's review of PR #17: "We have no SOC 2, and unsourced claims
  // are a hold." The Business box names what is not built and marks it
  // planned in the same breath (drive#545: the team bill and priority
  // support were sold as today's features).
  assert.equal(words.includes("SOC 2"), false, "the page must not claim a SOC 2 report");
  assert.match(words, /single sign-on \(planned\) and priority support \(planned\)\./);
  assert.doesNotMatch(words, /one company bill split by team/);
});

// The text of one <dd>, for the worked-example rows, as a reader sees it. The
// label is the row's <dt> as written, so the row is found by what a reader
// reads rather than by a number re-formatted here.
/** @param {string} label */
function exampleRow(label) {
  const from = words.indexOf(label);
  assert.ok(from >= 0, `the ${label} row is missing from the page`);
  return words.slice(from, words.indexOf("</dd>", from));
}

// The same row's sentence, taken after the label it answers and with the
// markup stripped and the whitespace folded, so an assertion about how the
// example reads is about its words and not about the tags around them.
/** @param {string} label */
function exampleSentence(label) {
  const row = exampleRow(label);
  return row
    .slice(row.indexOf(label) + label.length)
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// The text of a class-marked paragraph, read between its tags.
/** @param {string} className */
function paragraph(className) {
  const from = words.indexOf(`<p class="${className}">`);
  assert.ok(from >= 0, `the .${className} paragraph is missing from the page`);
  return words.slice(from, words.indexOf("</p>", from));
}

// One whole class-marked <section>, read between its tags, so a claim about
// what a section shows is checked against that section and not the whole page.
/** @param {string} className */
function section(className) {
  const from = words.indexOf(`<section class="${className}"`);
  assert.ok(from >= 0, `the .${className} section is missing from the page`);
  return words.slice(from, words.indexOf("</section>", from));
}

const stripCaption = () => paragraph("strip-caption");
const examplesNote = () => paragraph("examples-note");

// Every <meta name=... content=...> and <meta property=... content=...> pair,
// as [name, content], so one assertion covers all of them.
/** @param {string} html */
function metaContents(html) {
  return [...html.matchAll(/<meta\s+(name|property)="([^"]+)"\s+content="([^"]*)"/g)].map(
    (match) => [`${match[1]}=${match[2]}`, match[3]],
  );
}
