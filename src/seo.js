// Public-page SEO/AEO metadata: one source of truth for the canonical origin,
// the discovery tags, and the JSON-LD. The pricing page is a static asset, so
// test/seo.test.mjs builds its expectations from this config and fails CI when
// the shipped public/ files drift from it. That is the same gate
// test/pricing-copy.test.mjs runs for the visible copy, and the reason the
// shipped files are hand-written rather than generated: the site is one
// prebuilt HTML document, not an app that renders a route per request.
//
// The price itself is not declared here: src/pricing.js is the one price
// source, and BILLING below is built from PRICE so the tags, the JSON-LD and
// llms.txt render the same numbers and sentences the page does (issue #23).
// The rule (docs/spec.md and docs/build-spec.md, "Bill ceiling", Nish
// 2026-09-30, issue #29):
//
//     bill = min(metered, max($12, $8 x peak TB))
//
// where the metered rate is 2¢/GB-month billed by the minute. Read that as a
// plateau, not as per-TB caps: the cap is a flat $12 until the stored size
// passes 1.5 TB, and only then does it rise at $8 for each TB. So 800 GB bills
// min(16, 12) = $12, 1.6 TB bills min(32, 12.80) = $12.80, 2 TB bills
// min(40, 16) = $16, and 5 TB bills min(100, 40) = $40.
import { PRICE } from "./pricing.js";

const SITE_ORIGIN = "https://drive-pricing.nishant345.workers.dev";
const SITE_NAME = "Drive";
const SITE_TITLE = "Drive — about $20 per TB a month";
// The same sentence the page's own meta description already carries, so the
// search result, the share card and the page agree word for word.
const SITE_DESCRIPTION = `A Finder drive for people and their agents. ${PRICE.ceiling}`;

export const BILLING = Object.freeze({
  // The metered rate, in US dollars per GB per month. Carried as a string
  // because that is the form schema.org documents for a price, so it renders
  // identically in the config, in the inline JSON-LD and to a validator.
  rateUsdPerGbMonth: PRICE.rateUsdPerGbMonth.toFixed(2),
  // The cap is max(capFloorUsd, capUsdPerTb x TB): a flat floor until the
  // stored size passes capFloorUsd / capUsdPerTb TB, then a per-TB slope. The
  // names say plateau and slope so no reader takes them for per-TB caps.
  capFloorUsd: PRICE.capFloorUsd,
  capUsdPerTb: PRICE.capUsdPerTb,
  freeMonthlyUsd: PRICE.freeMonthlyUsd,
  // Both sentences come from the one price source, so one edit moves the tags,
  // the JSON-LD and llms.txt together.
  ceiling: PRICE.ceiling,
  freeLine: PRICE.freeLine,
  // The ceiling as arithmetic, for the offer description and llms.txt. Stated
  // in words as well as symbols because a crawler reads prose, not a formula.
  rule: PRICE.rule,
});

export const SITE = Object.freeze({
  origin: SITE_ORIGIN,
  name: SITE_NAME,
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  // The one public page this site ships, so the sitemap lists exactly this.
  homePath: "/",
  ogImagePath: "/og.png",
  robotsPath: "/robots.txt",
  sitemapPath: "/sitemap.xml",
  llmsPath: "/llms.txt",
});

// Every public HTML page, and whether a crawler should index it. The order is
// the sitemap order. get-started.html is a per-device first-run page a person
// lands on from the CLI, and usage.html is one person's own month: both
// declare <meta name="robots" content="noindex"> and stay out of the sitemap.
// test/seo.test.mjs walks this list, so a new page has to be added here and
// given its own title, description and canonical rather than inheriting this
// page's.
export const PAGES = Object.freeze([
  Object.freeze({ path: "/", indexable: true }),
  Object.freeze({ path: "/get-started.html", indexable: false }),
  // The Web Files page is one person's drive, so it is noindex: a crawler that
  // reached it would see an empty listing, never a public page (issue #31).
  Object.freeze({ path: "/files.html", indexable: false }),
  Object.freeze({ path: "/usage.html", indexable: false }),
]);

/** The absolute URL of a public page, from its site-relative path. */
export function pageUrl(page) {
  return absoluteUrl(page.path);
}

/**
 * A site-root-relative path as the absolute URL a crawler reads it at, so a
 * meta tag, the sitemap and a test never spell an origin out separately.
 * @param {string} path
 */
export function absoluteUrl(path) {
  return `${SITE.origin}${path}`;
}

/**
 * The JSON-LD for the pricing page, as a JS object. schema.org's
 * SoftwareApplication carries the price, so a Rich Results test and an
 * AI-answer crawler read the same ceiling the prose states.
 *
 * On the shape: a metered product has no single product price, so `price` is
 * the bill ceiling for one TB-month rather than the 2¢ rate. A bare 0.02 in
 * `price` would be read as "this whole product costs two cents", which is the
 * opposite of the page. UnitPriceSpecification carries the unit, and the
 * description carries the full rule, so nothing in the markup is a bare number
 * a reader could take at face value.
 * @returns {Record<string, unknown>}
 */
export function softwareApplicationLd() {
  const price = BILLING.capFloorUsd.toFixed(2);
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE.name,
    applicationCategory: "BusinessApplication",
    operatingSystem: "macOS, Linux",
    description: SITE.description,
    url: absoluteUrl(SITE.homePath),
    image: absoluteUrl(SITE.ogImagePath),
    offers: {
      "@type": "Offer",
      price,
      priceCurrency: "USD",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price,
        priceCurrency: "USD",
        unitText: "TB-month",
      },
      description: `${BILLING.ceiling} ${BILLING.rule}`,
    },
  };
}
