import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { PREPAID, PRICE } from "../core/pricing.js";
import { applyFacts, FACT_FILES, factValues, workerBindings } from "../src/render-docs.js";
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

const FACT_BLOCK = /<!-- facts:([A-Z0-9_]+) -->[\s\S]*?<!-- \/facts:\1 -->/g;

test("the generated binding, secret and route lists in the docs match the config and the route table", () => {
  const values = factValues();
  const used = new Set();
  for (const file of FACT_FILES) {
    const text = read(file);
    assert.equal(
      applyFacts(text, values, used),
      text,
      `${file} has a generated facts block that differs from cloudflare.config.ts or src/index-app.js; run \`npm run docs:facts\` and commit the result, and do not hand-edit a block`,
    );
  }
  assert.deepEqual(
    [...used].sort(),
    Object.keys(values).sort(),
    "every generated list must sit in a doc, so a deleted marker cannot hide a stale list",
  );
});

test("no doc types out a list of Worker bindings by hand", () => {
  const files = ["README.md", "AGENTS.md"];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(`../${dir}`, import.meta.url), {
      withFileTypes: true,
    })) {
      if (entry.name === ".rendered" || entry.name === "node_modules") continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) files.push(path);
    }
  };
  walk("docs");
  walk("docs-site");
  const names = workerBindings().map((b) => b.name);
  const offenders = [];
  for (const file of files) {
    const text = read(file).replace(FACT_BLOCK, "");
    for (const [index, line] of text.split("\n").entries()) {
      const hits = names.filter((name) => new RegExp(`\\b${name}\\b`).test(line));
      if (hits.length >= 2) offenders.push(`${file}:${index + 1} names ${hits.join(", ")}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a hand-typed binding list goes stale (drive#253, #591, #1156); wrap it in a <!-- facts:NAME --> block that src/render-docs.js fills",
  );
});
