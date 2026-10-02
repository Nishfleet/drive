// The share card (drive issue #123). public/og.png is a raster, so no test can
// read its price; the card's source, public/og-card.html, is text, and this
// gate reads the strings out of that source against src/pricing.js (PRICE),
// the one price source. A repriced product, or the superseded "$20 per TB"
// figure re-hardcoded into the card, fails here, the way
// test/pricing-copy.test.mjs gates the page's copy. The card's palette and its
// link to the shared stylesheet are gated by test/site-styles.test.mjs, which
// walks every top-level public page, and its non-indexable registration by
// test/seo.test.mjs. The raster's declared size is gated here, so a replaced
// image cannot silently change the card's shape.
//
// The card's price is gated from its source, not from the PNG, because a
// raster's pixels are not text: the source is the thing a person edits when a
// price changes, and a re-render is the follow-up (the recipe is in the file's
// own header). Reading the source is therefore the gate the issue asks for;
// the PNG's bytes are checked only for the 1200x630 the og:image tags declare.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PRICE } from "../src/pricing.js";

const card = readFileSync(new URL("../public/og-card.html", import.meta.url), "utf8");
const png = readFileSync(new URL("../public/og.png", import.meta.url));

// The words a reader sees, from the <body> only: the comment, the <head>
// (<title>, the meta tags) and the <style> block are not the card's copy, so
// a stale <title> cannot mask a body that drifted, and a body assertion cannot
// pass on text a crawler reads but a viewer does not. Whitespace between
// elements is one space, so the amount and its unit read as one line.
const body = card.slice(card.indexOf("<body>"), card.indexOf("</body>"));
const cardLines = body
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/<[^>]+>/g, "\n")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

test("the card's body is exactly the current price, from the one price source", () => {
  // The whole visible body as one list, so the card cannot carry all four
  // right lines and a fifth wrong one, and no other currency or figure can
  // ride along under a subset check.
  assert.deepEqual(cardLines, [
    "Drive",
    PRICE.headlineAmount,
    PRICE.rateUnit,
    PRICE.ceilingLine,
    PRICE.freeLine,
  ]);
});

test("the card carries no superseded figure", () => {
  // Issue #23 dropped "about $20 per TB a month" (it was Space's price, not
  // ours). A card that renders it again is the exact bug this issue fixes.
  // This runs on the whole file, so the string cannot hide in the head or a
  // comment either.
  assert.doesNotMatch(card, /about \$20/i);
  assert.doesNotMatch(card, /\bunlimited\b/i);
});

test("the card canvas is 1200x630, and so is the committed raster", () => {
  // Anchored to the canvas rule, not any rule in the file: a stray 1200px
  // elsewhere must not satisfy the shape the og:image tags declare.
  assert.match(card, /html,\s*\n\s*body\s*\{\s*\n\s*width:\s*1200px;\s*\n\s*height:\s*630px;/);
  // The PNG header: the 8-byte signature, then IHDR's width and height. The
  // pixels' declared size is the one gate a test can put on a raster, and it
  // has to agree with the og:image:width/height the page declares.
  assert.equal(png.subarray(0, 8).toString("latin1"), "\u0089PNG\r\n\u001a\n");
  assert.equal(png.subarray(12, 16).toString("latin1"), "IHDR");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});
