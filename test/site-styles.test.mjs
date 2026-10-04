// The shared site stylesheet (drive issue #71). The pricing page, the
// first-run page, the Web Files page and the usage page each used to carry
// their own copy of the palette, the reset and the page chrome, so one edit to
// a token had to be made in every file or the pages drifted apart. They link
// public/site.css now, and this is the gate the refactor did not have:
//
// 1. The shared file declares the palette and the font stacks with the values
//    the product was reviewed at, exactly once each.
// 2. Every page links the shared file before its own <style> block, so the
//    page's per-page values can still override the base.
// 3. No page declares a custom property it does not own. A token is the thing
//    a page-by-page edit gets wrong, so a page is allowed only the page-local
//    tokens listed in PAGE_LOCAL, and any other --* declaration fails — even
//    one that does not exist yet.
// 4. The shared header and menu are declared in the shared file, not restated
//    per page. drive#425 found five pages restating the header — this gate
//    catches that drift.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const PUBLIC_DIR = new URL("../public/", import.meta.url);
// Every shipped page, walked the way test/seo.test.mjs walks them: the
// verbatim assets in public/ plus the Vite entry at the repo root, so a page
// added later is covered without editing this list.
/** @type {Array<[string, URL]>} */
const PAGES = [
  ...readdirSync(PUBLIC_DIR)
    .filter((name) => name.endsWith(".html"))
    .map((name) => /** @type {[string, URL]>} */ ([`public/${name}`, new URL(name, PUBLIC_DIR)])),
  ["get-started.html", new URL("../get-started.html", import.meta.url)],
];

const SITE_CSS = new URL("site.css", PUBLIC_DIR);

// The palette and the type, one line each so the comparison ignores how the
// stylesheet wraps them. These are the values the pricing page was designed
// with (docs/design/pricing-brief.md); changing one changes the product's
// look, so it has to be a deliberate edit here too.
const TOKENS = {
  "--paper": "#faf6ee",
  "--paper-raised": "#fffdf8",
  "--ink": "#21201c",
  "--ink-soft": "#56514a",
  "--ink-faint": "#6f6a5f",
  "--rule": "#ddd5c5",
  "--accent": "#1f3a5f",
  "--accent-soft": "#e6ecf3",
  "--good": "#1d5c3a",
  "--bad": "#8a2b2b",
  "--serif":
    'ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
  "--sans":
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "--mono":
    'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
};

// The one custom property a page owns: the Web Files page's 44px tap target.
// Everything else a page needs comes from public/site.css.
const PAGE_LOCAL = new Map([["public/files.html", new Set(["--tap"])]]);

// The parts of the header a page owns, and the properties it may restate
// there. These are page-level layout additions — columns, tap targets — and
// the files/sign-in pages' shorter header box. Every property the shared rule
// already sets must NOT be restated, even with the same value, so one shared
// source of truth exists.
//
// A property the shared rule does not set at all (a page's own column width,
// for one) is freely page-owned without a line here.
const CHROME_OVERRIDES = new Map([
  [
    "public/files.html",
    new Map([[".masthead", new Set(["margin", "padding", "border-bottom"])]])
  ],
  [
    "public/signin.html",
    new Map([[".masthead", new Set(["padding"])]])
  ],
]);

// The shared file's own header rules. Pages may restate only the
// properties named in CHROME_OVERRIDES above; everything else — layout,
// links, tagline, current-page rule, wordmark — is the shared file's.
const CHROME_RULES = [
  ".masthead {",
  ".masthead a {",
  '.masthead a[aria-current="page"] {',
  ".tagline {",
  ".wordmark {",
];

/**
 * Strip CSS comments, so a rule written in a comment cannot satisfy a gate.
 * @param {string} css
 */
const commentsRemoved = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every selector a stylesheet declares, cut at the opening brace.
 * @param {string} css
 */
function selectorsIn(css) {
  const found = new Set();
  for (const [, selector] of commentsRemoved(css).matchAll(/([^}{]+)\{/g)) {
    for (const part of selector.split(",")) {
      const trimmed = part.trim().replace(/\s+/g, " ");
      if (trimmed) found.add(trimmed);
    }
  }
  return found;
}

/**
 * Every custom property a stylesheet declares, name -> values, with comments
 * stripped and the property name matched exactly (so `--my--paper` is not a
 * match for `--paper`).
 * @param {string} css
 */
function declaredTokens(css) {
  const clean = commentsRemoved(css);
  const found = new Map();
  for (const [, name, value] of clean.matchAll(/(?:^|[;{\s])(--[-\w]+)\s*:\s*([^;]+);/g)) {
    const values = found.get(name) ?? [];
    values.push(value.trim().replace(/\s+/g, " "));
    found.set(name, values);
  }
  return found;
}

/**
 * The body of every `<style>` block in a page, so a rule inside a comment or
 * an attribute cannot be read as a declaration.
 * @param {string} html
 */
function styleBlocks(html) {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
}

/**
 * Every rule in a stylesheet, selector -> body. Comments are already stripped.
 * @param {string} css
 */
function ruleBodies(css) {
  /** @type {Array<[string, string]>} */
  const rules = [];
  for (const [, selectors, body] of css.matchAll(/([^}{]+)\{([^}]*)\}/g)) {
    for (const part of selectors.split(",")) {
      const selector = part.trim().replace(/\s+/g, " ");
      if (selector) rules.push([selector, body]);
    }
  }
  return rules;
}

test("the shared stylesheet declares every token once, with the reviewed values", () => {
  const css = readFileSync(SITE_CSS, "utf8");
  for (const [token, value] of Object.entries(TOKENS)) {
    const values = declaredTokens(css).get(token);
    assert.deepEqual(values, [value], `${token} is declared once, as ${value}`);
  }
});

test("every page links the shared stylesheet first, then its own rules", () => {
  for (const [name, url] of PAGES) {
    const html = readFileSync(url, "utf8");
    const linkAt = html.indexOf('href="/site.css"');
    const styleAt = html.indexOf("<style>");
    assert.ok(styleAt !== -1, `${name} must keep a <style> block for its per-page rules`);
    assert.ok(
      styleAt > linkAt,
      `${name}'s own <style> block must load after the shared stylesheet`,
    );
  }
});

test("the shared header is declared once, in the shared stylesheet", () => {
  const css = readFileSync(SITE_CSS, "utf8");
  const inSiteCss = selectorsIn(css);
  for (const rule of CHROME_RULES) {
    const selector = rule.replace(/\s*\{$/, "");
    assert.ok(inSiteCss.has(selector), `public/site.css must declare ${rule}`);
  }

  // Only the header selectors — the shared chrome — are in scope here.
  const headerSelectors = new Set(CHROME_RULES.map((r) => r.replace(/\s*\{$/, "")));
  /** @type {Map<string, Set<string>>} */
  const sharedProperties = new Map();
  for (const [, selectors, body] of commentsRemoved(css).matchAll(/([^}{]+)\{([^}]*)\}/g)) {
    const props = new Set();
    for (const part of body.split(";")) {
      if (part.includes(":")) props.add(part.split(":")[0].trim());
    }
    for (const selector of selectors.split(",").map((s) => s.trim().replace(/\s+/g, " "))) {
      if (selector && headerSelectors.has(selector)) sharedProperties.set(selector, props);
    }
  }

  for (const [name, url] of PAGES) {
    const overrides = CHROME_OVERRIDES.get(name) ?? new Map();
    for (const block of styleBlocks(readFileSync(url, "utf8"))) {
      for (const [selector, body] of ruleBodies(block)) {
        const shared = sharedProperties.get(selector);
        if (!shared) continue; // page-level rule with no shared counterpart — free
        for (const part of body.split(";")) {
          if (!part.trim() || !part.includes(":")) continue;
          const property = part.split(":")[0].trim();
          const allowed = overrides.get(selector) ?? new Set();
          if (allowed.has(property) || !shared.has(property)) continue;
          assert.fail(
            `${name} restates ${property} on ${selector}; public/site.css owns that rule and drive#425 found five pages doing exactly this to the header`,
          );
        }
      }
    }
  }
});

test("no page declares a custom property it does not own", () => {
  for (const [name, url] of PAGES) {
    const blocks = styleBlocks(readFileSync(url, "utf8"));
    assert.ok(blocks.length > 0, `${name} must keep a <style> block for its per-page rules`);
    const local = PAGE_LOCAL.get(name) ?? new Set();
    for (const token of declaredTokens(blocks.join("\n")).keys()) {
      assert.ok(
        local.has(token),
        `${name} declares ${token}, which is a token the shared stylesheet owns`,
      );
    }
  }
});
