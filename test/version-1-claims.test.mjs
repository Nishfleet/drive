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
//
// drive#776 added two more, one per drift the walkthrough found on the same
// surfaces: a platform the spec left out of v1 offered as an install, and an
// access path in llms.txt that no command mints a key for.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  NOT_OPEN,
  OUT_OF_V1_PLATFORM_DENIALS,
  OUT_OF_V1_PLATFORM_WORDS,
  V1_PLATFORMS,
  VERSION_HISTORY,
  VERSION_HISTORY_PROMISES,
} from "../src/release-state.js";
import { cliSubcommands } from "../src/render-docs.js";

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

// Every docs page that ships, read from the build output `npm test` writes
// first, so a page that renders but ships the wrong words fails here. The
// changelog is left out, the way this file leaves out the spec and the
// scoreboard: it says what past versions did, not what a reader is offered
// today.
const SHIPPED_PAGES = readdirSync(new URL("../public/docs/", import.meta.url))
  .filter((name) => name.endsWith(".md") && !name.startsWith("llms"))
  .map((name) => name.slice(0, -3))
  .filter((page) => page !== "changelog")
  .sort();

/** The sentences of one surface, as a reader sees them: a page hard-wraps a
 * sentence across lines, and the label that makes an out-of-v1 sentence honest
 * sits in the same one, so the text is folded before it is cut.
 * @param {string} text
 * @returns {ReadonlyArray<string>} */
const sentencesOf = (text) => oneLine(text).split(/(?<=[.!?])\s+/);

/** The blocks of one surface, each folded to one line. A bullet is one
 * statement and a paragraph is another, so the label that keeps an out-of-v1
 * mention honest must sit inside the block a reader takes as one thing.
 * @param {string} text
 * @returns {ReadonlyArray<string>} */
const blocksOf = (text) => {
  /** @type {string[]} */
  const blocks = [];
  /** @type {string[]} */
  let block = [];
  const flush = () => {
    if (block.length > 0) blocks.push(oneLine(block.join(" ")));
    block = [];
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || /^[*-]\s/.test(trimmed)) {
      flush();
    }
    if (trimmed !== "") block.push(trimmed);
  }
  flush();
  return blocks;
};

/** The `drive <name>` mentions in a text, inside code spans only. Prose cannot
 * be read this way: "the drive folder" and "the drive goes read-only" are
 * sentences about the product, not commands, and a gate that matched them
 * would fail on ordinary English.
 * @param {string} text
 * @returns {ReadonlyArray<string>} */
const namedCommands = (text) => [
  ...new Set([...text.matchAll(/`drive ([a-z][a-z0-9-]*)/g)].map((m) => m[1])),
];

// A sentence that promises a key promises an access path, which in version 1
// comes from a command. drive#776: llms.txt promised "the S3 API, each with its
// own scoped key" while no command mints a key for that path.
const KEY_PROMISE = /\b(?:scoped key|API key|own key|key of its own)\b/i;
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

test("the spec's Platforms row is still the list this file holds", () => {
  // src/release-state.js holds the platforms as words, because a test cannot
  // read a Go map and a docs page cannot import one. This ties those words to
  // the row they came from, so the day the spec ships Windows the row stops
  // matching and this gate says which file to edit.
  const spec = read("docs/build-spec.md");
  const row = spec.match(/^\|\s*Platforms\s*\|([^|\n]+)\|/m);
  assert.ok(row, "docs/build-spec.md must carry a Platforms row");
  const cells = row[1];
  for (const platform of V1_PLATFORMS) {
    assert.match(
      cells,
      new RegExp(platform, "i"),
      `the spec's Platforms row must name ${platform}`,
    );
  }
  assert.match(cells, /No Windows in v1/i, "the spec's Platforms row must leave Windows out of v1");
});

test("no docs surface offers a platform version 1 does not ship", () => {
  // drive#776: the quickstart offered a Windows install in the same breath as
  // the two platforms that ship, and the limits page called the MSI an install
  // a reader could take. The Windows mount is real code behind an unsigned
  // installer, so the fix is not to delete the platform from the docs: it is
  // that every block naming it must say, in that block, that it is out of
  // version 1, and that the one sentence naming the MSI must say so too.
  const surfaces = [...SHIPPED_PAGES.map((page) => `public/docs/${page}.md`), "public/llms.txt"];
  for (const surface of surfaces) {
    for (const block of blocksOf(read(surface))) {
      const named = OUT_OF_V1_PLATFORM_WORDS.filter((word) => word.test(block)).map((word) =>
        String(word),
      );
      if (named.length === 0) continue;
      const denied = OUT_OF_V1_PLATFORM_DENIALS.some((denial) => denial.test(block));
      assert.ok(
        denied,
        `${surface} says "${block.trim()}", which names ${named.join(" and ")} ` +
          "without saying in the same block that it is outside version 1",
      );
      // The sentence that names the installer carries the label itself: a
      // reader skimming the bullets reads that one sentence, not the block.
      for (const sentence of sentencesOf(block)) {
        if (!/\bMSI\b/.test(sentence)) continue;
        assert.ok(
          OUT_OF_V1_PLATFORM_DENIALS.some((denial) => denial.test(sentence)),
          `${surface} says "${sentence.trim()}", which names the MSI without saying in the ` +
            "same sentence that the MSI is unsigned and outside version 1",
        );
      }
    }
  }
  // And the page a reader starts from names the platforms that ship, so a page
  // that dropped the mention entirely fails here too.
  assert.match(
    shipped("quickstart"),
    /macOS or Linux|macOS and Linux/i,
    "the quickstart must name the platforms version 1 ships",
  );
});

test("llms.txt names only commands the CLI has, and ties every key promise to one", () => {
  // drive#776: llms.txt promised "the S3 API, each with its own scoped key",
  // and no command mints a key for that path: cmd/drive/main.go has no `s3`
  // subcommand, and the spec's own step for it (drive#525) is not built. The
  // sentence now names `drive init`, the command that does mint a key per
  // tool. This gate holds the two halves of that: every command the file
  // names must exist, and a sentence that promises a key must name the
  // command.
  const llms = oneLine(read("public/llms.txt"));
  const commands = cliSubcommands();
  const named = namedCommands(llms);
  assert.ok(named.length >= 3, `public/llms.txt must name the commands it uses (found ${named})`);
  for (const name of ["init", "cache", "status"]) {
    assert.ok(
      named.includes(name),
      `public/llms.txt must name \`drive ${name}\`, the command its own text describes`,
    );
  }
  for (const name of named) {
    assert.ok(
      commands.has(name),
      `public/llms.txt names \`drive ${name}\`, which is not a subcommand in cmd/drive/main.go`,
    );
  }
  const promising = sentencesOf(llms).filter((sentence) => KEY_PROMISE.test(sentence));
  assert.ok(promising.length > 0, "public/llms.txt must state what an agent's key is for");
  for (const sentence of promising) {
    const minted = namedCommands(sentence);
    assert.ok(
      minted.length > 0 && minted.every((name) => commands.has(name)),
      `public/llms.txt promises a key in "${sentence.trim()}" without naming a command in ` +
        "cmd/drive/main.go that mints it",
    );
  }
  // The path the drift was found on must not come back as an unqualified
  // promise: a raw s3 key is a key of its own kind in core/keyprovider.js and
  // no shipped command hands one to a person.
  assert.doesNotMatch(
    llms,
    /\bS3 API\b/i,
    "public/llms.txt must not offer the S3 API as a path a person can take, because no command mints a key for it",
  );
});
