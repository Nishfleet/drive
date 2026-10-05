// The legal and trust pages (drive#523): terms, privacy, refunds, acceptable
// use and support. This file pins what the issue's finish line asks for:
// the pages ship and are in the sitemap, every footer and the sign-in page
// link them, the four owner facts stay marked placeholders in one place
// each, the pages state the real price and the real storage provider, and
// security.txt points at the support page.
//
// drive#584 adds the accessibility and status pages to the same list, plus the
// three operator runbooks, the site's own 5xx page, and the sub-processor list
// on the security page. Those are pinned at the end of this file.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { CLOSE_GRACE_DAYS } from "../src/account-close.js";
import { BILLING_CONFIG } from "../src/billing.js";
import { DEFAULT_CAP_USD } from "../src/cap-default.js";
import {
  LEGAL_PAGES,
  LEGAL_PLACEHOLDERS,
  PLACEHOLDER_MARK,
  REPORT_PATH,
  SUPPORT_PATH,
} from "../src/legal.js";
import { PREPAID, PRICE } from "../src/pricing.js";
import { absoluteUrl, PAGES } from "../src/seo.js";

const publicDir = new URL("../public/", import.meta.url);
/** @param {string} name */
const readPublic = (name) => readFileSync(new URL(name, publicDir), "utf8");
/** @param {string} path */
const readRepo = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Every shipped HTML page: the public/ assets and the one Vite entry at the
// repo root.
const shippedPages = [
  ...readdirSync(publicDir)
    .filter((name) => name.endsWith(".html"))
    .map((name) => ({ name, html: readPublic(name) })),
  { name: "get-started.html", html: readRepo("get-started.html") },
];

/** @param {string} html */
const visibleText = (html) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");

/** @param {string} name */
const legalText = (name) => visibleText(readPublic(name));

test("every legal page ships, is indexable, and is in the sitemap at its clean URL", () => {
  const sitemap = readPublic("sitemap.xml");
  for (const page of LEGAL_PAGES) {
    assert.ok(existsSync(new URL(page.file, publicDir)), `public/${page.file} must exist`);
    const registered = PAGES.find((entry) => entry.path === page.path);
    assert.ok(registered, `${page.path} must be registered in PAGES (src/seo.js)`);
    assert.equal(registered.file, page.file, `${page.path} is served from ${page.file}`);
    assert.equal(registered.indexable, true, `${page.path} must be indexable`);
    assert.ok(
      sitemap.includes(`<loc>${absoluteUrl(page.path)}</loc>`),
      `the sitemap must list ${page.path}`,
    );
  }
  for (const path of ["/terms", "/privacy", "/refunds", "/acceptable-use", "/support"]) {
    assert.ok(
      LEGAL_PAGES.some((page) => page.path === path),
      `${path} is one of the pages drive#523 names`,
    );
  }
});

test("Lighthouse checks every legal page against the same budgets", () => {
  const urls = JSON.parse(readRepo("lighthouserc.json")).ci.collect.url;
  for (const page of LEGAL_PAGES) {
    assert.ok(
      urls.includes(`http://localhost/${page.file}`),
      `lighthouserc.json runs ${page.file}`,
    );
  }
});

test("every page footer links every legal page", () => {
  let footers = 0;
  for (const { name, html } of shippedPages) {
    const footer = html.match(/<footer[\s\S]*?<\/footer>/);
    if (!footer) continue;
    footers += 1;
    for (const page of LEGAL_PAGES) {
      assert.ok(
        footer[0].includes(`href="${page.path}"`),
        `${name}'s footer must link ${page.path}`,
      );
    }
  }
  assert.ok(footers >= 10, `expected the footers of at least 10 pages, found ${footers}`);
});

test("the sign-in form links the terms and the privacy policy", () => {
  const form = readPublic("signin.html").match(/<form id="signin-form"[\s\S]*?<\/form>/);
  assert.ok(form, "signin.html carries the sign-in form");
  assert.match(form[0], /href="\/terms"/);
  assert.match(form[0], /href="\/privacy"/);
});

test("the four owner facts are marked placeholders, each in one place only", () => {
  assert.deepEqual(
    LEGAL_PLACEHOLDERS.map((fact) => fact.id),
    ["payee-name", "contact-address", "refund-rule", "vat-line"],
  );
  /** @type {Map<string, string[]>} */
  const seen = new Map();
  for (const { name, html } of shippedPages) {
    for (const match of html.matchAll(PLACEHOLDER_MARK)) {
      seen.set(match[1], [...(seen.get(match[1]) ?? []), name]);
    }
    // Every "[To fill" text sits inside a marker, so none can pass unmarked.
    const loose = html.replace(/<mark class="to-fill"[^>]*>[\s\S]*?<\/mark>/g, "");
    assert.doesNotMatch(loose, /\[To fill/i, `${name} has a placeholder outside a marker`);
  }
  for (const id of seen.keys()) {
    assert.ok(
      LEGAL_PLACEHOLDERS.some((fact) => fact.id === id),
      `${id} is not one of the four owner facts in src/legal.js`,
    );
  }
  // A fact may be filled (gone), never typed twice or moved off its page.
  for (const fact of LEGAL_PLACEHOLDERS) {
    const where = seen.get(fact.id) ?? [];
    assert.ok(where.length <= 1, `${fact.id} appears ${where.length} times: ${where.join(", ")}`);
    if (where.length === 1) {
      assert.equal(where[0], fact.file, `${fact.id} belongs on ${fact.file}`);
    }
  }
  // The refund placeholder carries the draft default the owner can accept.
  assert.match(legalText("refunds.html"), /14 days of a top-up/);
});

test("no legal page carries an email address", () => {
  // The contact fact is the owner's to fill. Until then no page may carry an
  // address, so nobody's personal inbox ends up on the site by accident.
  for (const page of LEGAL_PAGES) {
    assert.doesNotMatch(readPublic(page.file), /[\w.+-]+@[\w-]+\.[\w.-]+/, page.file);
  }
});

test("the terms and the refunds page state the real price, from the price source", () => {
  const terms = legalText("terms.html");
  const refunds = legalText("refunds.html");
  for (const text of [terms, refunds]) {
    assert.ok(text.includes(`$${PREPAID.minTopUpUsd} or more`), "the smallest top-up");
    assert.ok(text.includes(`${PRICE.rateCents} cents per GB`), "the rate");
    assert.ok(text.includes(`more than $${PRICE.maxUsdPerTb} per TB`), "the maximum");
    assert.ok(
      text.includes(
        `free up to ${BILLING_CONFIG.freeDownloadMultiplier} times what you store, then ${BILLING_CONFIG.downloadRateUsdPerGb * 100} cent per GB`,
      ),
      "the download allowance",
    );
    assert.match(text, /balance never expires/);
    for (const stale of [/founding/i, /membership/i, /free trial/i, /\$5\b/]) {
      assert.doesNotMatch(text, stale);
    }
  }
  assert.ok(refunds.includes(`up to $${PREPAID.maxTopUpUsd} at a time`));
  assert.ok(refunds.includes(`falls to $${PREPAID.lowBalanceUsd}`));
  assert.ok(terms.includes(`It starts at $${DEFAULT_CAP_USD}.`), "the default cap");
  assert.ok(terms.includes(`Your files stay for ${CLOSE_GRACE_DAYS} days`), "the close window");
});

test("the privacy policy names every company that handles data, with the storage region", () => {
  const privacy = legalText("privacy.html");
  for (const name of ["Cloudflare", "iDrive e2", "Dodo Payments"]) {
    assert.ok(privacy.includes(name), `the privacy policy must name ${name}`);
  }
  assert.match(privacy, /Paris, France \(region eu-west-3\)/);
  assert.ok(privacy.includes(`${CLOSE_GRACE_DAYS} days after you close the account`));
});

test("the security page and the changelog name the real storage provider", () => {
  const security = readRepo("docs-site/security.md");
  assert.match(security, /iDrive e2, in its Paris region \(eu-west-3\)/);
  assert.doesNotMatch(security, /object storage we run|We run the storage/);
  const changelog = readRepo("docs-site/changelog.md");
  assert.match(changelog, /moves to Backblaze B2\. Reversed the\s+next day/);
});

test("the report and support paths are real pages, and security.txt points at support", () => {
  const [reportPage, anchor] = REPORT_PATH.split("#");
  const acceptable = LEGAL_PAGES.find((page) => page.path === reportPage);
  assert.ok(acceptable, `${reportPage} is a legal page`);
  assert.match(readPublic(acceptable.file), new RegExp(`id="${anchor}"`));
  assert.ok(LEGAL_PAGES.some((page) => page.path === SUPPORT_PATH));
  const securityTxt = readPublic(".well-known/security.txt");
  assert.match(securityTxt, new RegExp(`^Contact: ${absoluteUrl(SUPPORT_PATH)}$`, "m"));
  const expires = securityTxt.match(/^Expires: (\S+)$/m);
  assert.ok(expires, "security.txt must carry Expires (RFC 9116)");
  assert.ok(Date.parse(expires[1]) > Date.now(), "security.txt has expired: move Expires on");
});

// drive#584: the launch checklist's own items.

test("security.txt carries every RFC 9116 field, with an expiry under a year", () => {
  const securityTxt = readPublic(".well-known/security.txt");
  for (const field of ["Contact", "Expires", "Preferred-Languages", "Canonical", "Policy"]) {
    assert.match(
      securityTxt,
      new RegExp(`^${field}: \\S`, "m"),
      `security.txt must carry ${field}`,
    );
  }
  const expiresLine = securityTxt.match(/^Expires: (\S+)$/m);
  assert.ok(expiresLine, "security.txt must carry Expires as an RFC 3339 timestamp");
  const expires = Date.parse(expiresLine[1]);
  assert.ok(Number.isFinite(expires), "Expires must be an RFC 3339 timestamp");
  assert.ok(expires > Date.now(), "security.txt has expired: move Expires on");
  // RFC 9116 recommends less than a year, so a reader re-reads the file instead
  // of trusting a stale contact forever. 366 days leaves the leap day alone.
  const underAYear = 366 * 24 * 60 * 60 * 1000;
  assert.ok(
    expires - Date.now() <= underAYear,
    "Expires must be under a year out, not a date nobody will revisit",
  );
});

test("the security page names every sub-processor the privacy policy names", () => {
  const security = readRepo("docs-site/security.md");
  for (const name of ["Cloudflare", "iDrive e2", "Dodo Payments"]) {
    assert.ok(security.includes(name), `the security page must name ${name} (drive#584)`);
  }
  // The privacy policy stays the full record: the security page points at it.
  assert.match(security, /privacy policy/);
});

test("the launch checklist's runbooks ship with words in them", () => {
  for (const name of ["incident", "secrets-rotation", "restore"]) {
    const path = `docs/runbooks/${name}.md`;
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} must ship`);
    const body = readRepo(path);
    assert.match(body, /^# /m, `${path} must lead with a heading`);
    assert.ok(body.trim().length > 200, `${path} must carry the procedure, not a stub`);
  }
});

test("the site's own 5xx page ships as a noindex asset", () => {
  const html = readPublic("500.html");
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /That did not work/);
  const sitemap = readPublic("sitemap.xml");
  assert.equal(sitemap.includes("/500.html"), false, "the 5xx page is not a destination");
});
