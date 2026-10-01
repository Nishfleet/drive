// The message table is the single source for every failure string the CLI and
// the web pages show. These tests pin its shape, the "one next step" rule and
// the safety rules (no secrets, no keys, no other-user paths, no raw error
// text) so a new entry cannot ship a stack, a token or a two-step fix-it list.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const REQUIRED_PATHS = [
  "offline",
  "cap-reached",
  "key-revoked",
  "disk-cache-full",
  "storage-down",
  "payment-failed",
  "unauthorized",
  // The sign-in screen's two words (drive#10): the closed door while the
  // account store lands with build step 1, and the refusal a cross-site
  // request gets from the same-origin rule.
  "sign-in-closed",
  "cross-site",
];

// Every entry must have exactly these keys, no more, no less (sorted for the
// deepEqual against Object.keys(entry).sort()).
const REQUIRED_KEYS = ["next", "what"];

// A single-sentence test: split on sentence endings followed by whitespace.
function countSentences(text) {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean).length;
}

// Safety regexes: these must NOT appear in either what or next.
const SECRET_MARKERS = [
  /\$\{/, // template literal
  /`/, // backtick
  /\b(?:Error|TypeError|Exception|stack|undefined|null|NaN)\b/, // raw error names
  /\/u\//, // other user's B2 prefix pattern
  /\\/, // windows path separator
  /[A-Za-z0-9+/]{32,}/, // base64-like token run (no legitimate sentence has this)
];

test("the named failure paths exist", () => {
  for (const key of REQUIRED_PATHS) {
    assert.ok(key in FAILURE_MESSAGES, `missing required path: ${key}`);
  }
});

test("every entry has exactly { what, next }", () => {
  for (const [key, entry] of Object.entries(FAILURE_MESSAGES)) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      REQUIRED_KEYS,
      `${key} must have exactly what and next`,
    );
    for (const k of REQUIRED_KEYS) {
      const v = entry[k];
      assert.ok(typeof v === "string" && v.length > 0, `${key}.${k} must be a non-empty string`);
      assert.equal(v.trim(), v, `${key}.${k} must not have leading/trailing whitespace`);
      assert.equal(countSentences(v), 1, `${key}.${k} must be exactly one sentence`);
      assert.match(v, /\.$/, `${key}.${k} must end with a period`);
    }
  }
});

test("no entry contains secrets, keys, other-user paths, or raw error text", () => {
  for (const [key, entry] of Object.entries(FAILURE_MESSAGES)) {
    const combined = `${entry.what} ${entry.next}`;
    for (const rx of SECRET_MARKERS) {
      assert.ok(
        !rx.test(combined),
        `${key} contains a forbidden pattern ${rx.source} in: ${combined}`,
      );
    }
  }
});

test("failureMessage joins what and next with a single space", () => {
  for (const key of Object.keys(FAILURE_MESSAGES)) {
    const expected = `${FAILURE_MESSAGES[key].what} ${FAILURE_MESSAGES[key].next}`;
    assert.equal(failureMessage(key), expected, `${key} message must be the exact join`);
  }
});

test("failureMessage throws on an unknown key instead of returning a default", () => {
  assert.throws(() => failureMessage("no-such-path"), /no failure message for "no-such-path"/);
});

test("the pricing page embeds the exact offline message from the table", () => {
  const expected = failureMessage("offline");
  assert.ok(
    page.includes(expected),
    `the pricing page must contain the exact offline message: "${expected}"`,
  );
});

test("the pricing page embeds the exact unexpected fallback from the table", () => {
  const expected = failureMessage("unexpected");
  assert.ok(
    page.includes(expected),
    `the pricing page must contain the exact unexpected message: "${expected}"`,
  );
});
