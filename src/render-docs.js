// The docs pages are authored Markdown with {{MARKER}} placeholders, and this
// module is the only thing that turns them into the pages VitePress builds.
//
// Why not the stock VitePress path: every marker's value is read from
// src/billing.js (the money), src/status.js (the one command) and src/keys.js
// (what a key may do) at build time, and the Markdown copy the llms plugin
// emits is the file before VitePress compiles it, so a Vue interpolation would
// render for people and print a bare marker to agents. One pass over the pages
// keeps both outputs the same document.
//
// A page may only use a marker src/docs.js defines, and src/docs.js may not
// define one no page uses, so the pass fails the build rather than shipping a
// template or a stale string. Plain functions, so `node --test` runs this
// directly.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { faqMarkdown, markerValues } from "./docs.js";
import { DOC_PAGES as SEO_DOC_PAGES } from "./seo.js";

// The pages that make up the docs, in the order the sitemap and the docs home
// list them. The list itself lives in src/seo.js, with the sitemap and the root
// llms.txt, so a page cannot be built without being listed there (or listed
// there without being built); this module only works out the file each entry
// names. The file name is the page's last path segment: /docs/how-it-works is
// docs-site/how-it-works.md, and the llms plugin emits how-it-works.md next to
// how-it-works.html.
//
// index.md is the docs home and is deliberately absent: the llms plugin skips
// the docs home (it emits index.html without an index.md copy), so every page
// that must be reachable as .md lives at its own name.
export const DOC_PAGES = Object.freeze(
  SEO_DOC_PAGES.map((page) =>
    Object.freeze({
      file: `${page.path.replace("/docs/", "")}.md`,
      title: page.title,
      url: page.path,
    }),
  ),
);

// The docs home, rendered but not listed as a page. It is the table of
// contents, so it carries the one price line and links the pages above.
const DOCS_HOME = "index.md";

// Every file the build renders, home first.
const RENDERED_FILES = Object.freeze([DOCS_HOME, ...DOC_PAGES.map((p) => p.file)]);

// Where the authored pages are and where the build reads them from. Both are
// inside the docs project, so a build never writes into the repository root.
const DOCS_DIR = fileURLToPath(new URL("../docs-site/", import.meta.url));
export const RENDERED_DIR = join(DOCS_DIR, ".rendered");

// The head-to-head table the FAQ is gated against (docs/scoreboard.md, drive
// issue #114). src/docs.js stays plain data and reads no file, so this build
// step is the one that opens it and hands the text to faqMarkdown(): an answer
// whose row is not a measured win fails here, at the build, instead of shipping
// a number nobody has measured.
const SCOREBOARD = fileURLToPath(new URL("../docs/scoreboard.md", import.meta.url));

/** The markers that need a file read: today, just the FAQ's own Markdown. */
function fileMarkers() {
  return { FAQ: faqMarkdown(readFileSync(SCOREBOARD, "utf8")) };
}

// A marker's value may itself carry markers: the FAQ's answers are Markdown
// with the price markers in them, so substituting {{FAQ}} leaves {{RATE}}
// behind for the next round. Legitimate nesting is shallow, so a document that
// has not settled after this many rounds is a cycle, and throwing beats looping
// the build forever.
const MAX_MARKER_ROUNDS = 10;

/**
 * Substitute the markers in one page's Markdown, repeatedly, because a
 * marker's value may carry markers of its own. A `{{NAME}}` that src/docs.js
 * does not produce is an error: a silent leftover marker is exactly how a
 * wrong price ships. Every name that appeared in any round is added to `used`,
 * so a caller can tell a marker no page mentions from one only a nested value
 * reaches.
 * @param {string} source
 * @param {Record<string, string>} [values]
 * @param {Set<string>} [used]
 * @returns {string}
 */
export function applyMarkers(source, values = markerValues(), used = new Set()) {
  let text = source;
  for (let round = 0; ; round += 1) {
    const names = [
      ...new Set([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1])),
    ];
    if (names.length === 0) {
      return text;
    }
    if (round >= MAX_MARKER_ROUNDS) {
      throw new Error(
        `a docs marker did not settle after ${MAX_MARKER_ROUNDS} rounds (${names.join(", ")}); a marker's value contains the marker it replaces`,
      );
    }
    for (const name of names) {
      if (!(name in values)) {
        throw new Error(
          `docs page uses {{${name}}}, which src/docs.js does not define`,
        );
      }
      used.add(name);
    }
    text = text.replace(/\{\{([A-Z_]+)\}\}/g, (_whole, name) => values[name]);
  }
}

/**
 * Render every page into `outDir`, where the VitePress build reads them.
 * Returns the pages it wrote, so a caller can list them without re-reading.
 * @param {string} [outDir] defaults to docs-site/.rendered
 * @returns {ReadonlyArray<{file: string, title: string, url: string}>}
 */
export function renderDocs(outDir = RENDERED_DIR) {
  const values = markerValues(fileMarkers());
  const used = new Set();
  mkdirSync(outDir, { recursive: true });
  for (const file of RENDERED_FILES) {
    const source = readFileSync(join(DOCS_DIR, file), "utf8");
    writeFileSync(join(outDir, file), applyMarkers(source, values, used));
  }
  // A value src/docs.js computes and no page reads is either a page that lost
  // its marker or a figure that stopped being stated; both are drift, so the
  // render fails rather than shipping quietly.
  const unused = Object.keys(values).filter((name) => !used.has(name));
  if (unused.length > 0) {
    throw new Error(
      `src/docs.js defines markers no page uses: ${unused.join(", ")}`,
    );
  }
  return DOC_PAGES;
}

// `node src/render-docs.js` is what `npm run docs:render` runs, so the docs
// build has one entry point and no script file of its own.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  renderDocs();
}
