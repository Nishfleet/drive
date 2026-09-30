// Public-page SEO/AEO metadata: one source of truth for the canonical origin,
// the discovery tags, and the JSON-LD. The pricing page is a static asset, so
// test/seo.test.mjs builds its expectations from this config and fails CI when
// the shipped public/ files drift from it. That is the same gate
// test/pricing-copy.test.mjs runs for the visible copy, and the reason the
// shipped files are hand-written rather than generated: the site is one
// prebuilt HTML document, not an app that renders a route per request.
//
// PRICE, and how it relates to src/pricing.js: the numbers below are the
// ceiling the site advertises now, 2¢/GB by the minute with the bill never
// passing max($12, $8 x TB) — "$12 a TB, then $8". That is the rule in
// docs/spec.md and docs/build-spec.md ("Bill ceiling", Nish 2026-09-30, issue
// #29) and the price the owner named for these tags in issue #37.
//
// src/pricing.js still carries the superseded per-TB caps ($15 first TB) and
// is issue #23's to fix; that branch is in flight, so this file deliberately
// does not import it. The two converge when #23 lands, and the follow-up
// issue filed with this PR folds these numbers into src/pricing.js then, so
// the price has one home rather than two.
const SITE_ORIGIN = "https://drive-pricing.nishant345.workers.dev";
const SITE_NAME = "Drive";
const SITE_TITLE = "Drive — about $20 per TB a month";
// The same sentence the page's own meta description already carries, so the
// search result, the share card and the page agree word for word.
const SITE_DESCRIPTION =
  "A Finder drive for people and their agents. 2¢ per GB, billed by the minute. Never more than $12 a TB, then $8.";

export const BILLING = Object.freeze({
  // The metered rate, in US dollars per GB per month, carried as a string
  // because that is the form schema.org documents for a price and it renders
  // identically here, in the inline JSON-LD and in a Rich Results test.
  rateUsdPerGbMonth: "0.02",
  // The bill ceiling: the first TB never passes $12, each TB after never $8.
  capFirstTbUsd: 12,
  extraTbUsd: 8,
  freeMonthlyUsd: 1,
  // Both sentences interpolated from the numbers above, so one edit moves the
  // tags, the JSON-LD and llms.txt together.
  ceiling: "2¢ per GB, billed by the minute. Never more than $12 a TB, then $8.",
  freeLine: "$1 free every month, no card needed",
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

/** The URL a crawler treats as canonical, and the one a share card points at. */
export function canonicalUrl() {
  return `${SITE.origin}${SITE.homePath}`;
}

export function ogImageUrl() {
  return `${SITE.origin}${SITE.ogImagePath}`;
}

export function sitemapUrl() {
  return `${SITE.origin}${SITE.sitemapPath}`;
}

/**
 * The JSON-LD for the pricing page, as a JS object. schema.org's
 * SoftwareApplication carries the price, so a Rich Results test and an
 * AI-answer crawler read the same ceiling the prose states.
 * @returns {Record<string, unknown>}
 */
export function softwareApplicationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE.name,
    applicationCategory: "BusinessApplication",
    operatingSystem: "macOS, Linux",
    description: SITE.description,
    url: canonicalUrl(),
    image: ogImageUrl(),
    offers: {
      "@type": "Offer",
      // 2¢ per GB-month, in dollars: schema.org has no "per GB-month" unit, so
      // UnitPriceSpecification carries the unit and the description names the
      // ceiling the page advertises.
      price: BILLING.rateUsdPerGbMonth,
      priceCurrency: "USD",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: BILLING.rateUsdPerGbMonth,
        priceCurrency: "USD",
        unitText: "GB per month",
      },
      description: `${BILLING.ceiling} The bill never passes $${BILLING.capFirstTbUsd} for the first TB or $${BILLING.extraTbUsd} for each TB after.`,
    },
  };
}
