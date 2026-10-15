import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const PUBLIC_DIR = new URL("../public/", import.meta.url);
const siteCss = readFileSync(new URL("site.css", PUBLIC_DIR), "utf8");
const pages = readdirSync(PUBLIC_DIR).filter((name) => name.endsWith(".html"));

test("the shared stylesheet turns every animation and transition off for reduced motion", () => {
  const block =
    siteCss.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(block, /animation:\s*none\s*!important/);
  assert.match(block, /transition:\s*none\s*!important/);
});

test("a page that animates links the shared stylesheet, which carries the reset", () => {
  for (const name of pages) {
    const html = readFileSync(new URL(name, PUBLIC_DIR), "utf8");
    if (!/\b(animation|transition)\s*:/.test(html)) continue;
    assert.match(html, /href="\/site\.css/, `${name} animates without the shared reset`);
  }
});

test("no shared transition runs 250 ms or longer", () => {
  for (const [, value, unit] of siteCss.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)) {
    const ms = unit === "s" ? Number(value) * 1000 : Number(value);
    assert.ok(ms < 250, `site.css has a ${value}${unit} duration`);
  }
});

test("the home page's hero demo stops by itself, can be paused, and uses opacity only", () => {
  const html = readFileSync(new URL("index.html", PUBLIC_DIR), "utf8");
  assert.match(html, /--demo-loops:\s*3;/);
  assert.match(html, /id="demo-toggle"[^>]*aria-pressed="false"/);
  assert.match(html, /\.stage\.demo\.is-paused \* \{\s*animation-play-state: paused;/);
  const frames = [...html.matchAll(/@keyframes demo-in-\d+ \{([\s\S]*?)\n\}\n/g)].map((m) => m[1]);
  assert.ok(frames.length >= 9, "one keyframe set per revealed line and row");
  for (const body of frames) {
    assert.doesNotMatch(body, /transform|width|height|margin|top|left/);
  }
});
