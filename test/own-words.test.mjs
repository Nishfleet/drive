// Customer-facing words are ours (drive issue #195).
//
// Space's product and feature names, read from their public site and docs on
// the date next to each term. This file fails when any of them appear in the
// paths customers see. Internal rival analysis in docs/spec.md,
// docs/scoreboard.md and docs/build-spec.md is exempt, and those files are
// not in the trees this test walks. Plain price comparisons that name the
// rival (for example "(Space $27)") stay until the legal-wording review;
// stripAllowedComparisons drops those before the scan.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Each term is a product name, feature name, or signature phrase from Space's
// public pages. The source is the URL it was read from, and the date is when
// this file read it.
const TERMS = Object.freeze([
  Object.freeze({
    term: "SpaceFS",
    source: "https://spacefs.com/",
    date: "2026-10-02",
    pattern: "SpaceFS",
    flags: "gi",
  }),
  Object.freeze({
    term: "Space AI",
    source: "https://spacefs.com/",
    date: "2026-10-02",
    pattern: "Space AI",
    flags: "g",
  }),
  Object.freeze({
    term: "Clipboard",
    source: "https://spacefs.com/",
    date: "2026-10-02",
    pattern: String.raw`\bClipboard\b`,
    flags: "g",
  }),
  Object.freeze({
    term: "zero bytes on disk",
    source: "https://spacefs.com/",
    date: "2026-10-02",
    pattern: "zero bytes on disk",
    flags: "gi",
  }),
  Object.freeze({
    term: "zero disk space",
    source: "https://spacefs.com/",
    date: "2026-10-02",
    pattern: "zero disk space",
    flags: "gi",
  }),
  Object.freeze({
    term: "the infinite AI-native filesystem",
    source: "https://spacefs.com/",
    date: "2026-10-02",
    pattern: "the infinite AI-native filesystem",
    flags: "gi",
  }),
  Object.freeze({
    term: "pin",
    source: "https://spacefs.com/",
    date: "2026-10-02",
    pattern: String.raw`\b(?:un)?pin(?:ned|ning)?\b`,
    flags: "gi",
  }),
  Object.freeze({
    term: "Space",
    source: "https://spacefs.com/",
    date: "2026-10-02",
    pattern: String.raw`\bSpace\b`,
    flags: "g",
  }),
]);

const TEXT_EXT = new Set([
  ".css",
  ".html",
  ".htm",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".txt",
  ".xml",
]);

/** Drop the price-comparison forms issue #195 leaves in place. */
function stripAllowedComparisons(text) {
  return text
    .replace(/\(Space \$[\d.]+\)/g, "")
    .replace(/against Space \$[\d.]+/g, "")
    .replace(/\bname:\s*["']Space["']/g, "");
}

function hitsIn(path, text, options = {}) {
  let scanned = stripAllowedComparisons(text);
  // The rival's name in src/pricing.js and src/docs.js is the one word used to
  // format the allowed "(Space $27)" comparisons. After quoted-string extract
  // it is a whole string "Space", not customer copy.
  if (options.allowRivalName) {
    scanned = scanned.replace(/(^|\n)Space(\n|$)/g, "$1$2");
  }
  const hits = [];
  for (const term of TERMS) {
    const re = new RegExp(term.pattern, term.flags.includes("g") ? term.flags : `${term.flags}g`);
    for (const match of scanned.matchAll(re)) {
      hits.push({ path, term: term.term, match: match[0] });
    }
  }
  return hits;
}

/** Quoted strings in JS or Go, skipping comments, so identifiers like `pinned` are not copy. */
function quotedStrings(source) {
  const out = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      let s = "";
      while (j < source.length) {
        if (q !== "`" && source[j] === "\\") {
          s += source[j] + (source[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (source[j] === q) {
          break;
        }
        s += source[j];
        j += 1;
      }
      out.push(s);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

function walkFiles(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === ".rendered") {
      continue;
    }
    const full = join(dir, name);
    const rel = relative(root, full);
    // Generated docs (public/docs, docs-site/.rendered) are not committed;
    // docs-site/*.md is the source customers read after the build.
    if (rel === "public/docs" || rel.startsWith(`public/docs/`)) {
      continue;
    }
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, files);
      continue;
    }
    if (TEXT_EXT.has(extname(name))) {
      files.push(rel);
    }
  }
  return files;
}

function scanTree() {
  const hits = [];
  for (const rel of walkFiles(join(root, "public"))) {
    hits.push(...hitsIn(rel, readFileSync(join(root, rel), "utf8")));
  }
  for (const rel of walkFiles(join(root, "docs-site"))) {
    hits.push(...hitsIn(rel, readFileSync(join(root, rel), "utf8")));
  }
  for (const rel of walkFiles(join(root, "src"))) {
    if (!rel.endsWith(".js")) {
      continue;
    }
    const strings = quotedStrings(readFileSync(join(root, rel), "utf8")).join("\n");
    hits.push(...hitsIn(rel, strings, { allowRivalName: true }));
  }
  for (const rel of walkFiles(join(root, "cmd"))) {
    if (!rel.endsWith(".go")) {
      continue;
    }
    const strings = quotedStrings(readFileSync(join(root, rel), "utf8")).join("\n");
    hits.push(...hitsIn(rel, strings));
  }
  return hits;
}

test("the term list names a source URL and the date it was read", () => {
  assert.ok(TERMS.length >= 5, "the list holds the names customers must not see");
  for (const term of TERMS) {
    assert.match(term.source, /^https:\/\//, `${term.term} must cite the page it was read from`);
    assert.match(term.date, /^\d{4}-\d{2}-\d{2}$/, `${term.term} must say when it was read`);
    assert.ok(term.pattern.length > 0, `${term.term} must have a pattern`);
  }
});

test("a planted rival term fails the scan", () => {
  const planted = [
    "drive pin ./footage",
    "unpin the folder",
    "Zero bytes on disk.",
    "using zero disk space",
    "Space AI",
    "Clipboard",
    "SpaceFS",
    "the infinite AI-native filesystem",
    "Ask Space to open it",
  ].join("\n");
  const hits = hitsIn("planted.txt", planted);
  const found = new Set(hits.map((hit) => hit.term));
  for (const term of TERMS) {
    assert.ok(found.has(term.term), `planting ${term.term} must fail the scan`);
  }
});

test("a price comparison that names the rival is left alone", () => {
  assert.deepEqual(hitsIn("page.html", '<span class="compare">(Space $27)</span>'), []);
  assert.deepEqual(hitsIn("llms.txt", "2 TB = $15 ($16 of storage, against Space $27)"), []);
  assert.deepEqual(
    hitsIn("src/pricing.js", 'rival: Object.freeze({ name: "Space", monthlyUsd: 15 })'),
    [],
  );
});

test("the customer-facing tree has none of the listed terms", () => {
  const hits = scanTree();
  assert.deepEqual(
    hits,
    [],
    hits.map((hit) => `${hit.path}: ${hit.term} (${hit.match})`).join("\n"),
  );
});
