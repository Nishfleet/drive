// The pricing copy in docs/build-spec.md is a decision, not a suggestion, so it
// is pinned here: a later run cannot quietly reword the headline, add a
// per-minute price, or reintroduce "unlimited" without failing a test.
//
// The bill ceiling's numbers and every sentence rendered from them live in
// src/pricing.js (PRICE), the one price source. The expectations here are built
// from that config, so page copy that drifts from the numbers fails this file,
// and src/seo.js builds the meta tags and the JSON-LD from the same PRICE, so
// the copy, the tags and llms.txt cannot disagree either. What closed the
// "live page says $23, meta says $16" split is the two tests at the bottom:
// every price the page, the tags and llms.txt render is the one
// monthlyBillUsd() computes, and the whole bill is that rule, not per-TB caps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PRICE, rivalMonthlyUsd } from "../src/pricing.js";
import { monthlyBillForStoredTb } from "../src/billing.js";
import { BILLING, SITE, softwareApplicationLd } from "../src/seo.js";

const page = readFileSync(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const llms = readFileSync(
  new URL("../public/llms.txt", import.meta.url),
  "utf8",
);
// HTML entities the spec's plain-text copy is written with, folded so a test
// asserts on the words a reader sees, not on the markup. &nbsp; becomes a
// plain space so a sentence is compared as one string; the shipped page may
// break a line with &nbsp;1.5&nbsp;TB, which a reader cannot see.
const words = page
  .replaceAll("&nbsp;", " ")
  .replaceAll("&middot;", "-")
  .replaceAll("&times;", "x")
  .replaceAll("&rarr;", "→")
  .replaceAll("&amp;", "&");

// The bill a person is quoted for a size in TB, kept all month. This is the
// paved arithmetic — src/billing.js's monthBillCents(), the one function the
// invoice, the page and the cap all read — so the copy and the bill cannot be
// two arithmetic paths (issue #23, folded #86). It comes back whole:
// storageUsd (the ceiling figure the row prints first), creditUsd (the $1 off)
// and billUsd (what is actually charged).
const billForAllMonth = monthlyBillForStoredTb;

// Dollars, the way the page writes them: no cents where there are none, cents
// where the rule produces them ($12.80). Built from the computed bill, so the
// example rows and the arithmetic cannot disagree.
function usd(amount) {
  return `$${amount.toFixed(2).replace(/\.00$/, "")}`;
}

// The bill's own cents, for the worked-example rows the issue prints them in
// ("$15 after the free $1"): the storage the ceiling charges and what is
// left after the credit, both from the same call as the rest of the file.
function billCents(tb) {
  const bill = billForAllMonth(tb);
  return {
    storage: usd(bill.storageUsd),
    afterCredit: usd(bill.billUsd),
  };
}

test("the headline is the rate, as the spec says", () => {
  // The page's headline is the one price we charge: 2¢ a GB by the minute,
  // with the ceiling under it. The old big number was "about $20 per TB a
  // month" — Space's price, not ours — and Nish dropped it in the #23 rework
  // brief, so no surface may carry it again.
  assert.match(words, /2¢ per GB, billed by the minute/);
  for (const [name, text] of [
    ["public/index.html", words],
    ["public/llms.txt", llms],
    ["the tab title", page.slice(0, page.indexOf("</title>"))],
  ]) {
    assert.equal(
      text.includes("$20"),
      false,
      `${name} must not carry the dropped "$20" headline`,
    );
  }
});

test("the rate and the free line sit under the number", () => {
  const headline = words.indexOf("per GB, billed by the minute");
  assert.ok(headline >= 0, "headline missing");
  const rate = words.indexOf(PRICE.ceilingLine);
  const free = words.indexOf(PRICE.freeLine);
  assert.ok(rate > headline, "the ceiling line must follow the number");
  assert.ok(free > rate, "the free line must follow the ceiling line");
});

test("the bill ceiling headline is the spec's sentence, from config", () => {
  // Built in src/pricing.js from the cap, so a config change the page does not
  // follow fails here instead of shipping copy that disagrees with the math.
  // The page sets the sentence in two lines (the rate as the big number, the
  // ceiling under it); PRICE.ceiling is those two lines joined, which is what
  // the meta tags and llms.txt carry.
  assert.ok(
    words.includes(PRICE.ceilingLine),
    "the page must carry the config's ceiling sentence verbatim",
  );
  assert.ok(
    words.includes(PRICE.rateUnit),
    "the page's big number must carry the config's rate unit",
  );
  assert.equal(
    `${PRICE.rateLine} ${PRICE.ceilingLine}`,
    PRICE.ceiling,
    "the headline sentence must be the two page lines joined",
  );
  // The sentence is the issue's, word for word: the plateau and where it ends.
  assert.equal(
    PRICE.ceiling,
    "2¢ per GB, billed by the minute. Never more than $12 a TB, and $8 a TB once you pass 1.5 TB.",
  );
  assert.equal(PRICE.capFloorUsd, 12);
  assert.equal(PRICE.capUsdPerTb, 8);
  assert.equal(PRICE.capPlateauTb, 1.5);
});

test("the example rows are the spec's worked figures, with the free $1", () => {
  // Issue #23 names the rows as 800 GB = $12, 2 TB = $16 against Space $27,
  // 5 TB = $40 against Space $63; folded #86 (the bill now takes the $1 off)
  // says the rows show what the bill charges. Both figures are on each row,
  // both computed by src/billing.js's monthBillCents().
  for (const [label, tb] of [
    ["800 GB kept all month", 0.8],
    ["2 TB kept all month", 2],
    ["5 TB kept all month", 5],
  ]) {
    const row = exampleRow(label);
    const { storage, afterCredit } = billCents(tb);
    assert.ok(
      row.includes(storage),
      `the ${label} row must show the ${storage} storage figure, got ${row.trim()}`,
    );
    assert.ok(
      row.includes(afterCredit),
      `the ${label} row must show the ${afterCredit} bill after the free $1, got ${row.trim()}`,
    );
  }
  // The rival comparison, by the rival's own rule (build-spec.md): $15 a month
  // plus $12 for each TB after the first.
  for (const [label, tb, space] of [
    ["2 TB kept all month", 2, "$27"],
    ["5 TB kept all month", 5, "$63"],
  ]) {
    assert.equal(rivalMonthlyUsd(tb).toFixed(0), space.slice(1));
    assert.ok(
      exampleRow(label).includes(space),
      `the ${label} row must carry Space ${space}`,
    );
  }
  // Pinned, so the rows cannot be quietly re-derived into something else.
  assert.match(words, /800 GB kept all month[\s\S]{0,200}?\$12[\s\S]{0,120}?\$11/);
  assert.match(words, /2 TB kept all month[\s\S]{0,200}?\$16[\s\S]{0,120}?\$15[\s\S]{0,80}?\(Space \$27\)/);
  assert.match(words, /5 TB kept all month[\s\S]{0,200}?\$40[\s\S]{0,120}?\$39[\s\S]{0,80}?\(Space \$63\)/);
});

test("the superseded per-TB caps are gone from the page", () => {
  // PR #24 shipped "$15 a TB" and "2 TB = $23" (the first-TB-plus-$8 rule).
  // Issue #23 replaced it: the cap is max($12, $8 × TB), not $15 for the first
  // TB then $8 each. No surface may carry the old numbers or the old sentence.
  for (const [file, text] of [
    ["public/index.html", words],
    ["public/llms.txt", llms],
  ]) {
    for (const stale of ["$15 a TB", "$23", "first TB never past", "Extra TBs"]) {
      assert.equal(
        text.includes(stale),
        false,
        `${file} must not carry the superseded "${stale}"`,
      );
    }
  }
});

test("the spec's worked example is still on the page", () => {
  assert.match(words, /500 GB for 3 days[\s\S]{0,120}?about \$1/);
});

test("the ceiling math is the spec's plateau, not per-TB caps", () => {
  // docs/build-spec.md "Bill ceiling" (Nish 2026-09-30, issue #29): the
  // monthly bill is min(metered, max($12, $8 × peak TB)), then the $1 free
  // comes off (#76). So the cap is flat at $12 until 1.5 TB and only then
  // rises at $8 a TB. 800 GB meters at $16 and bills the $12 cap; 1.6 TB
  // meters at $32 and caps at $12.80.
  const storage = (tb) => billForAllMonth(tb).storageUsd;
  const bill = (tb) => billForAllMonth(tb).billUsd;
  assert.equal(storage(0), 0, "an empty drive bills nothing");
  assert.equal(storage(0.5), 10, "500 GB all month is 2¢/GB");
  assert.equal(storage(0.6), 12, "the strip's 600 GB meters at $12");
  assert.equal(storage(0.8), 12, "800 GB meters at $16, caps at $12");
  assert.equal(storage(1), 12);
  assert.equal(storage(1.3), 12, "1.3 TB is still on the $12 plateau");
  assert.equal(storage(1.5), 12, "the plateau ends at 1.5 TB");
  assert.equal(storage(1.6), 12.8, "1.6 TB caps at $12.80, not $16");
  assert.equal(storage(2), 16, "2 TB is $8 × 2 TB");
  assert.equal(storage(3), 24);
  assert.equal(storage(5), 40);
  // The $1 comes off every one of them, and floors at nothing: 50 GB all
  // month is $1 of storage, so the credit takes it to $0, never a refund.
  assert.equal(bill(0), 0, "an empty drive bills nothing");
  assert.equal(bill(0.05), 0, "50 GB all month is exactly the free $1");
  assert.equal(bill(0.5), 9);
  assert.equal(bill(0.6), 11);
  assert.equal(bill(0.8), 11);
  assert.equal(bill(1), 11);
  assert.equal(bill(1.3), 11);
  assert.equal(bill(1.5), 11);
  assert.equal(bill(1.6), 11.8);
  assert.equal(bill(2), 15);
  assert.equal(bill(3), 23);
  assert.equal(bill(5), 39);
  assert.equal(billForAllMonth(0).creditUsd, 1, "the credit is $1 every month");
  // Adding data never lowers the bill: the cap is a max(), not a cliff.
  for (const tb of [0.4, 0.8, 1.2, 1.5, 1.9, 2.1, 4.9]) {
    const smaller = storage(tb - 0.1);
    const bigger = storage(tb);
    assert.ok(
      bigger >= smaller,
      `${tb} TB (${bigger}) must not bill less than ${(tb - 0.1).toFixed(1)} TB (${smaller})`,
    );
  }
});

test("the strip's 60%-full drive bills what the page prints", () => {
  // 0.6 TB metered at 2¢/GB is $12, and $12 is the cap at that size, so the
  // strip's figure is the metered cost under the cap, less the free $1.
  assert.equal(billForAllMonth(0.6).storageUsd, 12);
  assert.match(words, /60% full - \$11/);
  assert.match(words, /bills \$11 a month: \$12 of storage, less the free \$1/);
});

test("the page's ceiling prose names the cap from config", () => {
  // The strip caption and the examples note state the rule in prose; they are
  // built from the config, so they cannot drift from the numbers.
  const formula = `max($${PRICE.capFloorUsd}, $${PRICE.capUsdPerTb} × TB stored)`;
  for (const [name, line] of [
    ["strip-caption", stripCaption()],
    ["examples-note", examplesNote()],
  ]) {
    assert.ok(line.includes(formula), `the ${name} must state ${formula}`);
  }
  // The plateau, in words, so a reader who cannot parse a formula still gets
  // it: $12 up to 1.5 TB, then $8 for each TB after.
  assert.ok(
    examplesNote().includes(
      `a flat $${PRICE.capFloorUsd} up to ${PRICE.capPlateauTb} TB, then $${PRICE.capUsdPerTb} for each TB after`,
    ),
    "the examples note must spell the plateau out",
  );
  // And the credit, the same way the bill does it (#76): the rows charge what
  // the cap allows, less the $1, so the note has to say so.
  assert.ok(
    examplesNote().includes(`less the free $${PRICE.freeMonthlyUsd}, so 2 TB is $${billForAllMonth(2).billUsd}`),
    "the examples note must state the figure the bill charges after the credit",
  );
});

test("copy, meta tags and llms.txt all render from the one price source", () => {
  // The live page contradicted itself: visible copy said 2 TB = $23 while the
  // meta tags and llms.txt said $16 (issue #23). src/seo.js now builds its
  // BILLING and SITE description from PRICE, so the three surfaces are one
  // source. This asserts each of them, from the config, on the shipped files.
  assert.equal(BILLING.ceiling, PRICE.ceiling, "seo.js must reuse the config's sentence");
  assert.equal(BILLING.rule, PRICE.rule);
  assert.equal(BILLING.freeLine, PRICE.freeLine);
  assert.equal(SITE.description.endsWith(PRICE.ceiling), true);
  // The page's own visible copy: the headline is the sentence's two lines.
  assert.ok(words.includes(PRICE.rateUnit));
  assert.ok(words.includes(PRICE.ceilingLine));
  assert.ok(words.includes(PRICE.freeLine));
  // Every meta description, the Open Graph and Twitter cards, and the JSON-LD.
  const descriptionMetas = new Set([
    "name=description",
    "property=og:description",
    "property=og:image:alt",
    "name=twitter:description",
  ]);
  const seen = [];
  for (const [name, content] of metaContents(page)) {
    seen.push(name);
    assert.equal(
      content.includes("Never more than $12 a TB, then $8."),
      false,
      `the ${name} meta still carries the superseded "then $8" sentence`,
    );
    if (descriptionMetas.has(name)) {
      assert.ok(
        content.includes(PRICE.ceiling),
        `the ${name} meta must carry the config's ceiling sentence`,
      );
    }
  }
  // The set above is exhaustive: a new description-bearing tag has to be added
  // here, where its price is checked, not just to the page.
  for (const required of descriptionMetas) {
    assert.ok(seen.includes(required), `the page must carry ${required}`);
  }
  // llms.txt, twice: the summary line and the Pricing section.
  assert.equal(llms.split(PRICE.ceiling).length - 1, 2, "llms.txt must carry the ceiling sentence twice");
  // The JSON-LD offer, which a crawler reads instead of the prose.
  const ld = softwareApplicationLd();
  assert.ok(ld.offers.description.includes(PRICE.ceiling));
  assert.ok(ld.offers.description.includes(PRICE.rule));
  assert.equal(Number(ld.offers.price), PRICE.capFloorUsd);
});

test("llms.txt's worked examples are the computed bills", () => {
  // An answer engine quotes llms.txt, so its figures are the ones the rule
  // computes — the storage line and what is charged after the $1 — asserted
  // from the same call the example rows use.
  for (const [tb, label] of [
    [0.8, "800 GB kept all month"],
    [1.6, "1.6 TB"],
    [2, "2 TB"],
    [5, "5 TB"],
  ]) {
    const { storage, afterCredit } = billCents(tb);
    assert.ok(
      llms.includes(`${label} = ${afterCredit}`),
      `llms.txt must quote the ${afterCredit} bill for ${label}`,
    );
    assert.ok(
      llms.includes(`${storage}`),
      `llms.txt must name the ${storage} storage figure for ${label}`,
    );
  }
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
  assert.match(
    page,
    /<form[^>]+action="\/api\/waitlist"[^>]+method="post"/i,
  );
  assert.match(page, /name="email"/i);
  assert.match(page, /type="email"/i);
});

test("the first viewport says who it is for and what it does", () => {
  const masthead = page.slice(0, page.indexOf("</header>"));
  assert.match(masthead, /A Finder drive for people and their agents/);
});

test("no unsourced claims appear anywhere on the page", () => {
  // The owner's review of PR #17: "We have no SOC 2, and unsourced claims
  // are a hold." Single sign-on is marked planned where the Business box
  // names it, since the Business tier is built after v1.
  assert.equal(
    words.includes("SOC 2"),
    false,
    "the page must not claim a SOC 2 report",
  );
  assert.match(words, /single sign-on \(planned\)/);
});

// The text of one <dd>, for the worked-example rows, as a reader sees it. The
// label is the row's <dt> as written, so the row is found by what a reader
// reads rather than by a number re-formatted here.
function exampleRow(label) {
  const from = words.indexOf(label);
  assert.ok(from >= 0, `the ${label} row is missing from the page`);
  return words.slice(from, words.indexOf("</dd>", from));
}

// The text of a class-marked paragraph, read between its tags.
function paragraph(className) {
  const from = words.indexOf(`<p class="${className}">`);
  assert.ok(from >= 0, `the .${className} paragraph is missing from the page`);
  return words.slice(from, words.indexOf("</p>", from));
}

const stripCaption = () => paragraph("strip-caption");
const examplesNote = () => paragraph("examples-note");

// Every <meta name=... content=...> and <meta property=... content=...> pair,
// as [name, content], so one assertion covers all of them.
function metaContents(html) {
  return [...html.matchAll(/<meta\s+(name|property)="([^"]+)"\s+content="([^"]*)"/g)].map(
    (match) => [`${match[1]}=${match[2]}`, match[3]],
  );
}
