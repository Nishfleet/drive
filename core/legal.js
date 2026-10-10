// The legal and trust pages (drive#523, drive#584): terms, privacy, refunds,
// acceptable use, support, accessibility and status. They are hand-written
// static pages in public/, like every other page on the site, and this file is
// the one list of them, so the footer links, the sitemap, src/seo.js and
// test/legal.test.mjs cannot disagree about which pages exist or where they
// live.
//
// Four facts are the owner's to decide, not a worker's: the payee's legal
// name, the postal address, the refund rule and the VAT line on receipts.
// Each one is a marked placeholder in exactly one page:
//
//     <mark class="to-fill" data-placeholder="<id>">[To fill: ...]</mark>
//
// To fill one, replace that whole <mark> element with the real words. Every
// other page links to the page that holds the fact (the support page for the
// address, the refunds page for the rule), so each fact is typed once.
// test/legal.test.mjs allows no placeholder outside this list and none twice.
// The one fact that IS decided is the support mailbox: SUPPORT_EMAIL below,
// typed once here, read by the support page, security.txt and the share
// landing page's report mail.

/**
 * One legal page: the clean URL a reader and a crawler use, and the public/
 * file the asset layer serves it from.
 * @typedef {{ path: string, file: string, label: string }} LegalPage
 */

/** @type {readonly LegalPage[]} */
export const LEGAL_PAGES = Object.freeze([
  Object.freeze({ path: "/terms", file: "terms.html", label: "Terms" }),
  Object.freeze({ path: "/privacy", file: "privacy.html", label: "Privacy" }),
  Object.freeze({ path: "/refunds", file: "refunds.html", label: "Refunds" }),
  Object.freeze({ path: "/acceptable-use", file: "acceptable-use.html", label: "Acceptable use" }),
  Object.freeze({ path: "/support", file: "support.html", label: "Support" }),
  // drive#584: the two trust pages the launch checklist names that no other
  // issue carries. Both are indexable and linked from every footer.
  Object.freeze({ path: "/accessibility", file: "accessibility.html", label: "Accessibility" }),
  Object.freeze({ path: "/status", file: "status.html", label: "Status" }),
]);

/** Where a person reaches a human, and where abuse reports go. */
export const SUPPORT_PATH = "/support";

/** Where a share link is reported (the report section on the acceptable-use page). */
export const REPORT_PATH = "/acceptable-use#report";

// drive#523 part 2 (drive#883): the one support mailbox, Nish's decision — a
// mailbox on the brand's own domain. Typed once here, so no page grows a
// second spelling and no worker invents an address.
/** The one support mailbox a person can write to. */
export const SUPPORT_EMAIL = "support@storagebun.com";

/**
 * One fact the owner fills in, and the one page that carries it.
 * @typedef {{ id: string, file: string, what: string }} LegalPlaceholder
 */

/** @type {readonly LegalPlaceholder[]} */
export const LEGAL_PLACEHOLDERS = Object.freeze([
  Object.freeze({
    id: "payee-name",
    file: "terms.html",
    what: "The legal name of the person or company that takes the payments.",
  }),
  Object.freeze({
    id: "contact-address",
    file: "support.html",
    what: "The postal address, if the law needs one. The email inbox is decided: support@storagebun.com (drive#883), already on the support page.",
  }),
  Object.freeze({
    id: "refund-rule",
    file: "refunds.html",
    what: "The refund rule for unused balance. The draft default is a refund within 14 days of a top-up.",
  }),
  Object.freeze({
    id: "vat-line",
    file: "refunds.html",
    what: "The VAT or sales-tax line that receipts carry.",
  }),
]);

/** The marker every unfilled fact carries in the page source. */
export const PLACEHOLDER_MARK = /<mark class="to-fill" data-placeholder="([a-z-]+)">/g;
