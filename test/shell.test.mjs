// The shared page shell (src/render-shell.js, shell/): every page that carries
// a shell pair matches its partial, and the pages that must share a header or
// footer do carry one.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { syncShell, withShell } from "../src/render-shell.js";

const page = (/** @type {string} */ name) =>
  readFileSync(new URL(`../public/${name}.html`, import.meta.url), "utf8");

const PUBLIC_PAGES = [
  "404",
  "500",
  "acceptable-use",
  "accessibility",
  "privacy",
  "refunds",
  "status",
  "support",
  "terms",
];
const APP_PAGES = /** @type {Record<string, string>} */ ({
  files: "/files",
  usage: "/usage",
  devices: "/devices",
});
const FOOTER_PAGES = [...PUBLIC_PAGES, "signin", "upload"];

test("no page is out of date with shell/", () => {
  assert.deepEqual(syncShell({ write: false }), [], "run npm run shell:sync");
});

test("the public and legal pages share one header and one footer", () => {
  for (const name of PUBLIC_PAGES) {
    assert.match(page(name), /<!-- shell:public-header -->/, `${name} carries the public header`);
  }
  for (const name of FOOTER_PAGES) {
    assert.match(page(name), /<!-- shell:footer -->/, `${name} carries the shared footer`);
  }
});

test("the signed-in pages share one app header, with their own link marked", () => {
  for (const [name, href] of Object.entries(APP_PAGES)) {
    const html = page(name);
    assert.ok(html.includes(`<!-- shell:app-header current="${href}" -->`), name);
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1, `${name} marks one page`);
    assert.match(html, new RegExp(`<a href="${href}" aria-current="page">`), name);
  }
});

test("a hand edit inside a shell pair is put back", () => {
  const edited = page("privacy").replace(
    '<a href="/terms">Terms</a>',
    '<a href="/terms">Terms of use</a>',
  );
  assert.notEqual(withShell(edited), edited);
  assert.equal(withShell(edited), page("privacy"));
});
