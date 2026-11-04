import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_PAGES as SEO_DOC_PAGES } from "../core/seo.js";
import { faqMarkdown, markerValues } from "./docs.js";
import { createApp } from "./index-app.js";

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

const REPO = fileURLToPath(new URL("../", import.meta.url));

/**
 * The bindings `cloudflare.config.ts` declares, as `NAME: bindings.kind(`.
 * The config imports `cf/config`, which Node cannot load, so it is read as
 * text (the way test/worker-secrets.test.mjs reads its secrets). Line
 * comments are dropped first, so a commented-out binding is not a fact.
 * @returns {ReadonlyArray<{name: string, kind: string}>}
 */
export function workerBindings() {
  const config = readFileSync(join(REPO, "cloudflare.config.ts"), "utf8");
  const live = config.replace(/^\s*\/\/.*$/gm, "");
  const found = [...live.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*:\s*bindings\.(\w+)\s*[(<]/gm)].map(
    (m) => ({ name: m[1], kind: m[2] }),
  );
  if (found.length < 5) {
    throw new Error("cloudflare.config.ts parsed to fewer than 5 bindings");
  }
  return found;
}

/**
 * The site Worker's routes, read from the Hono app src/index-app.js builds:
 * the table the Worker answers from, not a copy of it. `app.use` middleware
 * on every path (`*`) is not a route.
 * @returns {string[]}
 */
export function siteRoutes() {
  const seen = new Set(
    createApp()
      .routes.filter((r) => r.path !== "*")
      .map((r) => `${r.method} ${r.path}`),
  );
  return [...seen];
}

/** @param {string} kind */
const named = (kind) => workerBindings().filter((b) => b.kind === kind);

/**
 * The generated fact lists, by the name in `<!-- facts:NAME -->`. A block
 * value starts and ends with a newline; an inline one has none.
 * @returns {Record<string, string>}
 */
export function factValues() {
  return {
    D1_BINDINGS: named("d1")
      .map((b) => `\`${b.name}\``)
      .join(", "),
    SECRETS: `\n${named("secret")
      .map((b) => `- \`${b.name}\``)
      .join("\n")}\n`,
    BINDINGS: `\n| Binding | Kind |\n| --- | --- |\n${workerBindings()
      .map((b) => `| \`${b.name}\` | ${b.kind} |`)
      .join("\n")}\n`,
    ROUTES: `\n${siteRoutes()
      .map((r) => `- \`${r}\``)
      .join("\n")}\n`,
  };
}

/** Every file that holds a facts block: where a list used to be typed by hand. */
export const FACT_FILES = Object.freeze([
  "README.md",
  "AGENTS.md",
  "docs/runbook.md",
  "docs/runbooks/incident.md",
]);

const FACT_BLOCK = /(<!-- facts:([A-Z0-9_]+) -->)([\s\S]*?)(<!-- \/facts:\2 -->)/g;

/**
 * Fill every `<!-- facts:NAME -->...<!-- /facts:NAME -->` block in `text`
 * from `values`. A name with no generator is an error.
 * @param {string} text
 * @param {Record<string, string>} [values]
 * @param {Set<string>} [used]
 * @returns {string}
 */
export function applyFacts(text, values = factValues(), used = new Set()) {
  return text.replace(FACT_BLOCK, (_whole, open, name, _old, close) => {
    if (!(name in values)) {
      throw new Error(
        `a docs page has <!-- facts:${name} -->, which src/render-docs.js does not generate`,
      );
    }
    used.add(name);
    return `${open}${values[name]}${close}`;
  });
}

/** Rewrite the facts blocks in the repo docs in place. */
export function renderFacts() {
  const values = factValues();
  const used = new Set();
  for (const file of FACT_FILES) {
    const path = join(REPO, file);
    const text = readFileSync(path, "utf8");
    const next = applyFacts(text, values, used);
    if (next !== text) writeFileSync(path, next);
  }
  const unused = Object.keys(values).filter((name) => !used.has(name));
  if (unused.length > 0) {
    throw new Error(`src/render-docs.js generates facts no doc uses: ${unused.join(", ")}`);
  }
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
  // The facts blocks are written only on request (`npm run docs:facts`), never
  // by the docs build, so test/docs-drift.test.mjs sees a hand edit.
  if (process.argv.includes("--facts")) {
    renderFacts();
  } else {
    renderDocs();
  }
}
