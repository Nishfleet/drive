// The teams surface is the API, not a screen (drive issue #775).
//
// #20 built the team routes on the api Worker and closed with the API only.
// The company screens that invite a member, set read-only or read-write, and
// remove a member are not built, so every surface that talks about a company
// drive has to say so and has to name the teams API as version 1's only path.
// This file pins that on the Talk-to-us box on the pricing page and on the two
// spec rows, and pins the price the surface carries to core/pricing.js
// (PRICE), so a later run cannot reintroduce #20's retired $15 per TB ceiling
// or a screen the API does not back.
//
// The gate reads the same two spec files the product spec does, and the api
// reference the copy points at, so "the API is the path" is a pointer to real
// routes rather than a sentence with nothing behind it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PRICE } from "../core/pricing.js";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const spec = readFileSync(new URL("../docs/spec.md", import.meta.url), "utf8");
const buildSpec = readFileSync(new URL("../docs/build-spec.md", import.meta.url), "utf8");
const apiDoc = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8");

// Entities the page is written with, folded so the assertions read the words a
// person sees rather than the markup, exactly as test/pricing-copy.test.mjs
// does.
const words = page.replaceAll("&nbsp;", " ").replaceAll("&middot;", "-").replaceAll("&amp;", "&");

// The Talk-to-us box on the pricing page: from its heading to the waitlist
// form it owns. Sliced rather than matched whole so a copy edit inside the box
// is what is judged, not the rest of the page.
const businessHeading = words.indexOf('id="business-heading"');
assert.ok(businessHeading >= 0, "the pricing page must carry the Business box");
const waitlistForm = words.indexOf('<form class="waitlist"', businessHeading);
assert.ok(waitlistForm > businessHeading, "the Business box must own the waitlist form");
const businessBox = words.slice(businessHeading, waitlistForm);

/** One spec table row, from its leading label to the line's own end. @param {string} text @param {string} label */
function specRow(text, label) {
  const from = text.indexOf(label);
  assert.ok(from >= 0, `the spec must carry a ${label} row`);
  return text.slice(from, text.indexOf("\n", from));
}

const businessSpecRow = specRow(spec, "| Business tier");
const companySpecRow = specRow(buildSpec, "| Company tier");

// #20's ceiling ("$15/TB") is retired in favour of PRICE.maxUsdPerTb ($10);
// the surface must name a per-TB amount only if it is the shipped one. The
// matcher matches "$10 per TB", "$10/TB" and "$10 a TB".
const PER_TB = /\$\s?(\d+(?:\.\d+)?)\s*(?:\/|per\s*|a\s*)\s*TB\b/gi;
/** @param {string} text @returns {number[]} */
const perTbAmounts = (text) => [...text.matchAll(PER_TB)].map((match) => Number(match[1]));

test("the Talk-to-us box says the company screens come later and the API is the path", () => {
  assert.match(businessBox, /teams API/i);
  assert.match(businessBox, /only company path in version 1/i);
  assert.match(businessBox, /company screens come later/i);
});

test("both spec rows say the company UI is later and name the API as the v1 path", () => {
  for (const [name, row] of [
    ["docs/spec.md Business tier", businessSpecRow],
    ["docs/build-spec.md Company tier", companySpecRow],
  ]) {
    assert.match(row, /company UI is later/i, `${name} must say the company UI is later`);
    assert.match(row, /teams API/i, `${name} must name the teams API`);
    assert.match(
      row,
      /only (v1|version 1)?\s*path|only path/i,
      `${name} must name the API the path`,
    );
    assert.match(row, /read_only/, `${name} must name the read-only role`);
    assert.match(row, /read_write/, `${name} must name the read-write role`);
    assert.match(row, /revokes? .*key/i, `${name} must say removal revokes the key`);
  }
});

test("the API the copy points at documents the four team routes", () => {
  for (const route of [
    "POST /v1/teams",
    "POST /v1/teams/:teamId/members",
    "GET /v1/teams/:teamId/members",
    "DELETE /v1/teams/:teamId/members/:memberId",
    "POST /v1/teams/:teamId/key",
  ]) {
    assert.ok(apiDoc.includes(route), `docs/api.md must document ${route}`);
  }
});

test("no teams surface carries a per-TB price but the shipped one", () => {
  for (const [name, text] of [
    ["the Business box", businessBox],
    ["docs/spec.md Business tier", businessSpecRow],
    ["docs/build-spec.md Company tier", companySpecRow],
  ]) {
    for (const amount of perTbAmounts(text)) {
      assert.equal(
        amount,
        PRICE.maxUsdPerTb,
        `${name} names $${amount} per TB, the shipped maximum is $${PRICE.maxUsdPerTb}`,
      );
    }
    assert.doesNotMatch(
      text,
      /15\s*(?:\/|per\s*|a\s*)\s*TB\b/i,
      `${name} carries #20's retired $15/TB`,
    );
  }
});

test("the price gate has teeth: it catches the retired ceiling on a surface", () => {
  // Prove the matcher can fail, on the exact form #20 shipped.
  assert.deepEqual(
    perTbAmounts("One bill uses the same per-minute price and $15/TB ceiling."),
    [15],
  );
  assert.deepEqual(perTbAmounts(`never more than $${PRICE.maxUsdPerTb} per TB`), [
    PRICE.maxUsdPerTb,
  ]);
  assert.equal(perTbAmounts("The teams API is the only company path in version 1.").length, 0);
});
