// The pricing copy in docs/build-spec.md is a decision, not a suggestion, so it
// is pinned here: a later run cannot quietly reword the headline, add a
// per-minute price, or reintroduce "unlimited" without failing a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

test("the two spec lines sit under the number", () => {
  const headline = words.indexOf("about $20 per TB a month");
  assert.ok(headline >= 0, "headline missing");
  const rate = words.indexOf(
    "2¢ per GB, billed by the minute. Never more than $15 a TB.",
  );
  const free = words.indexOf("$1 free every month, no card needed");
  assert.ok(rate > headline, "the rate line must follow the number");
  assert.ok(free > rate, "the free line must follow the rate line");
});

test("the bill ceiling is stated, per the spec's Bill ceiling row", () => {
  assert.match(words, /Never more than \$15 a TB/);
  assert.match(words, /Each extra TB never more than \$8\./);
});

test("the worked examples carry the ceiling's numbers", () => {
  assert.match(words, /2 TB kept all month[\s\S]{0,60}?about \$23/);
  assert.match(words, /800 GB all month[\s\S]{0,60}?\$15, not \$16/);
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
