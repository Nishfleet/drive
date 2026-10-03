// The Cloudflare Web Analytics beacon (drive issue #246).
//
// Nish's decision on 2026-10-03 was to ship the page half switched off: render
// the beacon only when a beacon-token setting is present, render nothing when it
// is absent, and cover both cases here. So this file tests the two branches as
// the site's own pages, not as a snippet: every case walks the six pages
// drive#246 names, in the form they ship from.
//
// It also pins the three things that would make the beacon quietly wrong. The
// page list, so a page that moves or is added cannot lose its beacon without
// this failing. The Lighthouse third-party budget, which the beacon is the
// reason for (lighthouserc.json has no comment syntax, so the reason is
// recorded here and in src/analytics.js and asserted below). And the wiring in
// vite.config.ts, so a build that stopped calling withBeacon() fails here
// rather than shipping six pages with no measurement while the dashboard reads
// as configured.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BEACON_PAGES,
  BEACON_TOKEN_SETTING,
  beaconTag,
  beaconToken,
  withBeacon,
} from "../src/analytics.js";

/** @param {string} path @returns {string} */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER_TOKEN = "fedcba9876543210fedcba9876543210";

/**
 * The six pages as they ship, read from the file each ships from: the five
 * public/ assets and get-started.html, the built Vite entry at the repo root
 * (drive#70, which src/seo.js records as the `root` page).
 * @returns {Array<[string, string]>}
 */
function shippedPages() {
  return BEACON_PAGES.map((page) => {
    const fromRoot = page === "get-started.html";
    return /** @type {[string, string]} */ ([page, read(fromRoot ? page : `public/${page}`)]);
  });
}

// Every beacon tag in a document, whichever way it is quoted or wrapped, so a
// count of 0 or 2 is what a reader would see rather than what one spelling of
// the tag matches. The whole element, opening tag through `</script>`, so the
// strip below can put the page back the way it shipped.
/** @param {string} html */
const beaconTagsIn = (html) => html.match(/<script\b[^>]*beacon\.min\.js[^>]*><\/script>/g) ?? [];

test("the six pages the issue names are the six the list holds", () => {
  assert.deepEqual(
    [...BEACON_PAGES],
    ["index.html", "signin.html", "files.html", "usage.html", "upload.html", "get-started.html"],
  );
  for (const [name, html] of shippedPages()) {
    assert.ok(html.includes("</head>"), `${name} must have a </head> for the beacon to sit before`);
  }
});

test("no beacon-token setting renders nothing at all", () => {
  // The switched-off case is byte-for-byte identity, not "a page without the
  // beacon": the pages this ships unchanged are what the speed budget, the
  // copy gates and the Lighthouse run were measured against.
  for (const unset of [undefined, "", "   "]) {
    assert.equal(beaconToken(unset), "", `${JSON.stringify(unset)} is the switched-off case`);
    assert.equal(beaconTag(beaconToken(unset)), "");
  }
  for (const [name, html] of shippedPages()) {
    assert.equal(
      withBeacon(html, beaconToken(undefined)),
      html,
      `${name} must ship unchanged with no token, so no page carries analytics`,
    );
    assert.equal(beaconTagsIn(html).length, 0, `${name} ships with no beacon tag in its source`);
  }
});

test("a beacon-token setting renders one deferred beacon in each page's head", () => {
  const token = beaconToken(TOKEN);
  for (const [name, html] of shippedPages()) {
    const built = withBeacon(html, token);
    const tags = beaconTagsIn(built);
    assert.equal(tags.length, 1, `${name} must carry exactly one beacon tag`);
    assert.match(tags[0], /\bdefer\b/, `${name}'s beacon must be deferred: it costs no layout`);
    assert.match(
      tags[0],
      new RegExp(`data-cf-beacon='\\{"token": "${TOKEN}"\\}'`),
      `${name}'s beacon must carry the token from the setting`,
    );
    const at = built.indexOf(tags[0]);
    assert.ok(at > built.indexOf("<head>"), `${name}'s beacon must sit inside the head`);
    assert.ok(at < built.indexOf("</head>"), `${name}'s beacon must sit before </head>`);
    // Nothing else in the document moves: the tag is the only change, so a
    // page that ships hand-written HTML cannot be reflowed by the build.
    assert.equal(
      built.replace(`${tags[0]}\n`, ""),
      html,
      `${name} must change by exactly the beacon tag`,
    );
  }
});

test("a page that already carries a beacon has it replaced, not doubled", () => {
  // The shape the Cloudflare dashboard hands a person, wrapped across two lines
  // and with the data attribute last: pasted by hand, or left by an earlier
  // build. Either way one tag ships, and it is the one the setting names.
  const pasted =
    '<script defer src="https://static.cloudflareinsights.com/beacon.min.js"' +
    ` data-cf-beacon='{"token": "${OTHER_TOKEN}"}'></script>`;
  const html = read("public/signin.html").replace("</head>", `  ${pasted}\n</head>`);
  const built = withBeacon(html, beaconToken(TOKEN));
  assert.equal(beaconTagsIn(built).length, 1);
  assert.ok(built.includes(TOKEN), "the token from the setting is the one that ships");
  assert.ok(
    !built.includes(OTHER_TOKEN),
    "the stale token is gone, so page views go to the live site",
  );
});

test("a page with no </head> fails the build instead of shipping no beacon", () => {
  assert.throws(
    () => withBeacon("<html><body>no head here</body></html>", beaconToken(TOKEN)),
    /<\/head>/,
  );
});

test("a mis-set token fails the build and names the setting", () => {
  for (const bad of ["not-a-token", TOKEN.slice(0, 31), `${TOKEN}00`, "0".repeat(64)]) {
    assert.throws(
      () => beaconToken(bad),
      new RegExp(BEACON_TOKEN_SETTING),
      `${JSON.stringify(bad)} must fail the build naming the setting to fix`,
    );
  }
});

test("the build reads the token from the setting the issue names", () => {
  assert.equal(BEACON_TOKEN_SETTING, "DRIVE_CF_BEACON_TOKEN");
});

test("the build is wired to the beacon, so a dropped plugin fails here", () => {
  const config = read("vite.config.ts");
  assert.match(config, /from "\.\/src\/analytics\.js"/);
  assert.match(config, /webAnalyticsBeacon\(\)/, "vite.config.ts must register the beacon plugin");
  assert.match(config, /process\.env\[BEACON_TOKEN_SETTING\]/, "the token comes from the setting");
  assert.match(config, /BEACON_PAGES/, "the plugin walks the page list, not a copy of it");
});

test("the Lighthouse budget leaves room for the beacon and nothing more", () => {
  // The beacon is the reason the third-party count is no longer 0: it is a
  // third-party resource on the six pages. The transfer size stays 0 because the
  // LHCI run collects against the static asset directory with no route to
  // static.cloudflareinsights.com, so the request is recorded and moves no bytes.
  // Both numbers are asserted, so a third third-party resource or a loosened
  // transfer size fails here instead of passing unnoticed.
  const budgets = JSON.parse(read("lighthouserc.json")).ci.assert.assertions;
  assert.deepEqual(budgets["resource-summary.third-party:count"], [
    "error",
    { maxNumericValue: 1 },
  ]);
  assert.deepEqual(budgets["resource-summary.third-party:transferSize"], [
    "error",
    { maxNumericValue: 0 },
  ]);
});
