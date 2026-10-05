// The public-page discovery metadata (drive issue #37) is a decision, not a
// suggestion, so it is pinned here: the canonical origin, the Open Graph and
// Twitter tags, the JSON-LD, sitemap.xml, robots.txt and llms.txt are all
// built from core/seo.js and compared against the files that actually ship. A
// later run cannot quietly drop the canonical URL, point the share card at a
// 404, or let the structured data disagree with the config, because this fails.
//
// The price copy gate is test/pricing-copy.test.mjs. The bill numbers this
// file also states are read from core/pricing.js (PRICE), the one price source
// core/seo.js builds BILLING from (issue #23), so a re-priced product moves the
// tags, the JSON-LD and llms.txt together with the visible copy.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { monthlyBillForStoredTb } from "../core/billing.js";
import { PRICE } from "../core/pricing.js";
import {
  absoluteUrl,
  BILLING,
  DOC_PAGES,
  PAGES,
  pageUrl,
  ROOT_PAGES,
  SITE,
  softwareApplicationLd,
} from "../core/seo.js";

const publicDir = new URL("../public/", import.meta.url);
/** @param {string} name */
const read = (name) => readFileSync(new URL(name, publicDir), "utf8");

// Dollars the way the page and llms.txt write them: no cents where there are
// none, cents where the rule produces them ($10.01). The same shape
// test/pricing-copy.test.mjs uses, so the two gates quote identical strings.
/** @param {number} usd */
const dollars = (usd) => `$${usd.toFixed(2).replace(/\.00$/, "")}`;

// A page ships from one of two places (issue #70): the verbatim assets in
// public/, and the built Vite entries at the repo root. Which one is the
// question core/seo.js's PAGES answers per page, so ROOT_PAGES is read from
// there instead of this file keeping a second list of its own. A flag that
// calls a page a "public/ asset" while the build compiles it from the root is
// exactly the drift this file exists to catch, and a test-local copy of that
// fact is a second place to get it wrong.
const rootDir = new URL("../", import.meta.url);
/** @param {string} name */
const fileUrl = (name) =>
  ROOT_PAGES.includes(name) ? new URL(name, rootDir) : new URL(name, publicDir);
/** @param {string} name */
const readPage = (name) => readFileSync(fileUrl(name), "utf8");

// Every shipped HTML page, from the config, not from the directory, so a page
// that ships without being added to core/seo.js fails the first test below.
const indexablePages = PAGES.filter((page) => page.indexable);
/** @param {{path: string}} page */
const fileFor = (page) => page.path.replace(/^\//, "") || "index.html";

// These read hand-maintained HTML, so they assume double-quoted attributes in
// a fixed order. That is a real (small) coupling to the file's formatting, not
// a claim that the repo uses an HTML parser; the shipped markup is stable and
// the pricing-copy gate reads the same file the same way.
/**
 * @param {string} page
 * @param {string} attribute
 * @param {string} name
 */
function meta(page, attribute, name) {
  const match = page.match(new RegExp(`<meta\\s+${attribute}="${name}"\\s+content="([^"]*)"`, "i"));
  return match ? match[1] : null;
}

/**
 * @param {string} page
 * @param {string} rel
 */
function link(page, rel) {
  const match = page.match(new RegExp(`<link\\s+rel="${rel}"\\s+href="([^"]*)"`, "i"));
  return match ? match[1] : null;
}

test("every shipped HTML page is registered in PAGES (core/seo.js)", () => {
  // The site ships pages from two places (issue #70): the verbatim assets in
  // public/ and the built Vite entries at the repo root, so both are walked.
  // ROOT_PAGES is core/seo.js's, so the walk and the list cannot disagree.
  const shipped = [
    ...readdirSync(publicDir).filter((name) => name.endsWith(".html")),
    ...ROOT_PAGES,
  ].sort();
  const registered = PAGES.map(fileFor).sort();
  assert.deepEqual(
    shipped,
    registered,
    "a public page must be added to PAGES with its own indexable flag, so its metadata is filled in rather than inherited",
  );
});

test("every page in PAGES ships from the source its flag names", () => {
  // The drift that needed a list of its own: get-started.html moved from public/
  // to the repo root as a built Vite entry (issue #70), and PAGES went on
  // describing it as a public/ asset while the reading code branched around
  // that. This checks the flag against the tree, so a page registered against a
  // source that does not carry it fails rather than being tolerated, AND it
  // checks the opposite source does not also carry a stale copy, because a
  // page that ships twice is the same drift.
  for (const page of PAGES) {
    const name = fileFor(page);
    const inPublic = existsSync(new URL(name, publicDir));
    const inRoot = existsSync(new URL(name, rootDir));
    if (page.root) {
      assert.ok(
        inRoot,
        `${page.path} is registered as a built Vite entry at the repo root, but ${name} does not exist there`,
      );
      assert.ok(
        !inPublic,
        `${page.path} is registered as a built Vite entry at the repo root, so public/${name} must not also exist: a page that ships twice is drift`,
      );
    } else {
      assert.ok(
        inPublic,
        `${page.path} is registered as a public/ asset, but public/${name} does not exist`,
      );
      assert.ok(
        !inRoot,
        `${page.path} is registered as a public/ asset, so ${name} must not also exist at the repo root: a page that ships twice is drift`,
      );
    }
  }
});

test("every public page has a unique title and meta description", () => {
  const titles = new Set();
  const descriptions = new Set();
  for (const page of PAGES) {
    const name = fileFor(page);
    const html = readPage(name);
    const title = html.match(/<title>([^<]*)<\/title>/i);
    assert.ok(title, `${name} must have a <title>`);
    const description = meta(html, "name", "description");
    assert.ok(description, `${name} must have a meta description`);
    assert.ok(title[1].trim().length > 0, `${name} needs a non-empty title`);
    assert.ok(description.trim().length > 0, `${name} needs a non-empty meta description`);
    assert.equal(titles.has(title[1]), false, `duplicate title on ${name}`);
    assert.equal(descriptions.has(description), false, `duplicate meta description on ${name}`);
    titles.add(title[1]);
    descriptions.add(description);
  }
});

test("every indexable page names its own canonical URL", () => {
  for (const page of indexablePages) {
    const name = fileFor(page);
    const canonical = link(readPage(name), "canonical");
    assert.equal(
      canonical,
      pageUrl(page),
      `${name} must have <link rel="canonical"> for its own URL`,
    );
  }
});

test("every indexable page carries a complete Open Graph card that resolves", () => {
  for (const page of indexablePages) {
    const name = fileFor(page);
    const html = readPage(name);
    assert.equal(meta(html, "property", "og:title"), SITE.title);
    assert.equal(meta(html, "property", "og:description"), SITE.description);
    assert.equal(meta(html, "property", "og:url"), pageUrl(page));
    assert.equal(meta(html, "property", "og:type"), "website");
    assert.equal(meta(html, "property", "og:image"), absoluteUrl(SITE.ogImagePath));
    assert.equal(meta(html, "property", "og:image:width"), "1200");
    assert.equal(meta(html, "property", "og:image:height"), "630");
    assert.ok(
      meta(html, "property", "og:image:alt"),
      `${name} needs an og:image:alt for screen readers and crawlers`,
    );
  }
  // The share card is one shared asset, so it only has to exist once.
  const image = SITE.ogImagePath.replace(/^\//, "");
  assert.ok(existsSync(new URL(image, publicDir)), `og:image must ship as public/${image}`);
});

test("every indexable page carries a Twitter summary_large_image card", () => {
  for (const page of indexablePages) {
    const html = readPage(fileFor(page));
    assert.equal(meta(html, "name", "twitter:card"), "summary_large_image");
    assert.equal(meta(html, "name", "twitter:title"), SITE.title);
    assert.equal(meta(html, "name", "twitter:image"), absoluteUrl(SITE.ogImagePath));
  }
});

test("every indexable page carries a JSON-LD SoftwareApplication matching the config", () => {
  for (const page of indexablePages) {
    const name = fileFor(page);
    const html = readPage(name);
    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    assert.ok(block, `${name} must carry a JSON-LD block`);
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(block[1]);
    }, `${name} JSON-LD must be valid JSON, not JS with a JSON content type`);
    // The whole object, so a stale or invented field fails rather than passing
    // because the two types happen to agree.
    assert.deepStrictEqual(parsed, softwareApplicationLd());
  }
});

test("every non-indexable page is noindex and stays out of the sitemap", () => {
  const sitemap = read("sitemap.xml");
  for (const page of PAGES.filter((p) => !p.indexable)) {
    const name = fileFor(page);
    const robots = meta(readPage(name), "name", "robots") || "";
    assert.match(
      robots,
      /noindex/i,
      `${name} is flagged non-indexable in PAGES, so it must declare noindex`,
    );
    assert.equal(
      sitemap.includes(pageUrl(page)),
      false,
      `${name} is noindex and must not appear in the sitemap`,
    );
  }
});

test("the JSON-LD offer carries the maximum as a real per-unit price", () => {
  const { offers } = softwareApplicationLd();
  assert.equal(offers["@type"], "Offer");
  // The price is the one-TB-month maximum, not the 2¢ rate: a bare 0.02 here
  // would be read as "this product costs two cents", which the page refutes.
  assert.equal(offers.price, BILLING.maxUsdPerTb.toFixed(2));
  assert.ok(Number(offers.price) > 0, "offers.price must be a positive number");
  assert.equal(offers.priceCurrency, "USD");
  assert.equal(offers.priceSpecification["@type"], "UnitPriceSpecification");
  assert.equal(offers.priceSpecification.unitText, "TB-month");
  assert.equal(offers.priceSpecification.price, offers.price);
  assert.ok(
    offers.description.includes(BILLING.headline),
    "the offer description must state the headline from config",
  );
});

test("sitemap.xml lists exactly the indexable pages, on the canonical origin", () => {
  const sitemap = read("sitemap.xml");
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  // The docs pages (drive issue #98) are read from the same config, so a docs
  // page that ships without being listed here fails this test.
  const expected = [
    ...indexablePages.map(pageUrl),
    ...DOC_PAGES.map((page) => absoluteUrl(page.path)),
  ];
  assert.deepEqual(
    locations,
    expected,
    "the sitemap must list exactly the indexable pages and the docs pages, at their canonical URLs",
  );
  for (const location of locations) {
    assert.equal(new URL(location).origin, SITE.origin);
  }
  // Google's parser rejects the file outright if the namespace is missing.
  assert.match(sitemap, /<urlset[^>]+xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
});

test("robots.txt allows the crawl and points at the sitemap", () => {
  const robots = read("robots.txt");
  // This file ships as an asset so it is served ahead of Cloudflare's managed
  // content-signal robots.txt; a syntax error here is what would break that.
  assert.match(robots, /^User-agent: \*\nAllow: \/$/m);
  assert.match(robots, new RegExp(`^Sitemap: ${absoluteUrl(SITE.sitemapPath)}$`, "m"));
  // A robots.txt that blocks the page it is meant to advertise fails the SEO
  // audit, so nothing may disallow the site root.
  assert.doesNotMatch(robots, /^Disallow: \/$/m);
});

test("llms.txt describes the drive and the current price rule", () => {
  const llms = read("llms.txt");
  // The llmstxt.org shape: an H1 name, a blockquote summary, then sections.
  assert.match(llms, /^# Drive$/m);
  assert.match(llms, /^> /m);
  assert.ok(llms.includes(BILLING.headline), "llms.txt must state the headline from config");
  assert.ok(llms.includes(BILLING.rule), "llms.txt must state the rule from config");
  assert.ok(
    llms.includes(BILLING.noPlansLine),
    "llms.txt must state the no-minimum line from config",
  );
  assert.ok(llms.includes(absoluteUrl(SITE.homePath)), "llms.txt links the page");
  // The issue's worked figures, so an answer engine cannot quote a number the
  // pricing page contradicts, each from the one bill function (drive#463).
  for (const row of PRICE.examples) {
    const bill = monthlyBillForStoredTb((row.toGb ?? row.gb) / 1000);
    assert.ok(
      llms.includes(`- ${row.label} = ${dollars(bill.billUsd)} (`),
      `llms.txt must carry the ${dollars(bill.billUsd)} bill for ${row.label}`,
    );
  }
  // No claim the page itself is not allowed to make.
  assert.doesNotMatch(llms, /unlimited/i);
  assert.doesNotMatch(llms, /\bcredits?\b/i);
  assert.doesNotMatch(llms, /SOC 2/);
});

test("every file the metadata points at is one this site actually ships", () => {
  // A dangling reference is the failure mode a config can hide: the tags are
  // generated-looking, so only a test that walks the URLs catches it.
  for (const path of [
    SITE.homePath,
    SITE.ogImagePath,
    SITE.robotsPath,
    SITE.sitemapPath,
    SITE.llmsPath,
  ]) {
    const file = path.replace(/^\//, "") || "index.html";
    assert.ok(
      existsSync(new URL(file, publicDir)),
      `${path} is referenced but public/${file} does not exist`,
    );
  }
});

test("the maximum in the metadata is the issue's rule, from the one price source", () => {
  // drive#463 (Nish 2026-10-04): min(2¢ x avg GB, $10 x max(1, avg TB)). The
  // numbers and the sentences come from core/pricing.js, so a price change is
  // one edit there and it moves the tags, the JSON-LD, llms.txt and the
  // visible copy together (issue #23).
  assert.equal(PRICE.rateUsdPerGbMonth, 0.02);
  assert.equal(PRICE.maxUsdPerTb, 10);
  // BILLING is built from PRICE, not declared beside it.
  assert.equal(BILLING.maxUsdPerTb, PRICE.maxUsdPerTb);
  assert.equal(BILLING.headline, PRICE.headline);
  assert.equal(BILLING.noPlansLine, PRICE.noPlansLine);
  assert.equal(BILLING.rule, PRICE.rule);
  assert.equal(
    BILLING.headline,
    "Add $10 or more. Pay 2 cents per GB from your balance. Never more than $10 per TB.",
  );
  // The superseded rules may not come back through the tags: the $12 floor,
  // the $8 slope, the 1.5 TB plateau and the membership.
  for (const text of [BILLING.headline, BILLING.rule, SITE.description]) {
    assert.doesNotMatch(text, /\$12|\$8 a TB|1\.5 TB|membership|ceiling/i);
  }
});
