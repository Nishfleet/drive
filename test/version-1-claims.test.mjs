// The docs, the FAQ, llms.txt, the README and the home page state the same
// two facts (drive#418). The walkthrough of 2026-10-04 found the README
// promising "Every save keeps a version" while every docs page said version
// history is not in version 1, and the pricing page selling a waitlist beside
// a sign-in that lets anyone in.
//
// Two tests, one per way a surface can drift:
//
//   1. no surface may promise a feature src/release-state.js rules out —
//      this is the bullet the issue names, and it is what caught the README;
//   2. every surface the issue names must state the facts it is about, read
//      from the BUILT docs pages, so a page that renders but ships the wrong
//      words fails here rather than in a browser.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { monthlyReceiptTemplate } from "../src/emails.js";
import {
  NOT_OPEN,
  PLATFORMS,
  VERSION_HISTORY,
  VERSION_HISTORY_PROMISES,
} from "../src/release-state.js";

/**
 * @param {string} path
 * @returns {string}
 */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * @param {string} text
 * @returns {string}
 */
const oneLine = (text) => text.replace(/\s+/g, " ");

/**
 * @param {string} page
 * @returns {string}
 */
const shipped = (page) => {
  try {
    return read(`public/docs/${page}.md`);
  } catch {
    return read(`public/docs/${page}.html`);
  }
};

// Every surface a customer reads, plus the repository README. The spec, the
// scoreboard and the changelog are excluded on purpose: they say what version
// 1 would carry and what past versions did, not what a customer is promised
// today.
const CUSTOMER_SURFACES = Object.freeze([
  "README.md",
  "public/llms.txt",
  "public/index.html",
  "public/signin.html",
  "get-started.html",
]);

const DOC_PAGES = Object.freeze([
  "faq",
  "how-it-works",
  "index",
  "limits",
  "pricing",
  "quickstart",
]);

// The pages that state which fact. Every docs page named here says at least
// one of the two, so a reader who lands anywhere is told something true about
// the product's state; which one depends on the page.
const PAGE_FACTS = Object.freeze({
  // Both. The page a buyer reads before paying.
  faq: [VERSION_HISTORY, NOT_OPEN],
  // Both: what the drive does, and that you cannot have it yet.
  "how-it-works": [VERSION_HISTORY, NOT_OPEN],
  // The front page of the docs: a reader arrives here first, so it says the
  // drive is not open. What version 1 lacks belongs on Limits, linked here.
  index: [NOT_OPEN],
  // Both. This is the page the two facts come from.
  limits: [VERSION_HISTORY, NOT_OPEN],
  // Version history, next to the price, and that you cannot buy it yet.
  pricing: [VERSION_HISTORY, NOT_OPEN],
  // The first command someone runs, so it opens with the not-open fact.
  quickstart: [NOT_OPEN],
});

test("no surface promises a feature the docs say is not in version 1", () => {
  const surfaces = [...CUSTOMER_SURFACES, ...DOC_PAGES.map((page) => `public/docs/${page}.md`)];
  for (const surface of surfaces) {
    let text;
    try {
      text = read(surface);
    } catch {
      // The root docs page ships as HTML, not Markdown.
      text = shipped("index");
    }
    for (const promise of VERSION_HISTORY_PROMISES) {
      assert.ok(
        !promise.test(text),
        `${surface} claims a feature src/release-state.js rules out (${promise}); ` +
          "the docs, the README and the pages must state the same fact",
      );
    }
  }
});

test("every surface named in the issue states the facts it is about", () => {
  // The docs pages, read from what would ship.
  for (const [page, facts] of Object.entries(PAGE_FACTS)) {
    const text = shipped(page);
    for (const fact of facts) {
      assert.ok(text.includes(fact), `the built ${page} page must state "${fact}"`);
    }
    assert.doesNotMatch(
      text,
      /\{\{(?:VERSION_HISTORY|NOT_OPEN)\}\}/,
      `the built ${page} page still carries an unresolved marker`,
    );
  }
  // The surfaces outside the docs build carry the same sentences verbatim, so
  // a reader who lands on any one of them is told the same thing.
  for (const surface of ["README.md", "public/llms.txt", "public/index.html"]) {
    const text = oneLine(read(surface));
    assert.ok(text.includes(VERSION_HISTORY), `${surface} must state "${VERSION_HISTORY}"`);
    assert.ok(text.includes(NOT_OPEN), `${surface} must state "${NOT_OPEN}"`);
  }
  // The sign-in screen states it in its own words, because a static page
  // cannot import the module; the exact sentence is bound by
  // test/signin.test.mjs through SIGNIN_COPY, so only the meaning is checked
  // here. Without it the screen reads as an open door beside a page that says
  // the drive is not open, which is the drift the issue found.
  const signin = read("public/signin.html");
  assert.ok(signin.includes(NOT_OPEN), `the sign-in screen must state "${NOT_OPEN}"`);
  assert.match(signin, /invited account/i, "the sign-in screen must name who may sign in");
  // The get-started page is the walkthrough a new person reads first; it must
  // say the drive is not open rather than hand them a command that assumes an
  // account they cannot have yet.
  assert.match(
    read("get-started.html"),
    /not open yet/i,
    "the get-started page must say the drive is not open yet",
  );
});

// ---------------------------------------------------------------------------
// drive#545: three more facts the surfaces kept getting wrong, each pinned
// to the code that owns it.
// ---------------------------------------------------------------------------

test("the platform list is the packaging code's, in the same words everywhere", () => {
  // drive#545: the quickstart said "macOS, Linux or Windows" while the home
  // page said Windows is not ready, and INSTALL_LINES (test/packaging.test.mjs
  // holds it to the packaging files) has no Windows line. The list lives in
  // src/release-state.js and every surface that states it states that string.
  assert.ok(
    shipped("quickstart").includes(PLATFORMS),
    "the built quickstart states the platform list",
  );
  assert.ok(
    !read("docs-site/quickstart.md").match(/macOS, Linux or Windows/i),
    "the quickstart must not list Windows as an install target",
  );
  const index = read("public/index.html");
  assert.ok(index.includes(PLATFORMS), "the home page states the platform list verbatim");
  // Every sentence on the home page that names Windows denies it, so the
  // page cannot drift back to a claim the packaging code cannot back.
  for (const match of index.matchAll(/Windows/g)) {
    const around = index.slice(Math.max(0, match.index - 80), match.index + 120);
    assert.match(
      around,
      /not ready|not published|Not yet|planned/i,
      `a home-page Windows mention reads as available: ...${around}...`,
    );
  }
});

test("the step count the surfaces quote is the quickstart's own", () => {
  // drive#545: the docs home, how-it-works, the README and llms.txt said
  // "five steps"; the quickstart has six. The count is read from the page's
  // numbered headings, so a step added later fails here until every surface
  // quotes the new count.
  const steps = (read("docs-site/quickstart.md").match(/^## \d+\./gm) ?? []).length;
  assert.ok(steps >= 2, `the quickstart has numbered steps, found ${steps}`);
  const words = /** @type {Record<number, string>} */ ({
    2: "two",
    3: "three",
    4: "four",
    5: "five",
    6: "six",
    7: "seven",
    8: "eight",
  });
  const word = words[steps];
  assert.ok(word, `no word for ${steps} steps; extend the map and the surfaces together`);
  for (const surface of [
    "docs-site/index.md",
    "docs-site/how-it-works.md",
    "README.md",
    "public/llms.txt",
  ]) {
    assert.match(
      read(surface),
      new RegExp(`\\b${word} steps\\b`),
      `${surface} must say the quickstart is ${word} steps`,
    );
  }
});

test("the monthly receipt states its facts in the customer's words, with its number", () => {
  // drive#545: the receipt told a customer "This is min(metered, ceiling)"
  // and carried no number. The wording is pinned here the way the other
  // customer-facing sentences are; the number is required, and the refusal
  // to send without one is pinned in test/emails.test.mjs through the route.
  const { subject, text, html } = monthlyReceiptTemplate({
    billUsd: 12,
    meteredUsd: 16,
    ceilingUsd: 12,
    capped: true,
    receiptNumber: "R-42",
  });
  for (const part of [subject, text, html]) {
    assert.doesNotMatch(part, /min\(metered|ceiling\)/, "no code jargon on a customer receipt");
  }
  assert.match(text, /Receipt R-42\./);
  assert.match(
    text,
    /Your use this month meters to \$16\.00, and the most we charge for it is \$12\.00\./,
  );
  assert.match(subject, /Your Drive receipt R-42/);
});

test("the download charge is marked planned, not sold as live", () => {
  // drive#545 (the #517 extension): the pricing page, the FAQ and llms.txt
  // advertised a 1¢ per GB download charge the meter cannot levy today --
  // the download worker cannot run (#517), so nothing records download
  // bytes. Until it can, the charge is stated as the plan, marked planned,
  // on every surface that names it.
  const surfaces = /** @type {const} */ ([
    ["docs-site/pricing.md", /not metered yet.*?planned/s],
    ["public/llms.txt", /not metered yet, so they are free today/],
    ["src/docs.js", /Downloads are not metered yet, so nothing is charged for them today/],
  ]);
  for (const [surface, pattern] of surfaces) {
    assert.match(read(surface), pattern, `${surface} must mark the download charge planned`);
    assert.doesNotMatch(
      read(surface),
      /then 1¢ per GB\.(?!.)/,
      `${surface} sells the download charge as live`,
    );
  }
  // The negative above cannot bite on an authored page: the price reaches a
  // reader through the {{DOWNLOAD_RATE}} marker, so the literal "then 1¢ per
  // GB." is absent from the source whether the sentence ships or not. The
  // built page is where the marker is resolved, so the sell-it-as-live guard
  // is asserted there, where a regression would really be customer text.
  const builtPricing = read("public/docs/pricing.html");
  assert.doesNotMatch(
    builtPricing,
    /then 1¢ per GB\.(?!.)/,
    "the built pricing page sells the download charge as live",
  );
  assert.match(
    builtPricing,
    /not metered yet[^<]{0,140}\(planned\)/s,
    "the built pricing page must keep the planned marker next to the download price",
  );
});

test("customer docs do not point at repository files or issue numbers", () => {
  // drive#545: limits.md named (#154), the FAQ named docs/scoreboard.md, the
  // security page named workers/api paths, the pricing page named
  // monthBillCents. Those are repo internals, not customer copy.
  const leak =
    /(?:workers\/api\/|cmd\/drive\/[a-z]|docs\/scoreboard\.md|monthBillCents|\(issue #\d+\)|\(#\d+\))/;
  for (const surface of [
    "docs-site/faq.md",
    "docs-site/limits.md",
    "docs-site/security.md",
    "docs-site/pricing.md",
    "docs-site/how-it-works.md",
    "docs-site/quickstart.md",
    "docs-site/index.md",
    "public/llms.txt",
  ]) {
    assert.doesNotMatch(read(surface), leak, `${surface} points at a repository file or issue`);
  }
});
