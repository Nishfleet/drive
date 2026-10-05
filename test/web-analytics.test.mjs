// The Cloudflare Web Analytics beacon (drive issue #246).
//
// Nish's decision on 2026-10-03 was to ship the page half switched off: render
// the beacon only when a beacon-token setting is present, render nothing when it
// is absent, and cover both cases here. So this file tests the two branches as
// the site's own pages, not as a snippet: every case walks the six pages
// drive#246 names, in the form they ship from.
//
// It also pins the four things that would make the beacon quietly wrong. The
// page list, so a page that moves or is added cannot lose its beacon without
// this failing. The Lighthouse third-party budget, which the beacon is the
// reason for (lighthouserc.json has no comment syntax, so the reason is
// recorded here and in src/analytics.js and asserted below). The wiring in
// vite.config.ts, so a build that stopped calling withBeacon() fails here
// rather than shipping six pages with no measurement while the dashboard reads
// as configured. And the count of beacon tags, from the same reader the build's
// own self-check uses, so the two agree on what a beacon is.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertSingleBeacon,
  BEACON_PAGES,
  BEACON_TOKEN_SETTING,
  beaconTag,
  beaconTagsIn,
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
 * (drive#70, which src/seo.js records as the `root` page). Each file must
 * exist: the build walks this list, so a page named here and missing on disk is
 * a build failure, not a page quietly left without a beacon.
 * @returns {Array<[string, string]>}
 */
function shippedPages() {
  return BEACON_PAGES.map((page) => {
    const fromRoot = page === "get-started.html";
    const url = fromRoot
      ? new URL(`../${page}`, import.meta.url)
      : new URL(`../public/${page}`, import.meta.url);
    assert.ok(existsSync(url), `${page} must exist where the build reads it from`);
    return /** @type {[string, string]} */ ([page, readFileSync(url, "utf8")]);
  });
}

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

test("a beacon tag in any hand-written shape is counted, so two cannot ship", () => {
  // The dashboard snippet is one shape of beacon tag, not the only one: Cloudflare
  // has renamed the file, and a person formatting HTML by hand can leave a space
  // before the closing >. A reader that counts only one spelling is how a page
  // ships two beacons and reports its page views twice. Each shape below is
  // stripped and replaced, and the count after the build is one.
  const shapes = [
    String.raw`<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${OTHER_TOKEN}"}'></script>`,
    String.raw`<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${OTHER_TOKEN}"}'></script >`,
    String.raw`<script defer src="https://static.cloudflareinsights.com/rum/site/${OTHER_TOKEN}.js"></script>`,
    String.raw`<script
    defer
    src="https://static.cloudflareinsights.com/beacon.min.js"
    data-cf-beacon='{"token": "${OTHER_TOKEN}"}'
  ></script>`,
  ];
  for (const shape of shapes) {
    const html = read("public/signin.html").replace("</head>", `\n  ${shape}\n</head>`);
    assert.equal(beaconTagsIn(html).length, 1, "the pasted shape must be recognised as a beacon");
    const built = withBeacon(html, beaconToken(TOKEN));
    assert.equal(beaconTagsIn(built).length, 1, `one beacon must ship for: ${shape.slice(0, 40)}`);
    assert.equal(assertSingleBeacon(built, "signin.html"), built);
    assert.ok(!built.includes(OTHER_TOKEN), "the old token is replaced, not added to");
    assert.ok(built.includes(TOKEN), "the setting's token is the one that ships");
  }
});

test("a foreign analytics script is not the beacon and does not fail the build", () => {
  // A page can carry a script from somewhere else. It is not a Cloudflare beacon,
  // so the build neither strips it nor counts it: the gate is one *beacon*, and
  // the site owns which other scripts it runs.
  const foreign =
    '<script defer src="https://example.com/analytics/rum.js" data-site="1"></script>';
  const html = read("public/signin.html").replace("</head>", `  ${foreign}\n</head>`);
  const built = withBeacon(html, beaconToken(TOKEN));
  assert.equal(beaconTagsIn(built).length, 1, "the foreign script is not a beacon");
  assert.equal(
    assertSingleBeacon(built, "signin.html"),
    built,
    "the build's gate lets a foreign script through, because it counts beacons",
  );
  assert.ok(built.includes(foreign), "the foreign script is left where the page put it");
});

test("a page with no </head> fails the build instead of shipping no beacon", () => {
  assert.throws(
    () => withBeacon("<html><body>no head here</body></html>", beaconToken(TOKEN)),
    /<\/head>/,
  );
});

test("the tag is safe to build from any caller: the shape check travels with it", () => {
  // withBeacon and beaconTag are exported, and a caller can reach them without
  // going through beaconToken. The shape check lives in beaconTag itself, so a
  // token that is not the dashboard's shape fails there rather than becoming a
  // tag that carries it into a JSON attribute unescaped.
  for (const bad of ["not-a-token", "'; document.write(pwned); //", TOKEN.slice(0, 31)]) {
    assert.throws(
      () => beaconTag(bad),
      new RegExp(BEACON_TOKEN_SETTING),
      `${bad} must not become a tag`,
    );
    assert.throws(() => withBeacon("<html><head></head></html>", bad), /<\/head>|expected 32/);
  }
  assert.equal(beaconTag(""), "");
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
  assert.match(config, /assertSingleBeacon\(/, "the build gates what it wrote, not just the input");
  assert.match(config, /from "\.\/src\/analytics\.js"/);
  assert.match(config, /webAnalyticsBeacon\(\)/, "vite.config.ts must register the beacon plugin");
  assert.match(config, /process\.env\[BEACON_TOKEN_SETTING\]/, "the token comes from the setting");
  assert.match(config, /BEACON_PAGES/, "the plugin walks the page list, not a copy of it");
});

test("the build's self-check passes on one beacon and fails on zero or two", () => {
  // assertSingleBeacon is the gate the build runs on its own output, so this file
  // proves the gate catches what a page count alone does not: a page the walk
  // wrote nothing to (0), and a page that ended up with the paste test's shape
  // and a new tag (2). Both are failures in the shipped page, not in the code.
  const [name, html] = shippedPages()[0];
  const built = withBeacon(html, beaconToken(TOKEN));
  assert.equal(assertSingleBeacon(built, name), built, "one beacon passes the build's gate");
  assert.throws(
    () => assertSingleBeacon(html, name),
    new RegExp(`${name} carries 0`),
    "no beacon fails the build, and the count is in the message",
  );
  assert.throws(
    () => assertSingleBeacon(`${built}\n${beaconTag(OTHER_TOKEN)}`, name),
    new RegExp(`${name} carries 2`),
    "two beacons fail the build, so a paste the strip missed cannot ship",
  );
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
  assert.deepEqual(budgets["categories:accessibility"], ["error", { minScore: 1 }]);
});

test("Lighthouse asserts SEO 1.0 on the pricing page, which is the one crawlers index", () => {
  // The other five collected URLs are noindex, so an SEO score of 1.0 on them
  // would fail the is-crawlable audit. The matrix pins the public page only.
  const matrix = JSON.parse(read("lighthouserc.json")).ci.assert.assertMatrix;
  assert.equal(matrix.length, 1);
  assert.equal(matrix[0].matchingUrlPattern, "http://localhost/index\\.html$");
  assert.deepEqual(matrix[0].assertions["categories:seo"], ["error", { minScore: 1 }]);
});
