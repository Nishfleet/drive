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
// 3. No page keeps a second copy of a token in its own block. A token is the
//    thing a page-by-page edit gets wrong, so it is the thing this fails on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const SITE_CSS = "../public/site.css";
const PAGES = [
  ["get-started.html", "../get-started.html"],
  ["public/index.html", "../public/index.html"],
  ["public/files.html", "../public/files.html"],
  ["public/usage.html", "../public/usage.html"],
];

// The palette and the type, one line each so the comparison ignores how the
// stylesheet wraps them. These are the values the pricing page was designed
// with (docs/design/pricing-brief.md); changing one changes the product's
// look, so it has to be a deliberate edit here too.
const TOKENS = {
  "--paper": "#faf6ee",
  "--ink": "#21201c",
  "--accent": "#1f3a5f",
  "--serif":
    'ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
  "--sans":
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "--mono":
    'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
};

/** Every value declared for a custom property, whitespace collapsed. */
function declarations(css, token) {
  const pattern = new RegExp(`${token}\\s*:([^;]*);`, "g");
  return [...css.matchAll(pattern)].map(([, value]) => value.trim().replace(/\s+/g, " "));
}

test("the shared stylesheet declares the palette and the type, once each", () => {
  const css = read(SITE_CSS);
  for (const [token, value] of Object.entries(TOKENS)) {
    assert.deepEqual(
      declarations(css, token),
      [value],
      `public/site.css must declare ${token}: ${value} exactly once`,
    );
  }
});

test("every page links the shared stylesheet before its own styles", () => {
  for (const [name, path] of PAGES) {
    const html = read(path);
    assert.match(
      html,
      /<link\s+rel="stylesheet"\s+href="\/site\.css">/,
      `${name} must link /site.css`,
    );
    const linkAt = html.indexOf('href="/site.css"');
    const styleAt = html.indexOf("<style>");
    assert.ok(
      styleAt > linkAt,
      `${name}'s own <style> block must load after the shared stylesheet`,
    );
  }
});

test("no page keeps a second copy of a palette or type token", () => {
  for (const [name, path] of PAGES) {
    const html = read(path);
    const block = html.match(/<style>([\s\S]*?)<\/style>/);
    assert.ok(block, `${name} must keep a <style> block for its per-page rules`);
    for (const token of Object.keys(TOKENS)) {
      assert.equal(
        declarations(block[1], token).length,
        0,
        `${name} must not re-declare ${token}; that token belongs to public/site.css`,
      );
    }
  }
});
