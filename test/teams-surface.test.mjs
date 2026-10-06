// The teams surface is the API, not a screen (drive issue #775).
//
// #20 built the team routes on the api Worker and closed with the API only.
// The company screens that invite a member, set read-only or read-write, and
// remove a member are not built, so these three surfaces that talk about a
// company drive have to say so and have to name the teams API as version 1's
// only path: the Talk-to-us box on the pricing page, the Business tier row in
// docs/spec.md, and the Company tier row in docs/build-spec.md.
//
// This file pins that, and guards the price those surfaces carry against
// core/pricing.js (PRICE), so a later run cannot reintroduce #20's retired
// $15 per TB ceiling or a screen the API does not back. The route test reads
// the api Worker's own route registry, not just the reference, so "the API is
// the path" points at routes the Worker registers; the anonymous-401 proof
// for them already lives beside that Worker, in workers/api/test/teams.test.js,
// and is not repeated here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PRICE } from "../core/pricing.js";
import { routes } from "../workers/api/src/routes.js";

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

// Every team operation #20 shipped and docs/api.md documents: the method and
// path as the api Worker registers them.
const TEAM_OPERATIONS = Object.freeze([
  Object.freeze({ method: "POST", path: "/v1/teams" }),
  Object.freeze({ method: "GET", path: "/v1/teams" }),
  Object.freeze({ method: "POST", path: "/v1/teams/:teamId/members" }),
  Object.freeze({ method: "GET", path: "/v1/teams/:teamId/members" }),
  Object.freeze({ method: "DELETE", path: "/v1/teams/:teamId/members/:memberId" }),
  Object.freeze({ method: "POST", path: "/v1/teams/:teamId/key" }),
]);

// #20's ceiling ("$15/TB") is retired in favour of PRICE.maxUsdPerTb ($10);
// these surfaces must name a per-TB amount only if it is the shipped one. The
// matcher matches "$10 per TB", "$10/TB" and "$10 a TB".
const PER_TB = /\$\s?(\d+(?:\.\d+)?)\s*(?:\/|per\s*|a\s*)\s*TB\b/gi;
/** @param {string} text @returns {number[]} */
const perTbAmounts = (text) => [...text.matchAll(PER_TB)].map((match) => Number(match[1]));

test("the Talk-to-us box says the company screens come later and the API is the only way in", () => {
  assert.match(businessBox, /teams API/i);
  assert.match(businessBox, /only way to manage a company drive today/i);
  assert.match(businessBox, /company screens come later/i);
});

test("both spec rows say the company UI is later and name the API as the only v1 path", () => {
  for (const [name, row] of [
    ["docs/spec.md Business tier", businessSpecRow],
    ["docs/build-spec.md Company tier", companySpecRow],
  ]) {
    assert.match(row, /company UI is later/i, `${name} must say the company UI is later`);
    assert.match(row, /teams API/i, `${name} must name the teams API`);
    assert.match(row, /v1|version 1/i, `${name} must say which version the API is the path in`);
    assert.match(row, /only (v1 |version 1 )?path/i, `${name} must name the API the only path`);
    assert.match(row, /read_only/, `${name} must name the read-only role`);
    assert.match(row, /read_write/, `${name} must name the read-write role`);
    assert.match(row, /revokes? .*key/i, `${name} must say removal revokes the key`);
  }
});

test("the api Worker registers every team operation the copy points at", () => {
  const registered = routes.filter((route) => route.path.startsWith("/v1/teams"));
  // docs/api.md writes the same routes; a document that spells a parameter
  // {teamId} rather than :teamId still names the route, so fold both forms.
  const documented = apiDoc.replaceAll(/\{(\w+)\}/g, ":$1");
  for (const { method, path } of TEAM_OPERATIONS) {
    const found = registered.find((route) => route.method === method && route.path === path);
    assert.ok(found, `the api Worker must register ${method} ${path}`);
    assert.ok(
      documented.includes(`${method} ${path}`),
      `docs/api.md must document ${method} ${path}`,
    );
  }
  // The count is a deliberate lock: a team route added without a place in the
  // reference makes this red, so the copy that says "only through the teams
  // API" cannot quietly go stale.
  assert.equal(
    registered.length,
    TEAM_OPERATIONS.length,
    "a new team route needs its place in docs/api.md and in this gate",
  );
});

// A guard for a price line this change does not add: #775's price duty is a
// no-op today, because no teams surface names a per-TB amount at all and the
// page's live price lines are already gated against PRICE by
// test/pricing-copy.test.mjs. The guard is what stops a later run from writing
// a teams price line that drifts, starting with #20's retired $15/TB.
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
  assert.equal(
    perTbAmounts("The teams API is the only way to manage a company drive today.").length,
    0,
  );
});
