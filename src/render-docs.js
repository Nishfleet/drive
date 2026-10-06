// The docs pages are authored Markdown with {{MARKER}} placeholders, and this
// module is the only thing that turns them into the pages VitePress builds.
//
// Why not the stock VitePress path: every marker's value is read from
// core/billing.js (the money), core/status.js (the one command) and src/keys.js
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_PAGES as SEO_DOC_PAGES } from "../core/seo.js";
import { faqMarkdown, markerValues } from "./docs.js";

// The pages that make up the docs, in the order the sitemap and the docs home
// list them. The list itself lives in core/seo.js, with the sitemap and the root
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
const BENCHMARKS = fileURLToPath(new URL("../docs/benchmarks.md", import.meta.url));

// The agent eval's own reading stack (evals/agents, drive#222) carries the
// CLI's help text next to the rendered pages, and that text is the CLI's
// words: `cmd/drive/main.go`'s `usage` const. The snapshot is a committed file
// that only `npm run eval:sync-help` writes. It used to ride `docs:render`,
// and that made the gate compare the render's own fresh write to main.go: two
// live values that agree by construction, so a stale committed snapshot passed
// CI while `npm run docs:render` dirtied a clean main (drive#332). One command
// of its own keeps the committed file the single input the eval reads and the
// single artifact the gate checks, so a flag added to the CLI fails the build
// instead of being rewritten just ahead of the check that looks for it.
const MAIN_GO = fileURLToPath(new URL("../cmd/drive/main.go", import.meta.url));
export const HELP_SNAPSHOT = fileURLToPath(
  new URL("../evals/agents/context/drive-help.txt", import.meta.url),
);

/** The `usage` const's text, or an error that names the file nothing matched. */
export function cliUsageText() {
  const src = readFileSync(MAIN_GO, "utf8");
  // A Go raw string cannot hold a backtick, so the text between the
  // const's opening backtick and the first closing one is the whole usage
  // block. Anchor on the statement, not on what follows it: main now declares
  // `var version` after the block, which a const-only anchor missed.
  const match = src.match(/^const usage = `([^`]*)`/m);
  if (!match) {
    throw new Error("cmd/drive/main.go has no `const usage = ...` block to render");
  }
  return match[1].trim();
}

/**
 * The subcommands the CLI runs, from cmd/drive/main.go's `commands` table:
 * the one place a subcommand exists, because the dispatch reads the table and
 * the Go gates hold the agent notes and the help text to it. main answers
 * `version` and `help` before the table, so they are answers a page may show
 * as commands. Read here, so a docs gate and a Go gate cannot end up with
 * two parses of one table.
 * @returns {ReadonlySet<string>}
 */
export function cliSubcommands() {
  const src = readFileSync(MAIN_GO, "utf8");
  const start = src.indexOf("var commands = map[string]func([]string) error{");
  if (start < 0) {
    throw new Error("cmd/drive/main.go has no `var commands` table to read");
  }
  // Brace-count to the map's own close: a command value may carry braces of
  // its own, and stopping at the first `}` would silently drop every command
  // after it. The name pattern is the one the docs mention, digits and hyphens
  // included, so a subcommand the CLI gains cannot be visible to one parse and
  // invisible to the other.
  const open = src.indexOf("{", start);
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) {
    throw new Error("cmd/drive/main.go's command table has no closing brace");
  }
  const body = src.slice(open, close);
  const names = [...body.matchAll(/"([a-z0-9-]+)":/g)].map((m) => m[1]);
  if (names.length < 10) {
    throw new Error("cmd/drive/main.go's command table parsed to fewer than 10 subcommands");
  }
  return new Set([...names, "version", "help"]);
}

/**
 * Write the eval's CLI-help snapshot from main.go, so the eval's context and
 * the shipped CLI cannot drift apart. Plain function, so `node --test` runs
 * it directly, and the eval's own gate compares the committed file to the same
 * text this writes.
 * @param {string} [snapshotPath] defaults to evals/agents/context/drive-help.txt
 * @returns {string} the text written
 */
export function renderHelpSnapshot(snapshotPath = HELP_SNAPSHOT) {
  const text = `${cliUsageText()}\n`;
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, text);
  return text;
}

/** The two published sections of docs/benchmarks.md, from the Linux heading. */
function publishedBenchmarks() {
  const text = readFileSync(BENCHMARKS, "utf8");
  const start = text.indexOf("## Linux VPS");
  const end = text.indexOf("<!-- end published -->");
  if (start < 0) {
    throw new Error("docs/benchmarks.md has no Linux VPS section to publish");
  }
  if (end < start) {
    throw new Error("docs/benchmarks.md has no end-published marker after the Linux section");
  }
  return text.slice(start, end).trim();
}

/** The markers that need a file read: the FAQ and the Benchmarks table. */
function fileMarkers() {
  return { FAQ: faqMarkdown(readFileSync(SCOREBOARD, "utf8")), BENCHMARKS: publishedBenchmarks() };
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
    const names = [...new Set([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))];
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
        throw new Error(`docs page uses {{${name}}}, which src/docs.js does not define`);
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
    throw new Error(`src/docs.js defines markers no page uses: ${unused.join(", ")}`);
  }
  return DOC_PAGES;
}

// `node src/render-docs.js` is what `npm run docs:render` runs, so the docs
// build has one entry point and no script file of its own. The help snapshot
// does NOT ride it: `docs:render` runs inside `npm test` before the tests, so
// writing the committed snapshot here let the gate compare the build's output
// with itself, and a stale snapshot passed CI (drive#332). `--sync-help` is the
// one command that writes the snapshot (only the snapshot; rendering the pages
// is a build step, not a sync), so CLI drift in main.go fails the build.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.argv.includes("--sync-help")) {
    renderHelpSnapshot();
  } else {
    renderDocs();
  }
}
