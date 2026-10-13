// High-end gaps item 7: the home hero reads as an offer, not a closed door.
// The standing "not open yet" claim (test/version-1-claims.test.mjs) stays on
// the page, but beside the waitlist form, not under the first button.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NOT_OPEN } from "../src/release-state.js";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("the hero does not say the drive is closed, and the waitlist form does", () => {
  const hero = page.match(/<section class="hero"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.ok(hero.length > 0, "the hero section exists");
  assert.doesNotMatch(hero, /not open yet/i);
  const form = page.match(/<form class="waitlist"[\s\S]*?<\/form>/)?.[0] ?? "";
  assert.ok(form.includes(NOT_OPEN), "the waitlist form carries the standing claim");
});
