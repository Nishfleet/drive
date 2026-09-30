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
import { markerValues } from "./docs.js";
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

/**
 * Substitute the markers in one page's Markdown. A `{{NAME}}` that src/docs.js
 * does not produce is an error: a silent leftover marker is exactly how a
 * wrong price ships.
 * @param {string} source
 * @param {Record<string, string>} [values]
 * @returns {string}
 */
export function applyMarkers(source, values = markerValues()) {
  const found = [...source.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
  for (const name of found) {
    if (!(name in values)) {
      throw new Error(
        `docs page uses {{${name}}}, which src/docs.js does not define`,
      );
    }
  }
  return source.replace(/\{\{([A-Z_]+)\}\}/g, (_whole, name) => values[name]);
}

/**
 * Render every page into `outDir`, where the VitePress build reads them.
 * Returns the pages it wrote, so a caller can list them without re-reading.
 * @param {string} [outDir] defaults to docs-site/.rendered
 * @returns {ReadonlyArray<{file: string, title: string, url: string}>}
 */
export function renderDocs(outDir = RENDERED_DIR) {
  const values = markerValues();
  const used = new Set();
  mkdirSync(outDir, { recursive: true });
  for (const file of RENDERED_FILES) {
    const source = readFileSync(join(DOCS_DIR, file), "utf8");
    for (const name of source.match(/\{\{([A-Z_]+)\}\}/g) || []) {
      used.add(name.slice(2, -2));
    }
    writeFileSync(join(outDir, file), applyMarkers(source, values));
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
