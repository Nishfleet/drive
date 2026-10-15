import site from "../cmd/drive/site.json" with { type: "json" };
import { LEGAL_PAGES } from "./legal.js";
import { PRICE } from "./pricing.js";

const SITE_ORIGIN = site.origin;
const SITE_NAME = "Storagebun";
const SITE_TITLE = `Storagebun — ${PRICE.titleLine}`;
const SITE_DESCRIPTION = `A Finder drive for people and their agents. ${PRICE.headline}`;

export const BILLING = Object.freeze({
  rateUsdPerGbMonth: PRICE.rateUsdPerGbMonth.toFixed(2),
  maxUsdPerTb: PRICE.maxUsdPerTb,
  headline: PRICE.headline,
  noPlansLine: PRICE.noPlansLine,
  rule: PRICE.rule,
});

export const SITE = Object.freeze({
  origin: SITE_ORIGIN,
  name: SITE_NAME,
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  homePath: "/",
  ogImagePath: "/og.png",
  faviconPath: "/favicon.svg",
  robotsPath: "/robots.txt",
  sitemapPath: "/sitemap.xml",
  llmsPath: "/llms.txt",
});

/**
 * One shipped HTML page. `root` names the pages that ship as built Vite
 * entries from the repo root rather than as verbatim assets copied out of
 * public/ (drive issue #70). Every entry without it is a public/ asset.
 * `file` names the public/ file a clean URL is served from (the asset layer
 * serves /terms from terms.html); without it the file is the path itself.
 * @typedef {{ path: string, indexable: boolean, root?: boolean, file?: string }} Page
 */

/** @type {readonly Page[]} */
export const PAGES = Object.freeze([
  Object.freeze({ path: "/", indexable: true }),
  Object.freeze({ path: "/starter.html", indexable: true }),
  ...LEGAL_PAGES.map((page) =>
    Object.freeze({ path: page.path, file: page.file, indexable: true }),
  ),
  Object.freeze({ path: "/get-started.html", indexable: false, root: true }),
  Object.freeze({ path: "/home.html", indexable: false }),
  Object.freeze({ path: "/files.html", indexable: false }),
  Object.freeze({ path: "/usage.html", indexable: false }),
  Object.freeze({ path: "/billing.html", indexable: false }),
  Object.freeze({ path: "/devices.html", indexable: false }),
  Object.freeze({ path: "/webhooks.html", indexable: false }),
  Object.freeze({ path: "/upload.html", indexable: false }),
  Object.freeze({ path: "/signin.html", indexable: false }),
  Object.freeze({ path: "/og-card.html", indexable: false }),
  Object.freeze({ path: "/404.html", indexable: false }),
  Object.freeze({ path: "/500.html", indexable: false }),
]);

/** @type {readonly string[]} */
export const ROOT_PAGES = Object.freeze(
  PAGES.filter((page) => page.root).map((page) => page.path.replace(/^\//, "")),
);

export const DOC_PAGES = Object.freeze([
  Object.freeze({ title: "Quickstart", path: "/docs/quickstart" }),
  Object.freeze({ title: "How it works", path: "/docs/how-it-works" }),
  Object.freeze({ title: "Agents", path: "/docs/agents" }),
  Object.freeze({ title: "Pricing and your bill", path: "/docs/pricing" }),
  Object.freeze({ title: "FAQ", path: "/docs/faq" }),
  Object.freeze({ title: "When something goes wrong", path: "/docs/troubleshooting" }),
  Object.freeze({ title: "Limits", path: "/docs/limits" }),
  Object.freeze({ title: "API reference", path: "/docs/api" }),
  Object.freeze({ title: "Webhooks", path: "/docs/webhooks" }),
  Object.freeze({ title: "Benchmarks", path: "/docs/benchmarks" }),
  Object.freeze({ title: "Security", path: "/docs/security" }),
  Object.freeze({ title: "Changelog", path: "/docs/changelog" }),
]);

/** The absolute URL of a public page, from its site-relative path.
 * @param {{title?: string, path: string, indexable?: boolean}} page
 * @returns {string}
 */
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
 * AI-answer crawler read the same maximum the prose states.
 *
 * On the shape: a metered product has no single product price, so `price` is
 * the maximum for one TB-month rather than the 2¢ rate. A bare 0.02 in
 * `price` would be read as "this whole product costs two cents", which is the
 * opposite of the page. UnitPriceSpecification carries the unit, and the
 * description carries the full rule, so nothing in the markup is a bare number
 * a reader could take at face value.
 * @returns {{
 *   "@context": string,
 *   "@type": string,
 *   name: string,
 *   applicationCategory: string,
 *   operatingSystem: string,
 *   description: string,
 *   url: string,
 *   image: string,
 *   offers: {
 *     "@type": string,
 *     price: string,
 *     priceCurrency: string,
 *     priceSpecification: { "@type": string, price: string, priceCurrency: string, unitText: string },
 *     description: string,
 *   },
 * }}
 */
export function softwareApplicationLd() {
  const price = BILLING.maxUsdPerTb.toFixed(2);
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
      description: `${BILLING.headline} ${BILLING.rule}`,
    },
  };
}
