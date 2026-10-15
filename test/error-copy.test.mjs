import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SIGNED_IN = ["home", "files", "usage", "billing", "devices", "webhooks"];
const page = (/** @type {string} */ name) =>
  readFileSync(new URL(`../public/${name}.html`, import.meta.url), "utf8");

const FAILURE_WORDS = /\b(could not|did not work|did not save|did not finish|failed)\b/i;
const NEXT_STEP = /(try again|pick it again|check your|sign in|reload|open |press |ask |wait )/i;

test("every error block on a signed-in page names the next step and carries a Try again button", () => {
  for (const name of SIGNED_IN) {
    const html = page(name);
    for (const block of html.matchAll(/<div class="status"[^>]*>([\s\S]*?)<\/div>/g)) {
      if (!block[1].includes('class="what"')) continue;
      assert.ok(block[1].includes('class="next"'), `${name}: an error block has no next step`);
      assert.match(
        block[1],
        /<button type="button" id="[a-z-]+-retry"[^>]*class="btn">Try again<\/button>/,
        `${name}: an error block has no Try again button`,
      );
    }
  }
});

test("every failure sentence a page script can show says what to do next", () => {
  /** @type {string[]} */
  const missing = [];
  for (const name of SIGNED_IN) {
    for (const literal of page(name).matchAll(/(?<!what: )"([^"\n]{12,200})"/g)) {
      const text = literal[1];
      if (FAILURE_WORDS.test(text) && !NEXT_STEP.test(text)) missing.push(`${name}: ${text}`);
    }
  }
  assert.deepEqual(missing, [], "each failure message needs a next step");
});
