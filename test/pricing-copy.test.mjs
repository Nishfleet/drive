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
import { BILL_CEILING, billCeilingUsd } from "../src/pricing.js";

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
  assert.match(
    words,
    /2¢ per GB, billed by the minute\. Never more than \$15 a TB\./,
  );
  // Built in src/pricing.js from the cap, so a config change the page does not
  // follow fails here instead of shipping a copy that disagrees with the math.
  assert.ok(
    words.includes(BILL_CEILING.headline),
    "the page must carry the config's ceiling headline verbatim",
  );
});

test("extra TBs carry their own ceiling, from config", () => {
  assert.ok(
    words.includes(BILL_CEILING.extraTbLine),
    "the page must carry the config's extra-TB line verbatim",
  );
});

test("the two-TB example is the ceiling total, not the uncapped meter", () => {
  assert.match(
    words,
    /2 TB kept all month[\s\S]{0,40}?\$23/,
    "the 2 TB row must show the $23 ceiling total",
  );
  assert.equal(
    words.includes("$40"),
    false,
    "the uncapped $40 figure must not survive on the page",
  );
});

test("billCeilingUsd matches the spec's arithmetic", () => {
  assert.equal(billCeilingUsd(1), 15);
  assert.equal(billCeilingUsd(2), 23);
  assert.equal(billCeilingUsd(3), 31);
  assert.throws(() => billCeilingUsd(0), TypeError);
  assert.throws(() => billCeilingUsd(1.5), TypeError);
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
