// The shared page shell (high-end gap 8): one header and one footer, written
// once in shell/ and copied into every page that asks for it. The pages are
// static files, so the copy happens at build time, not in the browser: no
// script, no flash, and the page works with JavaScript off.
//
// A page asks with a pair of comments around the markup:
//
//     <!-- shell:app-header current="/usage" -->
//     ...generated...
//     <!-- /shell:app-header -->
//
// `npm run shell:sync` rewrites everything between each pair from
// shell/<name>.html. `current` names the page's own link, which gets
// aria-current="page". test/shell.test.mjs runs the same code in check mode,
// so a hand edit inside a pair, or a page that drifted from the partial, fails
// CI instead of reaching a visitor.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const SHELL_DIR = new URL("../shell/", import.meta.url);
const PUBLIC_DIR = new URL("../public/", import.meta.url);

const PAIR =
  /^([ \t]*)<!-- shell:([a-z-]+)(?: current="([^"]*)")? -->\n[\s\S]*?^[ \t]*<!-- \/shell:\2 -->$/gm;

/**
 * The partial's markup, indented to sit where the marker sits, with the
 * current page's link marked.
 * @param {string} name
 * @param {string} indent
 * @param {string|undefined} current
 */
function rendered(name, indent, current) {
  let html = readFileSync(new URL(`${name}.html`, SHELL_DIR), "utf8").trimEnd();
  if (current !== undefined) {
    const link = `<a href="${current}"`;
    if (!html.includes(link)) {
      throw new Error(`shell/${name}.html has no link to ${current}`);
    }
    html = html.replace(link, `${link} aria-current="page"`);
  }
  const body = html
    .split("\n")
    .map((line) => (line === "" ? line : `${indent}${line}`))
    .join("\n");
  return `${indent}<!-- shell:${name}${current === undefined ? "" : ` current="${current}"`} -->\n${body}\n${indent}<!-- /shell:${name} -->`;
}

/**
 * The page with every shell pair regenerated.
 * @param {string} source
 * @returns {string}
 */
export function withShell(source) {
  return source.replace(PAIR, (_pair, indent, name, current) => rendered(name, indent, current));
}

/**
 * Regenerates every page under public/ (or only reports the ones out of date).
 * @param {{write: boolean}} options
 * @returns {string[]} the pages whose shell was out of date
 */
export function syncShell({ write }) {
  /** @type {string[]} */
  const stale = [];
  for (const name of readdirSync(PUBLIC_DIR).filter((file) => file.endsWith(".html"))) {
    const url = new URL(name, PUBLIC_DIR);
    const before = readFileSync(url, "utf8");
    const after = withShell(before);
    if (after !== before) {
      stale.push(name);
      if (write) writeFileSync(url, after);
    }
  }
  return stale;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  const stale = syncShell({ write: !check });
  if (check && stale.length > 0) {
    console.error(
      `These pages are out of date with shell/: ${stale.join(", ")}. Run npm run shell:sync.`,
    );
    process.exit(1);
  }
  console.log(check ? "the shell is in sync" : `shell synced (${stale.length} page(s) changed)`);
}
