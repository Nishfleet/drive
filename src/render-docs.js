import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_PAGES as SEO_DOC_PAGES } from "../core/seo.js";
import { faqMarkdown, markerValues } from "./docs.js";

export const DOC_PAGES = Object.freeze(
  SEO_DOC_PAGES.map((page) =>
    Object.freeze({
      file: `${page.path.replace("/docs/", "")}.md`,
      title: page.title,
      url: page.path,
    }),
  ),
);

const DOCS_HOME = "index.md";

const RENDERED_FILES = Object.freeze([DOCS_HOME, ...DOC_PAGES.map((p) => p.file)]);

const DOCS_DIR = fileURLToPath(new URL("../docs-site/", import.meta.url));
export const RENDERED_DIR = join(DOCS_DIR, ".rendered");

const SCOREBOARD = fileURLToPath(new URL("../docs/scoreboard.md", import.meta.url));
const BENCHMARKS = fileURLToPath(new URL("../docs/benchmarks.md", import.meta.url));

const MAIN_GO = fileURLToPath(new URL("../cmd/drive/main.go", import.meta.url));
export const HELP_SNAPSHOT = fileURLToPath(
  new URL("../evals/agents/context/drive-help.txt", import.meta.url),
);

export function cliUsageText() {
  const src = readFileSync(MAIN_GO, "utf8");
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

function fileMarkers() {
  return { FAQ: faqMarkdown(readFileSync(SCOREBOARD, "utf8")), BENCHMARKS: publishedBenchmarks() };
}

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
  const unused = Object.keys(values).filter((name) => !used.has(name));
  if (unused.length > 0) {
    throw new Error(`src/docs.js defines markers no page uses: ${unused.join(", ")}`);
  }
  return DOC_PAGES;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.argv.includes("--sync-help")) {
    renderHelpSnapshot();
  } else {
    renderDocs();
  }
}
