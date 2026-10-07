// Customer-facing words are ours (drive issue #195).
//
// The main competitor's feature names and signature phrases, read from its
// public site and docs on the date next to each term. This file fails when any
// of them appear in the paths customers see. Internal rival analysis in
// docs/spec.md, docs/scoreboard.md and docs/build-spec.md is exempt, and those
// files are not in the trees this test walks. The rival's own name is barred
// from every tracked file by test/no-rival-terms.test.mjs, so it is not a term
// here. Drive#387 dropped public rival names and prices.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Each term is a feature name or signature phrase from the competitor's
// public pages. The source is the URL it was read from, and the date is when
// this file read it.
const TERMS = Object.freeze([
  Object.freeze({
    term: "Clipboard",
    source: "the competitor's public site",
    date: "2026-10-02",
    pattern: String.raw`\bClipboard\b`,
    flags: "g",
  }),
  Object.freeze({
    term: "zero bytes on disk",
    source: "the competitor's public site",
    date: "2026-10-02",
    pattern: "zero bytes on disk",
    flags: "gi",
  }),
  Object.freeze({
    term: "zero disk space",
    source: "the competitor's public site",
    date: "2026-10-02",
    pattern: "zero disk space",
    flags: "gi",
  }),
  Object.freeze({
    term: "the infinite AI-native filesystem",
    source: "the competitor's public site",
    date: "2026-10-02",
    pattern: "the infinite AI-native filesystem",
    flags: "gi",
  }),
  Object.freeze({
    term: "pin",
    source: "the competitor's public site",
    date: "2026-10-02",
    pattern: String.raw`\b(?:un)?pin(?:ned|ning|s)?\b`,
    flags: "gi",
  }),
]);

// Internal names, and platform names, that a customer page must not show
// (drive issue #428). "Nishfleet" is our own internal name and "launchd" is a
// macOS tool: the pages customers read name the thing in plain words (a login
// item, the command, the drive). These are not rival terms, so they do not
// belong in TERMS above, but the rule is the same one and it is enforced in
// the same place: public/, docs-site/, the get-started shell at the repo root,
// and the module strings src/ renders from. The Go sources under cmd/ are a
// developer surface and keep their identifiers (LaunchdLabel, the module path
// in cmd/drive/update.go).
const INTERNAL_TERMS = Object.freeze([
  Object.freeze({ term: "Nishfleet", pattern: "nishfleet", flags: "gi" }),
  Object.freeze({ term: "launchd", pattern: "launchd", flags: "gi" }),
]);

/** @param {string} path @param {string} text */
function internalHitsIn(path, text) {
  const hits = [];
  for (const term of INTERNAL_TERMS) {
    const re = new RegExp(term.pattern, term.flags);
    for (const match of text.matchAll(re)) {
      hits.push({ path, term: term.term, match: match[0] });
    }
  }
  return hits;
}

/** The customer-facing trees, walked the same way scanTree walks them. */
function scanCustomerPages() {
  const hits = [];
  for (const rel of walkFiles(join(root, "public"))) {
    hits.push(...internalHitsIn(rel, stripMarkupComments(readFileSync(join(root, rel), "utf8"))));
  }
  for (const rel of walkFiles(join(root, "docs-site"))) {
    hits.push(...internalHitsIn(rel, readFileSync(join(root, rel), "utf8")));
  }
  hits.push(
    ...internalHitsIn(
      "get-started.html",
      stripMarkupComments(readFileSync(join(root, "get-started.html"), "utf8")),
    ),
  );
  for (const rel of PRODUCT_JS_TREES.flatMap((tree) => walkFiles(join(root, tree)))) {
    if (!SRC_JS_EXT.has(extname(rel))) {
      continue;
    }
    const strings = quotedStrings(readFileSync(join(root, rel), "utf8")).join("\n");
    hits.push(...internalHitsIn(rel, strings));
  }
  return hits;
}

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
const SRC_JS_EXT = new Set([".js", ".mjs", ".cjs"]);
// The two product-JS trees this gate walks: the shared core both Workers
// import (drive#616) and the site Worker's own src/. Customer-facing copy
// moved into core/ with everything else, so a walk of src/ alone would stop
// covering it.
const PRODUCT_JS_TREES = ["core", "src"];
/**
 * @param {string} path
 * @param {string} text
 */
function hitsIn(path, text) {
  const scanned = text;
  const hits = [];
  for (const term of TERMS) {
    const re = new RegExp(term.pattern, term.flags.includes("g") ? term.flags : `${term.flags}g`);
    for (const match of scanned.matchAll(re)) {
      hits.push({ path, term: term.term, match: match[0] });
    }
  }
  return hits;
}

/**
 * @param {string} source
 * @param {number} i
 */
function isRegexStart(source, i) {
  let k = i - 1;
  while (k >= 0 && /[ \t\r\n]/.test(source[k])) {
    k -= 1;
  }
  if (k < 0) {
    return true;
  }
  const c = source[k];
  if ("=,([:!&|?~;{}+-*%^<>".includes(c)) {
    return true;
  }
  return /\b(?:return|throw|typeof|case|void|delete|in|of|new|await|yield)\s*$/.test(
    source.slice(0, i),
  );
}

/**
 * @param {string} source
 * @param {number} i
 */
function skipRegex(source, i) {
  let j = i + 1;
  let inClass = false;
  while (j < source.length) {
    const c = source[j];
    if (c === "\n") {
      return i + 1;
    }
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "[") {
      inClass = true;
    } else if (c === "]") {
      inClass = false;
    } else if (c === "/" && !inClass) {
      j += 1;
      while (j < source.length && /[a-z]/i.test(source[j])) {
        j += 1;
      }
      return j;
    }
    j += 1;
  }
  return i + 1;
}

/** Quoted strings in JS or Go, skipping comments, so identifiers like `pinned` are not copy.
 * @param {string} source
 * @param {{backtickRaw?: boolean}} [options]
 */
function quotedStrings(source, options = {}) {
  const backtickRaw = options.backtickRaw === true;
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
    if (!backtickRaw && c === "/" && isRegexStart(source, i)) {
      i = skipRegex(source, i);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      const raw = q === "`" && backtickRaw;
      let j = i + 1;
      let s = "";
      while (j < source.length) {
        if (!raw && source[j] === "\\") {
          s += source[j] + (source[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (!raw && q === "`" && source[j] === "$" && source[j + 1] === "{") {
          let depth = 1;
          j += 2;
          while (j < source.length && depth > 0) {
            if (source[j] === "{") {
              depth += 1;
            } else if (source[j] === "}") {
              depth -= 1;
            }
            j += 1;
          }
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

/** @param {string} text */
function stripMarkupComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * @param {string} dir
 * @param {string[]} [files]
 */
function walkFiles(dir, files = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name === ".rendered") {
      continue;
    }
    if (ent.isSymbolicLink()) {
      continue;
    }
    const full = join(dir, ent.name);
    const rel = relative(root, full);
    // Generated docs (public/docs, docs-site/.rendered) are not committed;
    // docs-site/*.md is the source customers read after the build.
    if (rel === "public/docs" || rel.startsWith("public/docs/")) {
      continue;
    }
    if (ent.isDirectory()) {
      walkFiles(full, files);
      continue;
    }
    if (ent.isFile() && TEXT_EXT.has(extname(ent.name))) {
      files.push(rel);
    }
  }
  return files;
}

function scanTree() {
  const hits = [];
  for (const rel of walkFiles(join(root, "public"))) {
    hits.push(...hitsIn(rel, stripMarkupComments(readFileSync(join(root, rel), "utf8"))));
  }
  for (const rel of walkFiles(join(root, "docs-site"))) {
    hits.push(...hitsIn(rel, readFileSync(join(root, rel), "utf8")));
  }
  for (const rel of PRODUCT_JS_TREES.flatMap((tree) => walkFiles(join(root, tree)))) {
    if (!SRC_JS_EXT.has(extname(rel))) {
      continue;
    }
    const strings = quotedStrings(readFileSync(join(root, rel), "utf8")).join("\n");
    hits.push(...hitsIn(rel, strings));
  }
  for (const rel of walkFiles(join(root, "cmd"))) {
    if (!rel.endsWith(".go")) {
      continue;
    }
    const strings = quotedStrings(readFileSync(join(root, rel), "utf8"), {
      backtickRaw: true,
    }).join("\n");
    hits.push(...hitsIn(rel, strings));
  }
  return hits;
}

test("the term list names its source and the date it was read", () => {
  assert.ok(TERMS.length >= 5, "the list holds the names customers must not see");
  for (const term of TERMS) {
    assert.match(
      term.source,
      /^the competitor's public (site|docs)$/,
      `${term.term} must cite the competitor's page it was read from`,
    );
    assert.match(term.date, /^\d{4}-\d{2}-\d{2}$/, `${term.term} must say when it was read`);
    assert.ok(term.pattern.length > 0, `${term.term} must have a pattern`);
  }
});

test("a planted rival term fails the scan", () => {
  const planted = [
    "drive pin ./footage",
    "Drive pins your files",
    "unpin the folder",
    "Zero bytes on disk.",
    "using zero disk space",
    "Clipboard",
    "the infinite AI-native filesystem",
  ].join("\n");
  const hits = hitsIn("planted.txt", planted);
  const found = new Set(hits.map((hit) => hit.term));
  for (const term of TERMS) {
    assert.ok(found.has(term.term), `planting ${term.term} must fail the scan`);
  }
});

test("a quote inside a regex does not hide later copy", () => {
  const strings = quotedStrings(`const re = /["']/; const msg = "zero bytes on disk";`);
  assert.ok(strings.some((s) => s.includes("zero bytes on disk")));
  assert.ok(
    hitsIn("src/x.js", strings.join("\n")).some((hit) => hit.term === "zero bytes on disk"),
  );
});

test("an escaped backtick does not hide later copy", () => {
  const strings = quotedStrings("const a = `foo \\` bar`; const b = `Clipboard`;");
  assert.ok(strings.some((s) => s === "Clipboard"));
  assert.ok(hitsIn("src/x.js", strings.join("\n")).some((hit) => hit.term === "Clipboard"));
});

test("the customer-facing tree has none of the listed terms", () => {
  const hits = scanTree();
  assert.deepEqual(
    hits,
    [],
    hits.map((hit) => `${hit.path}: ${hit.term} (${hit.match})`).join("\n"),
  );
});

test("an internal name planted on a customer page fails the scan", () => {
  for (const term of INTERNAL_TERMS) {
    assert.ok(
      internalHitsIn("page.md", `run ${term.term} to finish`).some((hit) => hit.term === term.term),
      `planting ${term.term} on a customer page must fail`,
    );
  }
});

test("no customer-facing page names us or a macOS tool (drive issue #428)", () => {
  const hits = scanCustomerPages();
  assert.deepEqual(
    hits,
    [],
    hits.map((hit) => `${hit.path}: ${hit.term} (${hit.match})`).join("\n"),
  );
});
