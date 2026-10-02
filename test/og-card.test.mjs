// The share card (drive issue #123). public/og.png is a raster, so no test can
// read its price; the card's source, public/card/og-card.html, is text, and
// this gate reads the strings out of that source against src/pricing.js
// (PRICE), the one price source. A repriced product, a superseded figure
// re-hardcoded into the card, or a palette that drifted from the page fails
// here, the way test/pricing-copy.test.mjs gates the page's copy. The raster
// itself is checked by its PNG header (1200x630), so a replaced image cannot
// silently change the card's shape.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PRICE } from "../src/pricing.js";

const card = readFileSync(new URL("../public/card/og-card.html", import.meta.url), "utf8");
const png = readFileSync(new URL("../public/og.png", import.meta.url));
const siteCss = readFileSync(new URL("../public/site.css", import.meta.url), "utf8");

// The words a reader sees: comments and the <style> block are not copy, and
// whitespace between elements is one space, so a sentence split across two
// elements (the amount and its unit) reads as one line.
const cardText = card
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/<style>[\s\S]*?<\/style>/g, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ")
  .trim();

// Every custom property a stylesheet declares, name -> value, with comments
// stripped. The card copies its palette from public/site.css, so this is the
// comparison that catches a token the card typed rather than inherited.
/** @param {string} css */
function tokens(css) {
  const found = new Map();
  for (const [, name, value] of css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/(?:^|[;{\s])(--[-\w]+)\s*:\s*([^;]+);/g)) {
    found.set(name, value.trim().replace(/\s+/g, " "));
  }
  return found;
}

test("the card states the current price, from the one price source", () => {
  assert.ok(
    cardText.includes(PRICE.headlineAmount),
    "the card must carry the config's rate as its big number",
  );
  assert.ok(
    cardText.includes(PRICE.rateUnit),
    "the card must carry the config's unit under the rate",
  );
  assert.ok(
    cardText.includes(PRICE.ceilingLine),
    "the card must carry the config's ceiling sentence",
  );
  assert.ok(cardText.includes(PRICE.freeLine), "the card must carry the config's free line");
});

test("the card carries no superseded figure", () => {
  // Issue #23 dropped "about $20 per TB a month" (it was Space's price, not
  // ours). A raster that renders it again is the exact bug this issue fixes.
  assert.doesNotMatch(cardText, /about \$20/i);
  assert.doesNotMatch(cardText, /\bunlimited\b/i);
});

test("the card is 1200x630, and so is the committed raster", () => {
  assert.match(card, /width:\s*1200px/);
  assert.match(card, /height:\s*630px/);
  // The PNG header: 8-byte signature, then IHDR's width and height. Reading
  // the pixels' declared size is the one gate a test can put on a raster.
  assert.equal(png.subarray(0, 8).toString("latin1"), "\u0089PNG\r\n\u001a\n");
  assert.equal(png.subarray(12, 16).toString("latin1"), "IHDR");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test("the card's palette is the page's own", () => {
  const site = tokens(siteCss);
  const cardTokens = tokens(card);
  assert.ok(cardTokens.size > 0, "the card must declare the palette it renders with");
  for (const [name, value] of cardTokens) {
    assert.equal(
      site.get(name),
      value,
      `the card declares ${name}: ${value}; public/site.css owns that token`,
    );
  }
});
