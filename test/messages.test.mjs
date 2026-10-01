// The message table is the single source for every failure string the CLI and
// the web pages show. These tests pin its shape, the "one next step" rule and
// the safety rules (no secrets, no keys, no other-user paths, no raw error
// text) so a new entry cannot ship a stack, a token or a two-step fix-it list.
// The last two tests walk the handlers the way the two page tests walk the
// shipped pages: a handler's answer has to be the table's exact words, and no
// module may carry a second copy of one of its sentences (drive#158).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { BRANCHES_ENDPOINT, handleBranchesRequest } from "../src/branches.js";
import { createMemoryStore, FILES_ENDPOINT, handleFilesRequest } from "../src/files.js";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";
import { readSigninRequest } from "../src/signin.js";

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
  // The account routes' four failure paths (drive#158): the deployment with no
  // drive behind it, the request that is not a JSON object, the upload with no
  // file name, and the file this account does not have.
  "drive-not-configured",
  "json-object-needed",
  "upload-needs-name",
  "file-not-found",
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

// -------------------------------------------------------------- the handlers
// A handler that spells out its own sentence has a second source for it: an
// edit in one place drifts from the other and the same failure stops saying the
// same thing on every route (drive#158). Each call below is the real route, and
// the assertion is the table's exact join, so a copy drifts and fails here.

const now = Date.parse("2026-10-01T12:00:00.000Z");
// The signed-in account the routes take, the same stand-in test/files.test.mjs
// runs the file routes as.
const account = Object.freeze({ id: "1", name: "Your drive" });
const filesApi = (path, init) => new Request(`https://drive.test${FILES_ENDPOINT}${path}`, init);

test("the file routes answer each failure path with the table's words", async () => {
  // A deployment with no drive storage behind it: a fact about the deployment,
  // not about the caller, so the next step is not "try again".
  const unconfigured = await handleFilesRequest(filesApi(""), undefined, account, now);
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(await unconfigured.json(), { error: failureMessage("drive-not-configured") });

  const call = (request) => handleFilesRequest(request, createMemoryStore(), account, now);

  // A file this account does not have. The read path answers plain text.
  const preview = await call(filesApi("/preview?path=%2Fnope.txt"));
  assert.equal(preview.status, 404);
  assert.equal(await preview.text(), failureMessage("file-not-found"));

  // The same missing file on the delete path answers JSON, in the same words.
  const deleted = await call(
    filesApi("/delete", { method: "POST", body: JSON.stringify({ path: "/nope.txt" }) }),
  );
  assert.equal(deleted.status, 404);
  assert.deepEqual(await deleted.json(), { error: failureMessage("file-not-found") });

  // An upload with no name has no storage key, so nothing was written.
  const unnamed = await call(filesApi("/upload?path=%2F", { method: "POST", body: "x" }));
  assert.equal(unnamed.status, 400);
  assert.deepEqual(await unnamed.json(), { error: failureMessage("upload-needs-name") });

  // A body that is not a JSON object is the same refusal on both file routes
  // that read one, and on every account route: the array and the bare value
  // are the one failure path, not two.
  for (const body of ["[]", '"a string"', "null"]) {
    const refused = await call(filesApi("/delete", { method: "POST", body }));
    assert.equal(refused.status, 400, `${body} must be refused`);
    assert.deepEqual(await refused.json(), { error: failureMessage("json-object-needed") });
  }

  // A body that is not JSON at all is that same failure, not a second one:
  // the file route and the branch route refuse a mangled body in the same
  // words, so neither route carries its own sentence for it.
  for (const body of ["=", "a form", '{"path": ']) {
    const mangled = await call(filesApi("/delete", { method: "POST", body }));
    assert.equal(mangled.status, 400, `${body} must be refused`);
    assert.deepEqual(await mangled.json(), { error: failureMessage("json-object-needed") });
    // The restore route reads a body exactly as the delete route does.
    const restored = await call(filesApi("/restore", { method: "POST", body }));
    assert.equal(restored.status, 400, `${body} must be refused`);
    assert.deepEqual(await restored.json(), { error: failureMessage("json-object-needed") });
  }
});

test("the sign-in route refuses a body that is not a JSON object in the table's words", () => {
  for (const body of [undefined, "a string", 42, [], null]) {
    assert.deepEqual(
      readSigninRequest(body),
      { error: failureMessage("json-object-needed") },
      `${JSON.stringify(body) ?? "undefined"} must be refused`,
    );
  }
});

test("the branch route refuses a body that is not a JSON object in the table's words", async () => {
  const call = (body) =>
    handleBranchesRequest(
      new Request(`https://drive.test${BRANCHES_ENDPOINT}`, { method: "POST", body }),
      // The body is refused before the branches table is touched, so this only
      // has to be there for the route to get as far as reading the request.
      {},
      createMemoryStore(),
      account,
    );
  for (const body of ["[]", "null", "a form", "="]) {
    const refused = await call(body);
    assert.equal(refused.status, 400, `${body} must be refused`);
    assert.deepEqual(await refused.json(), { error: failureMessage("json-object-needed") });
  }
});

test("no module under src/ carries a second copy of a table sentence", () => {
  // The other half of the same rule, and the one that catches the drift the
  // route assertions above cannot see: the words live in src/messages.js, so
  // every other module under src/ reaches them through failureMessage(key).
  // The whole tree is read, not just the top of it, and every sentence is
  // looked for in the file text rather than in the code the parser can see: a
  // sentence pasted into a handler reads the same to the next person whether
  // it is code or a comment, and a table sentence quoted in a comment under
  // src/ is the drift this exists to stop.
  const src = new URL("../src/", import.meta.url);
  const modules = readdirSync(src, { recursive: true })
    .filter((name) => name.endsWith(".js") && !name.split("/").includes("messages.js"))
    .map((name) => [name, readFileSync(new URL(name, src), "utf8")]);
  for (const [key, entry] of Object.entries(FAILURE_MESSAGES)) {
    for (const sentence of [entry.what, entry.next]) {
      for (const [name, text] of modules) {
        assert.ok(
          !text.includes(sentence),
          `${name} carries its own copy of the ${key} words: "${sentence}"`,
        );
      }
    }
  }
});
