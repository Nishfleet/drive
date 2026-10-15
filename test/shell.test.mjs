import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
  home: "/home",
  files: "/files",
  usage: "/usage",
  billing: "/billing",
  devices: "/devices",
  webhooks: "/webhooks",
});
const NOT_APP_PAGES = new Set([...PUBLIC_PAGES, "index", "signin", "starter", "upload", "og-card"]);
const FOOTER_PAGES = [...PUBLIC_PAGES, "signin", "upload", "starter", ...Object.keys(APP_PAGES)];

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
    assert.equal(
      (html.match(/aria-current="page"/g) ?? []).length,
      2,
      `${name} marks its page in the sidebar and in the tab bar`,
    );
    assert.match(html, new RegExp(`<a href="${href}" aria-current="page">`), name);
    for (const part of ['class="app-side"', 'class="app-top"', 'class="app-tabs"']) {
      assert.ok(html.includes(part), `${name} renders ${part}`);
    }
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

test("every page that is not public carries the app shell", () => {
  const pages = readdirSync(new URL("../public/", import.meta.url))
    .filter((file) => file.endsWith(".html"))
    .map((file) => file.replace(/\.html$/, ""));
  for (const name of pages) {
    if (NOT_APP_PAGES.has(name)) continue;
    assert.ok(
      name in APP_PAGES,
      `${name}.html is neither a public page nor listed in APP_PAGES; a signed-in page must carry the app shell`,
    );
  }
});

test("a page's footer is the shared one, never its own copy", () => {
  for (const name of FOOTER_PAGES) {
    const html = page(name);
    const inside = html.match(/<!-- shell:footer -->[\s\S]*?<!-- \/shell:footer -->/)?.[0] ?? "";
    assert.equal(html.split("<footer").length - 1, 1, `${name} has one footer element`);
    assert.ok(inside.includes("<footer"), `${name}'s footer sits inside the shared block`);
  }
});
