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
import { NOT_OPEN, VERSION_HISTORY, VERSION_HISTORY_PROMISES } from "../src/release-state.js";

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
