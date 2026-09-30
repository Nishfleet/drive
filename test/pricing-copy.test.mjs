// The pricing copy in docs/build-spec.md is a decision, not a suggestion, so it
// is pinned here: a later run cannot quietly reword the headline, add a
// per-minute price, or reintroduce "unlimited" without failing a test. The bill
// ceiling's numbers and sentences live in src/pricing.js; the ceiling tests
// build their expectations from that config, so page copy that drifts from it
// fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BILL_CEILING, cappedMonthlyBillUsd } from "../src/pricing.js";

const page = readFileSync(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
// HTML entities the spec's plain-text copy is written with, folded so a test
// asserts on the words a reader sees, not on the markup.
const words = page
  .replaceAll("&nbsp;", " ")
  .replaceAll("&middot;", "-")
  .replaceAll("&times;", "x")
  .replaceAll("&amp;", "&");

test("the headline is one big number, as the spec says", () => {
  assert.match(words, /about \$20 per TB a month/);
});

test("the rate and the free line sit under the number", () => {
  const headline = words.indexOf("about $20 per TB a month");
  assert.ok(headline >= 0, "headline missing");
  // The rate line is the ceiling headline from src/pricing.js; the issue moved
  // "pay only for what you store" into the ceiling paragraph.
  const rate = words.indexOf(BILL_CEILING.headline);
  const free = words.indexOf("$1 free every month, no card needed");
  assert.ok(rate > headline, "the rate line must follow the number");
  assert.ok(free > rate, "the free line must follow the rate line");
});

test("the bill ceiling headline is the spec's sentence, from config", () => {
  // Built in src/pricing.js from the cap, so a config change the page does not
  // follow fails here instead of shipping copy that disagrees with the math.
  assert.ok(
    words.includes(BILL_CEILING.headline),
    "the page must carry the config's ceiling headline verbatim",
  );
  assert.ok(
    words.includes("Never more than $15 a TB."),
    "the ceiling headline must name the $15 cap",
  );
});

test("extra TBs carry their own ceiling, from config", () => {
  assert.ok(
    words.includes(BILL_CEILING.extraTbLine),
    "the page must carry the config's extra-TB line verbatim",
  );
});

test("the two-TB example is the ceiling total, not the uncapped meter", () => {
  const twoTbTotal = `$${cappedMonthlyBillUsd(2)}`;
  const row = words.slice(
    words.indexOf("2 TB kept all month"),
    words.indexOf("</dd>", words.indexOf("2 TB kept all month")),
  );
  assert.ok(
    row.includes(twoTbTotal),
    `the 2 TB row must show the ${twoTbTotal} ceiling total, got ${row.trim()}`,
  );
  // The uncapped meter for 2 TB is $40; the row must not fall back to it.
  assert.equal(
    row.includes("$40"),
    false,
    "the 2 TB row must not show the uncapped $40 meter",
  );
});

test("the ceiling math follows the spec's worked figures", () => {
  // build-spec.md "Bill ceiling": inside a TB you pay the meter, at the TB's
  // cap you stop; the first TB caps at $15, each extra TB at $8.
  assert.equal(cappedMonthlyBillUsd(0), 0, "an empty drive bills nothing");
  assert.equal(cappedMonthlyBillUsd(0.5), 10, "500 GB a month is 2¢/GB");
  assert.equal(cappedMonthlyBillUsd(0.8), 15, "800 GB is $15, not $16");
  assert.equal(cappedMonthlyBillUsd(1), 15);
  assert.equal(cappedMonthlyBillUsd(1.3), 21, "1.3 TB is $15 + $6");
  assert.equal(cappedMonthlyBillUsd(1.6), 23, "1.6 TB is $15 + $8");
  assert.equal(cappedMonthlyBillUsd(2), 23);
  assert.equal(cappedMonthlyBillUsd(3), 31);
  // The strip's 60%-full 1 TB drive bills the meter, under the $15 cap.
  assert.equal(cappedMonthlyBillUsd(0.6), 12);
  assert.throws(() => cappedMonthlyBillUsd(-1), TypeError);
  assert.throws(() => cappedMonthlyBillUsd(Number.NaN), TypeError);
});

test("the page's ceiling prose names the caps from config", () => {
  // The strip caption and the examples note repeat the caps in prose; assert
  // they still carry both numbers so that copy cannot drift from the config.
  for (const selector of ["strip-caption", "examples-note"]) {
    assert.ok(
      words.includes(`.${selector}`),
      `the ${selector} section must exist on the page`,
    );
  }
  assert.ok(
    words.includes(`no bill passes $${BILL_CEILING.firstTbUsd} for the first TB or $${BILL_CEILING.extraTbUsd} for each TB after.`),
    "the strip caption must state both caps",
  );
  assert.ok(
    words.includes(
      `the first TB never past $${BILL_CEILING.firstTbUsd}, every extra TB never past $${BILL_CEILING.extraTbUsd}`,
    ),
    "the examples note must state both caps",
  );
});

test("the worked example is the spec's example", () => {
  assert.match(words, /500 GB for 3 days[\s\S]{0,60}?about \$1/);
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
