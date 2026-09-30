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
import { fileURLToPath } from "node:url";
import {
  BILLING,
  SITE,
  canonicalUrl,
  ogImageUrl,
  sitemapUrl,
  softwareApplicationLd,
} from "../src/seo.js";

const publicDir = new URL("../public/", import.meta.url);
const read = (name) => readFileSync(new URL(name, publicDir), "utf8");

// Every shipped HTML page. A new public page is picked up by this list, so its
// title, description and canonical have to be filled in rather than inherited.
const htmlPages = readdirSync(publicDir).filter((name) => name.endsWith(".html"));

function meta(page, attribute, name) {
  const match = page.match(
    new RegExp(`<meta\\s+${attribute}="${name}"\\s+content="([^"]*)"`, "i"),
  );
  return match ? match[1] : null;
}

function link(page, rel, href) {
  const match = page.match(
    new RegExp(`<link\\s+rel="${rel}"\\s+href="([^"]*)"`, "i"),
  );
  return match ? match[1] : null;
}

test("the site has exactly one public HTML page, and it is the pricing page", () => {
  assert.deepEqual(htmlPages, ["index.html"]);
});

test("every public page has a unique title and meta description", () => {
  const titles = new Set();
  const descriptions = new Set();
  for (const name of htmlPages) {
    const page = read(name);
    const title = page.match(/<title>([^<]*)<\/title>/i);
    assert.ok(title, `${name} must have a <title>`);
    const description = meta(page, "name", "description");
    assert.ok(description, `${name} must have a meta description`);
    // Uniqueness across pages is the point of the check, so an empty or
    // repeated value is caught even while there is only one page.
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

test("every public page names the canonical URL, and it is one per page", () => {
  const seen = new Set();
  for (const name of htmlPages) {
    const canonical = link(read(name), "canonical", null);
    assert.ok(canonical, `${name} must have a <link rel="canonical">`);
    assert.equal(seen.has(canonical), false, `duplicate canonical on ${name}`);
    seen.add(canonical);
  }
  assert.deepEqual([...seen], [canonicalUrl()]);
});

test("every public page carries a complete Open Graph card that resolves", () => {
  for (const name of htmlPages) {
    const page = read(name);
    assert.equal(meta(page, "property", "og:title"), SITE.title);
    assert.equal(meta(page, "property", "og:description"), SITE.description);
    assert.equal(meta(page, "property", "og:url"), canonicalUrl());
    assert.equal(meta(page, "property", "og:type"), "website");
    assert.equal(meta(page, "property", "og:image"), ogImageUrl());
    assert.equal(meta(page, "property", "og:image:width"), "1200");
    assert.equal(meta(page, "property", "og:image:height"), "630");
    assert.ok(
      meta(page, "property", "og:image:alt"),
      `${name} needs an og:image:alt for screen readers and crawlers`,
    );
    // A share card that points at a 404 is worse than none, so the image the
    // tags name has to be a real file in the deployed asset tree.
    const image = SITE.ogImagePath.replace(/^\//, "");
    assert.ok(
      existsSync(new URL(image, publicDir)),
      `og:image must ship as public/${image}`,
    );
  }
});

test("every public page carries a Twitter summary_large_image card", () => {
  for (const name of htmlPages) {
    const page = read(name);
    assert.equal(meta(page, "name", "twitter:card"), "summary_large_image");
    assert.equal(meta(page, "name", "twitter:title"), SITE.title);
    assert.equal(meta(page, "name", "twitter:image"), ogImageUrl());
  }
});

test("the JSON-LD is a SoftwareApplication whose price matches the config", () => {
  for (const name of htmlPages) {
    const page = read(name);
    const block = page.match(
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

test("the JSON-LD offers the metered rate and names the bill ceiling", () => {
  const ld = softwareApplicationLd();
  assert.equal(ld["@type"], "SoftwareApplication");
  assert.equal(ld.offers.price, BILLING.rateUsdPerGbMonth);
  assert.equal(ld.offers.priceCurrency, "USD");
  assert.equal(ld.offers.priceSpecification.unitText, "GB per month");
  assert.ok(
    ld.offers.description.includes(BILLING.ceiling),
    "the offer description must state the ceiling the page advertises",
  );
  assert.equal(ld.url, canonicalUrl());
  assert.equal(ld.image, ogImageUrl());
});

test("sitemap.xml lists every public page once, on the canonical origin", () => {
  const sitemap = read("sitemap.xml");
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    locations,
    htmlPages.map(() => canonicalUrl()),
    "the sitemap must list exactly the pages that ship, at their canonical URL",
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
  assert.match(robots, new RegExp(`^Sitemap: ${sitemapUrl()}$`, "m"));
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
  assert.ok(
    llms.includes(canonicalUrl()),
    "llms.txt must link the canonical page",
  );
  // The spec's own worked figures, so an answer engine cannot quote a number
  // the pricing page contradicts.
  for (const figure of ["800 GB kept all month = $12", "2 TB = $16"]) {
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

test("the ceiling in the metadata is the rule the docs state", () => {
  // docs/spec.md and docs/build-spec.md ("Bill ceiling", Nish 2026-09-30,
  // issue #29): the monthly bill is min(metered, max($12, $8 x peak TB)). If
  // that rule is restated in the docs, this metadata has to match it, so a
  // re-priced product cannot keep serving the old ceiling to crawlers.
  assert.equal(BILLING.capFirstTbUsd, 12);
  assert.equal(BILLING.extraTbUsd, 8);
  assert.match(
    BILLING.ceiling,
    /Never more than \$12 a TB, then \$8\.$/,
    "the ceiling sentence must be the spec's sentence",
  );
});
