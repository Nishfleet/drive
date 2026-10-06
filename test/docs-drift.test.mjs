// Drift gates for drive#525: every api Worker route is named in docs/api.md,
// CLI user-facing text cannot name a web page that does not exist, and the
// spec's current price/plan/provider/platform lines follow core/pricing.js.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { PREPAID, PRICE } from "../core/pricing.js";
import { routes } from "../workers/api/src/routes.js";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("every api Worker route is named in docs/api.md", () => {
  const api = read("docs/api.md");
  assert.ok(routes.length > 0, "the registry is empty");
  for (const route of routes) {
    const needle = `\`${route.method} ${route.path}\``;
    assert.ok(
      api.includes(needle),
      `docs/api.md is missing ${needle}; a live route with no contract is the drift drive#525 names`,
    );
  }
});

test("CLI user-facing text names only web pages that exist", () => {
  const dir = new URL("../cmd/drive/", import.meta.url);
  const generic = new Set(["first", "last", "next", "same", "one", "upload", "approval"]);
  /** @type {Array<{file: string, page: string}>} */
  const named = [];
  for (const name of readdirSync(dir).filter(
    (file) => file.endsWith(".go") && !file.endsWith("_test.go"),
  )) {
    const text = readFileSync(new URL(name, dir), "utf8");
    for (const quoted of text.matchAll(/"(?:\\.|[^"\\])*"/g)) {
      for (const match of quoted[0].matchAll(/\bthe ([a-z-]+) page\b/g)) {
        const page = match[1];
        if (generic.has(page)) continue;
        named.push({ file: `cmd/drive/${name}`, page });
      }
    }
  }
  assert.ok(named.length > 0, "the CLI names no web page; the devices-page sentence is gone");
  assert.ok(
    named.some((entry) => entry.page === "devices"),
    "the CLI no longer names the devices page; cmd/drive still has that sentence on origin/main",
  );
  const aliases = new Map([
    ["devices", "public/devices.html"],
    ["usage", "public/usage.html"],
    ["signin", "public/signin.html"],
    ["sign-in", "public/signin.html"],
    ["files", "public/files.html"],
  ]);
  for (const { file, page } of named) {
    const path = aliases.get(page);
    assert.ok(path, `${file} names "the ${page} page" and there is no public/${page}.html`);
    assert.equal(
      readFileSync(new URL(`../${path}`, import.meta.url), "utf8").length > 0,
      true,
      `${file} names "the ${page} page" but ${path} is empty`,
    );
  }
});

test("spec.md and build-spec.md match the shipped price, plans, provider and platforms", () => {
  const spec = read("docs/spec.md");
  const build = read("docs/build-spec.md");
  for (const [name, text] of [
    ["docs/spec.md", spec],
    ["docs/build-spec.md", build],
  ]) {
    assert.match(
      text,
      new RegExp(`${PRICE.rateCents}¢ per GB`),
      `${name} must state the shipped ${PRICE.rateCents}¢ rate`,
    );
    assert.match(
      text,
      new RegExp(`Never more than \\$${PRICE.maxUsdPerTb} per TB`),
      `${name} must state the shipped ${PRICE.maxLine}`,
    );
    assert.match(text, /iDrive e2/, `${name} must name the shipped primary provider`);
    assert.match(text, /macOS and Linux/, `${name} must name the shipped platforms`);
  }
  assert.doesNotMatch(
    build,
    /\| Membership \| \$10 a month membership/,
    "build-spec.md still ships the retired membership as the current plan",
  );
  assert.match(
    build,
    new RegExp(`Add \\$${PREPAID.minTopUpUsd} or more`),
    "build-spec.md must state the shipped prepaid top-up",
  );
  assert.match(build, /No plans/, "build-spec.md must state that there are no plans");
  assert.match(build, /No Windows in v1/, "build-spec.md must keep Windows out of v1");
});

test("spec.md and build-spec.md state no retired price as current", () => {
  const retired = [
    /max\(\$12, \$8/,
    /\$12 a TB, then \$8/,
    /\$10 a month membership/,
    /membership is \$10/,
  ];
  for (const name of ["docs/spec.md", "docs/build-spec.md"]) {
    for (const line of read(name).split("\n")) {
      if (/retired|older|was max/i.test(line)) continue;
      for (const pattern of retired) {
        assert.doesNotMatch(
          line,
          pattern,
          `${name} states a retired price as current: ${line.trim()}`,
        );
      }
    }
  }
});
