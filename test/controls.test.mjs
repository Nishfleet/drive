import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const PUBLIC_DIR = new URL("../public/", import.meta.url);
const SHARED = ["btn", "field", "check", "slider"];
const EXEMPT_TYPES = new Set(["hidden", "file"]);
const siteCss = readFileSync(new URL("site.css", PUBLIC_DIR), "utf8");
const pages = readdirSync(PUBLIC_DIR).filter(
  (name) => name.endsWith(".html") && name !== "og-card.html",
);

test("every control in the markup wears one of the shared control classes", () => {
  /** @type {string[]} */
  const offenders = [];
  for (const name of pages) {
    const html = readFileSync(new URL(name, PUBLIC_DIR), "utf8");
    const body = html.slice(html.indexOf("<body"));
    for (const found of body.matchAll(/<(button|input|select|textarea)\b([^>]*)>/g)) {
      const [tag, kind, attrs] = found;
      const type = attrs.match(/type="([^"]*)"/)?.[1] ?? "";
      if (kind === "input" && EXEMPT_TYPES.has(type)) continue;
      const classes = (attrs.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
      if (!SHARED.some((shared) => classes.includes(shared))) offenders.push(`${name}: ${tag}`);
    }
  }
  assert.deepEqual(offenders, [], "give these a shared class from public/site.css");
});

test("the controls a script builds wear a shared class as well", () => {
  /** @type {string[]} */
  const offenders = [];
  for (const name of pages) {
    const html = readFileSync(new URL(name, PUBLIC_DIR), "utf8");
    const lines = html.split("\n");
    lines.forEach((line, index) => {
      const made = line.match(
        /const (\w+) = document\.createElement\("(button|input|select|textarea)"\)/,
      );
      if (!made) return;
      const variable = made[1];
      const following = lines.slice(index, index + 8).join("\n");
      const typed = following.match(new RegExp(`${variable}\\.type = "(hidden|file)"`));
      if (typed) return;
      if (
        !new RegExp(`${variable}\\.className = "[^"]*\\b(btn|field|check|slider)\\b`).test(
          following,
        )
      ) {
        offenders.push(`${name}:${index + 1} ${variable}`);
      }
    });
  }
  assert.deepEqual(offenders, [], "set className to a shared control class");
});

test("the shared stylesheet defines every shared control class, each with a focus ring from one place", () => {
  for (const shared of ["btn", "btn-primary", "btn-danger", "btn-ghost", "btn-sm"]) {
    assert.match(siteCss, new RegExp(`\\.${shared}[ ,{:]`), `.${shared} is defined`);
  }
  assert.match(siteCss, /:focus-visible\s*\{\s*outline: 3px solid var\(--accent\)/);
  for (const name of pages) {
    const html = readFileSync(new URL(name, PUBLIC_DIR), "utf8");
    assert.ok(
      !/\n(?:button|input|select|textarea)(?:\[[^\]]*\])?\s*\{/.test(html),
      `${name} restyles a control element itself; use the shared classes`,
    );
  }
});
