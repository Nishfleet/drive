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
// The rule (drive#463, Nish 2026-10-04): pay only for what you store.
//
//     bill = min(2¢ x avg GB, $10 x max(1, avg TB))
//
// So 200 GB bills $4, 500 GB to 1 TB bills $10, 1.5 TB bills $15 and 3 TB
// bills $30. No plans, and the prepaid balance never expires (drive#586).
import { LEGAL_PAGES } from "./legal.js";
import { PRICE } from "./pricing.js";

const SITE_ORIGIN = "https://drive-pricing.nishant345.workers.dev";
const SITE_NAME = "Drive";
const SITE_TITLE = `Drive — ${PRICE.titleLine}`;
// The same sentence the page's own meta description already carries, so the
// search result, the share card and the page agree word for word.
const SITE_DESCRIPTION = `A Finder drive for people and their agents. ${PRICE.headline}`;

export const BILLING = Object.freeze({
  // The metered rate, in US dollars per GB per month. Carried as a string
  // because that is the form schema.org documents for a price, so it renders
  // identically in the config, in the inline JSON-LD and to a validator.
  rateUsdPerGbMonth: PRICE.rateUsdPerGbMonth.toFixed(2),
  // The maximum for each TB stored, never less than one TB's worth.
  maxUsdPerTb: PRICE.maxUsdPerTb,
  // Every sentence comes from the one price source, so one edit moves the
  // tags, the JSON-LD and llms.txt together.
  headline: PRICE.headline,
  noPlansLine: PRICE.noPlansLine,
  // The rule in words, for the offer description and llms.txt, because a
  // crawler reads prose, not a formula.
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

/**
 * One shipped HTML page. `root` names the pages that ship as built Vite
 * entries from the repo root rather than as verbatim assets copied out of
 * public/ (drive issue #70). Every entry without it is a public/ asset.
 * `file` names the public/ file a clean URL is served from (the asset layer
 * serves /terms from terms.html); without it the file is the path itself.
 * @typedef {{ path: string, indexable: boolean, root?: boolean, file?: string }} Page
 */

// Every public HTML page, and whether a crawler should index it. The order is
// the sitemap order. usage.html is one person's own month, and the first-run,
// Web Files, upload-request and sign-in pages are per-device or per-person
// surfaces: each declares <meta name="robots" content="noindex"> and stays
// out of the sitemap. test/seo.test.mjs walks this list, so a new page has to
// be added here and given its own title, description and canonical rather than
// inheriting this page's.
/** @type {readonly Page[]} */
export const PAGES = Object.freeze([
  Object.freeze({ path: "/", indexable: true }),
  // The notes starter (drive issue #15). It is the one public page that is an
  // optional, off-by-default starting point rather than the product's own
  // surface, and the crowd it is for finds it by search, so it is indexable and
  // in the sitemap. Its price line is PRICE's, like every other page's.
  Object.freeze({ path: "/starter.html", indexable: true }),
  // The legal and trust pages (drive#523), at the clean URLs the footers link.
  // src/legal.js is their one list; each is indexable and in the sitemap.
  ...LEGAL_PAGES.map((page) =>
    Object.freeze({ path: page.path, file: page.file, indexable: true }),
  ),
  // The first-run page is a built Vite entry at the repo root, not a public/
  // asset: issue #70 moved it there so cf build compiles the module behind it
  // instead of shipping the page verbatim, and the `root` flag is what tells
  // test/seo.test.mjs where to read it. It is still noindex and out of the
  // sitemap, because it is the per-device screen a person lands on from the
  // CLI rather than a page a crawler has any business on.
  Object.freeze({ path: "/get-started.html", indexable: false, root: true }),
  // The Web Files page is one person's drive, so it is noindex: a crawler that
  // reached it would see an empty listing, never a public page (issue #31).
  Object.freeze({ path: "/files.html", indexable: false }),
  Object.freeze({ path: "/usage.html", indexable: false }),
  // The upload-request page is a stranger's one-folder drop box, reached only
  // from a link the owner minted: noindex so a crawler never finds one
  // (issue #19). It carries its own title and description rather than
  // inheriting the pricing page's.
  Object.freeze({ path: "/upload.html", indexable: false }),
  // The sign-in screen is where a person starts a session, so it is noindex
  // and out of the sitemap: a crawler has no session and nothing to read
  // there (drive#10).
  Object.freeze({ path: "/signin.html", indexable: false }),
  // The share card's source (drive issue #123). It is the 1200x630 canvas
  // public/og.png is rendered from, not a page a person navigates to, so it is
  // noindex and out of the sitemap like the other non-indexable assets; it is
  // registered here because test/seo.test.mjs requires every public HTML page
  // to be, and its copy is gated by test/og-card.test.mjs against PRICE.
  Object.freeze({ path: "/og-card.html", indexable: false }),
  // The asset layer's 404 page (drive#458). Cloudflare serves this file for
  // any path that is not an asset (notFoundHandling: 404-page). It is noindex
  // and out of the sitemap: a crawler should not treat a missing URL as a page.
  Object.freeze({ path: "/404.html", indexable: false }),
  // The site's own 5xx page (drive#584). src/index.js serves this file from
  // app.onError when a page request fails, so a browser gets the site's
  // chrome instead of a bare JSON body. Noindex: an error is not a page.
  Object.freeze({ path: "/500.html", indexable: false }),
]);

// The pages that ship as built Vite entries from the repo root, not as verbatim
// assets out of public/ (drive issue #70), as the file names test/seo.test.mjs
// reads. Derived from PAGES, so the root fact has one home: the flag on the page
// is the source, and the walk in the test checks it against the tree, so a page
// that moves between the two sources, or a flag that is wrong, fails CI instead
// of being tolerated by a second list kept beside it.
/** @type {readonly string[]} */
export const ROOT_PAGES = Object.freeze(
  PAGES.filter((page) => page.root).map((page) => page.path.replace(/^\//, "")),
);

// The docs pages (drive issue #98), as the URLs a crawler reads. The docs are
// built by VitePress from docs-site/, which owns their titles and their
// metadata; this list is the one place the site-level files (the sitemap and
// the root llms.txt) learn that they exist, and src/render-docs.js reads the
// same list, so a page cannot be built without being listed here.
export const DOC_PAGES = Object.freeze([
  Object.freeze({ title: "Quickstart", path: "/docs/quickstart" }),
  Object.freeze({ title: "How it works", path: "/docs/how-it-works" }),
  Object.freeze({ title: "Agents", path: "/docs/agents" }),
  Object.freeze({ title: "Pricing and your bill", path: "/docs/pricing" }),
  Object.freeze({ title: "FAQ", path: "/docs/faq" }),
  Object.freeze({ title: "Limits", path: "/docs/limits" }),
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
