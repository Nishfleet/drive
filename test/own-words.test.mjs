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
import { readdirSync, readFileSync } from "node:fs";
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
    pattern: String.raw`\b(?:un)?pin(?:ned|ning|s)?\b`,
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
const SRC_JS_EXT = new Set([".js", ".mjs", ".cjs"]);
// The rival's name lives in these two modules as the data that formats the
// allowed "(Space $27)" comparisons. Nowhere else in src/ may a "Space"
// string pass.
const RIVAL_NAME_FILES = new Set(["src/docs.js", "src/pricing.js"]);

/** Drop the price-comparison forms issue #195 leaves in place. */
function stripAllowedComparisons(text) {
  return text
    .replace(/\(Space \$[\d.]+\)/g, "")
    .replace(/against Space \$[\d.]+/g, "")
    .replace(/\bname:\s*["']Space["']/g, "");
}

function dropExactRivalName(text) {
  return text
    .split("\n")
    .filter((line) => line !== "Space")
    .join("\n");
}

function hitsIn(path, text, options = {}) {
  let scanned = stripAllowedComparisons(text);
  if (options.allowRivalName) {
    scanned = dropExactRivalName(scanned);
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

/** Quoted strings in JS or Go, skipping comments, so identifiers like `pinned` are not copy. */
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

function stripMarkupComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

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
  for (const rel of walkFiles(join(root, "src"))) {
    if (!SRC_JS_EXT.has(extname(rel))) {
      continue;
    }
    const strings = quotedStrings(readFileSync(join(root, rel), "utf8")).join("\n");
    hits.push(...hitsIn(rel, strings, { allowRivalName: RIVAL_NAME_FILES.has(rel) }));
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

test("the term list names a source URL and the date it was read", () => {
  assert.ok(TERMS.length >= 5, "the list holds the names customers must not see");
  for (const term of TERMS) {
    assert.match(term.source, /^https:\/\//, `${term.term} must cite the page it was read from`);
    assert.match(term.date, /^\d{4}-\d{2}-\d{2}$/, `${term.term} must say when it was read`);
    assert.ok(term.pattern.length > 0, `${term.term} must have a pattern`);
  }
  const spacefs = TERMS.find((term) => term.term === "SpaceFS");
  assert.ok(spacefs, "SpaceFS stays in the list");
  assert.match(spacefs.source, /^https:\/\//);
});

test("a planted rival term fails the scan", () => {
  const planted = [
    "drive pin ./footage",
    "Drive pins your files",
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

test("the rival name constant is allowed only in the two comparison modules", () => {
  const pricing = quotedStrings(readFileSync(join(root, "src/pricing.js"), "utf8")).join("\n");
  assert.deepEqual(
    hitsIn("src/pricing.js", pricing, { allowRivalName: true }).filter(
      (hit) => hit.term === "Space",
    ),
    [],
  );
  const other = quotedStrings('export const title = "Space";').join("\n");
  assert.ok(
    hitsIn("src/status.js", other).some((hit) => hit.term === "Space"),
    "a Space title in any other src module must fail",
  );
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
