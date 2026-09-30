// The public-page discovery metadata (drive issue #37) is a decision, not a
// suggestion, so it is pinned here: the canonical origin, the Open Graph and
// Twitter tags, the JSON-LD, sitemap.xml, robots.txt and llms.txt are all
// built from src/seo.js and compared against the files that actually ship. A
// later run cannot quietly drop the canonical URL, point the share card at a
// 404, or let the structured data disagree with the config, because this fails.
//
// The pricing copy gate is test/pricing-copy.test.mjs; the bill numbers this
// file also states are in src/seo.js (BILLING), which records why it does not
// import src/pricing.js (issue #23 owns that).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import {
  BILLING,
  PAGES,
  SITE,
  absoluteUrl,
  pageUrl,
  softwareApplicationLd,
} from "../src/seo.js";

const publicDir = new URL("../public/", import.meta.url);
const read = (name) => readFileSync(new URL(name, publicDir), "utf8");

// The first-run page is a Vite entry at the repo root (issue #70): it is built
// (its <script type="module"> is bundled) rather than copied verbatim out of
// public/, so it ships from the root and the metadata tests read it there.
// Every other page is still a verbatim public/ asset.
const ROOT_PAGES = new Set(["get-started.html"]);
const rootDir = new URL("../", import.meta.url);
const pageUrlFor = (name) =>
  ROOT_PAGES.has(name) ? new URL(name, rootDir) : new URL(name, publicDir);
const readPage = (name) => readFileSync(pageUrlFor(name), "utf8");
const pageExists = (name) => existsSync(pageUrlFor(name));

// Every shipped HTML page, from the config, not from the directory, so a page
// that ships without being added to src/seo.js fails the first test below.
const indexablePages = PAGES.filter((page) => page.indexable);
const fileFor = (page) => page.path.replace(/^\//, "") || "index.html";

// These read hand-maintained HTML, so they assume double-quoted attributes in
// a fixed order. That is a real (small) coupling to the file's formatting, not
// a claim that the repo uses an HTML parser; the shipped markup is stable and
// the pricing-copy gate reads the same file the same way.
function meta(page, attribute, name) {
  const match = page.match(
    new RegExp(`<meta\\s+${attribute}="${name}"\\s+content="([^"]*)"`, "i"),
  );
  return match ? match[1] : null;
}

function link(page, rel) {
  const match = page.match(new RegExp(`<link\\s+rel="${rel}"\\s+href="([^"]*)"`, "i"));
  return match ? match[1] : null;
}

test("every shipped HTML page is registered in src/seo.js", () => {
  // The site ships pages from two places (issue #70): the verbatim assets in
  // public/ and the built Vite entries at the repo root, so both are walked.
  const shipped = [
    ...readdirSync(publicDir).filter((name) => name.endsWith(".html")),
    ...[...ROOT_PAGES].filter((name) => pageExists(name)),
  ].sort();
  const registered = PAGES.map(fileFor).sort();
  assert.deepEqual(
    shipped,
    registered,
    "a public page must be added to PAGES with its own indexable flag, so its metadata is filled in rather than inherited",
  );
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
    assert.ok(
      description.trim().length > 0,
      `${name} needs a non-empty meta description`,
    );
    assert.equal(titles.has(title[1]), false, `duplicate title on ${name}`);
    assert.equal(
      descriptions.has(description),
      false,
      `duplicate meta description on ${name}`,
    );
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
    assert.equal(
      meta(html, "property", "og:image"),
      absoluteUrl(SITE.ogImagePath),
    );
    assert.equal(meta(html, "property", "og:image:width"), "1200");
    assert.equal(meta(html, "property", "og:image:height"), "630");
    assert.ok(
      meta(html, "property", "og:image:alt"),
      `${name} needs an og:image:alt for screen readers and crawlers`,
    );
  }
  // The share card is one shared asset, so it only has to exist once.
  const image = SITE.ogImagePath.replace(/^\//, "");
  assert.ok(
    existsSync(new URL(image, publicDir)),
    `og:image must ship as public/${image}`,
  );
});

test("every indexable page carries a Twitter summary_large_image card", () => {
  for (const page of indexablePages) {
    const html = readPage(fileFor(page));
    assert.equal(meta(html, "name", "twitter:card"), "summary_large_image");
    assert.equal(meta(html, "name", "twitter:title"), SITE.title);
    assert.equal(
      meta(html, "name", "twitter:image"),
      absoluteUrl(SITE.ogImagePath),
    );
  }
});

test("every indexable page carries a JSON-LD SoftwareApplication matching the config", () => {
  for (const page of indexablePages) {
    const name = fileFor(page);
    const html = readPage(name);
    const block = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i,
    );
    assert.ok(block, `${name} must carry a JSON-LD block`);
    let parsed;
    assert.doesNotThrow(
      () => {
        parsed = JSON.parse(block[1]);
      },
      `${name} JSON-LD must be valid JSON, not JS with a JSON content type`,
    );
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
      `${name} is flagged non-indexable in src/seo.js, so it must declare noindex`,
    );
    assert.equal(
      sitemap.includes(pageUrl(page)),
      false,
      `${name} is noindex and must not appear in the sitemap`,
    );
  }
});

test("the JSON-LD offer carries the ceiling as a real per-unit price", () => {
  const { offers } = softwareApplicationLd();
  assert.equal(offers["@type"], "Offer");
  // The price is the one-TB-month ceiling, not the 2¢ rate: a bare 0.02 here
  // would be read as "this product costs two cents", which the page refutes.
  assert.equal(offers.price, BILLING.capFloorUsd.toFixed(2));
  assert.ok(Number(offers.price) > 0, "offers.price must be a positive number");
  assert.equal(offers.priceCurrency, "USD");
  assert.equal(offers.priceSpecification["@type"], "UnitPriceSpecification");
  assert.equal(offers.priceSpecification.unitText, "TB-month");
  assert.equal(offers.priceSpecification.price, offers.price);
  assert.ok(
    offers.description.includes(BILLING.ceiling),
    "the offer description must state the ceiling sentence from config",
  );
});

test("sitemap.xml lists exactly the indexable pages, on the canonical origin", () => {
  const sitemap = read("sitemap.xml");
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    locations,
    indexablePages.map(pageUrl),
    "the sitemap must list exactly the indexable pages, at their canonical URLs",
  );
  for (const location of locations) {
    assert.equal(new URL(location).origin, SITE.origin);
  }
  // Google's parser rejects the file outright if the namespace is missing.
  assert.match(
    sitemap,
    /<urlset[^>]+xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/,
  );
});

test("robots.txt allows the crawl and points at the sitemap", () => {
  const robots = read("robots.txt");
  // This file ships as an asset so it is served ahead of Cloudflare's managed
  // content-signal robots.txt; a syntax error here is what would break that.
  assert.match(robots, /^User-agent: \*\nAllow: \/$/m);
  assert.match(
    robots,
    new RegExp(`^Sitemap: ${absoluteUrl(SITE.sitemapPath)}$`, "m"),
  );
  // A robots.txt that blocks the page it is meant to advertise fails the SEO
  // audit, so nothing may disallow the site root.
  assert.doesNotMatch(robots, /^Disallow: \/$/m);
});

test("llms.txt describes the drive and the current price rule", () => {
  const llms = read("llms.txt");
  // The llmstxt.org shape: an H1 name, a blockquote summary, then sections.
  assert.match(llms, /^# Drive$/m);
  assert.match(llms, /^> /m);
  assert.ok(
    llms.includes(BILLING.ceiling),
    "llms.txt must state the ceiling sentence from config",
  );
  assert.ok(
    llms.includes(BILLING.freeLine),
    "llms.txt must state the free line from config",
  );
  assert.ok(llms.includes(absoluteUrl(SITE.homePath)), "llms.txt links the page");
  // The spec's own worked figures, so an answer engine cannot quote a number
  // the pricing page contradicts. Each is min(metered, max($12, $8 x TB)).
  for (const figure of [
    "800 GB kept all month = $12", // min(16, 12)
    "1.6 TB = $12.80", // min(32, 12.80)
    "2 TB = $16", // min(40, 16)
    "5 TB = $40", // min(100, 40)
  ]) {
    assert.ok(llms.includes(figure), `llms.txt must carry "${figure}"`);
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

test("the ceiling in the metadata is the spec's plateau, not per-TB caps", () => {
  // docs/spec.md and docs/build-spec.md ("Bill ceiling", Nish 2026-09-30,
  // issue #29): the monthly bill is min(metered, max($12, $8 x peak TB)). The
  // cap is flat at $12 until 1.5 TB and only then rises at $8 a TB. If the
  // spec is restated, the metadata has to match, so a re-priced product cannot
  // keep serving the old ceiling to crawlers.
  assert.equal(BILLING.capFloorUsd, 12);
  assert.equal(BILLING.capUsdPerTb, 8);
  assert.match(
    BILLING.ceiling,
    /Never more than \$12 a TB, then \$8\.$/,
    "the ceiling sentence must be the spec's sentence",
  );
  // The rule string spells out the plateau, so no consumer of the config can
  // read the numbers back as "$12 for the first TB, then $8 each after".
  assert.match(BILLING.rule, /\$12 up to 1\.5 TB, then \$8 for each TB after\./);
});
