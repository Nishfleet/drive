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
  Object.freeze({ path: "/accessibility", file: "accessibility.html", label: "Accessibility" }),
  Object.freeze({ path: "/status", file: "status.html", label: "Status" }),
]);

export const SUPPORT_PATH = "/support";

export const REPORT_PATH = "/acceptable-use#report";

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
    what: "The postal contact address for Storagebun.",
  }),
]);

export const PLACEHOLDER_MARK = /<mark class="to-fill" data-placeholder="([a-z-]+)">/g;
