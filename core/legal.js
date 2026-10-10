// The legal and trust pages (drive#523, drive#584): terms, privacy, refunds,
// acceptable use, support, accessibility and status. They are hand-written
// static pages in public/, like every other page on the site, and this file is
// the one list of them, so the footer links, the sitemap, src/seo.js and
// test/legal.test.mjs cannot disagree about which pages exist or where they
// live.
//
// The page prose is the drive#882 drafts, quoted from the issue. Two facts
// are the owner's to decide, not a worker's: the payee's legal name and the
// postal contact address. Each one is a marked placeholder in exactly one
// page:
//
//     <mark class="to-fill" data-placeholder="<id>">[To fill: ...]</mark>
//
// Nish decided the other two on 2026-10-09 (drive#523, drive#882): the refund
// rule (unused balance refundable within 14 days of a top-up, non-refundable
// but never expiring after that) and the VAT line (prices exclude VAT, shown
// at checkout by the payment provider). Both are written on the refunds page
// now, so they are no longer placeholders. The support mailbox is a decided
// fact too, and the drafts put it on each of the four pages, so it is typed on
// each; only the two placeholders above are single-owner facts. Every other
// page links to the page that holds a placeholder (the support page for the
// address), so each of those is typed once.

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
    what: "The postal contact address for Storagebun.",
  }),
]);

/** The marker every unfilled fact carries in the page source. */
export const PLACEHOLDER_MARK = /<mark class="to-fill" data-placeholder="([a-z-]+)">/g;
