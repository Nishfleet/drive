// GET /v1/export: the signed-in account's own data, never another
// account's. Read-only; no secret is returned.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import "urlpattern-polyfill";
import { createD1DeviceSigninStore } from "../../../core/device-signin.js";
import { createMemoryStore } from "../../../core/keystore.js";
import { applyMigrations, d1Over } from "../../../test/d1-sqlite.mjs";
import { sqlitePlaceholders } from "../../../test/harness.mjs";
import { EXPORT_ROW_CAP } from "../src/export-routes.js";
import { dispatch } from "../src/index.js";

// A clock the test owns, so a device token can be pushed past its TTL
// without sleeping; the store reads `now` from the context it is given.
/** @param {number} [startMs] @returns {{now: () => number, advance: (seconds: number) => void}} */
function fixedClock(startMs = Date.parse("2026-09-30T12:00:00Z")) {
  let now = startMs;
  return {
    now: () => now,
    /** @param {number} seconds */
    advance(seconds) {
      now += seconds * 1000;
    },
  };
}

/** A D1 adapter over a real SQLite database with every drive migration,
 * plus a batch shim so the device-signin store's transaction path
 * (createD1DeviceSigninStore → db.batch) works.
 *
 * `d1Over` (test/d1-sqlite.mjs) speaks the D1 interface at runtime and adds
 * the meter's own table views and `insertVersion`; the runtime type of
 * D1's `declare abstract class` does not carry those, so the adapter is
 * handed to the `D1Database` interface through one documented cast here,
 * the way test/harness.mjs `createTestD1` does. Everything the export route
 * sends — `prepare`, `bind`, `all`, `batch` — is the real thing.
 * @param {DatabaseSync} sqlite
 * @returns {D1Database}
 */
function exportD1(sqlite) {
  applyMigrations(sqlite);
  const inner = d1Over(sqlite);
  return /** @type {D1Database} */ (
    /** @type {unknown} */ ({
      ...inner,
      /** db.batch (core/db.js) hands over prepared, bound
       * statements; d1Over's `_exec` re-runs one against SQLite. D1's batch
       * answers `Promise<D1Result[]>`, so the array of promises is awaited
       * here rather than handed back unresolved. */
      /** @param {Array<{_exec: () => Promise<unknown>}>} stmts */
      async batch(stmts) {
        return Promise.all(stmts.map((statement) => statement._exec()));
      },
    })
  );
}

test("GET /v1/export answers 401 without a signed-in account", async () => {
  const db = exportD1(new DatabaseSync(":memory:"));
  const signin = createD1DeviceSigninStore(db);
  const store = createMemoryStore({ signin });
  const clock = fixedClock();
  const ctx = { env: {}, db, store, now: clock.now };
  const res = await dispatch(new Request("https://api.test/v1/export"), ctx);
  assert.equal(res.status, 401, "anonymous requests must be refused by the account gate");
});

test("GET /v1/export returns only the caller's account data", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = exportD1(sqlite);
  const signin = createD1DeviceSigninStore(db);
  const store = createMemoryStore({ signin });
  const clock = fixedClock();
  const ctx = { env: {}, db, store, now: clock.now };

  // Two accounts go through the device flow independently.
  const accountA = { id: "acct-a", name: "A", email: "a@x.com" };
  const accountB = { id: "acct-b", name: "B", email: "b@x.com" };
  // Seed device tokens for each account via the device flow.
  /** @param {{id: string, name: string, email: string}} account */
  async function mint(account) {
    const code = await store.requestDeviceCode({ name: account.name });
    await store.approveDeviceCode(code.userCode, account);
    const result = await store.pollDeviceCode(code.deviceCode);
    assert.equal(result.status, "approved", `poll for ${account.id} must mint a token`);
    return result.deviceToken;
  }
  const tokenA = await mint(accountA);
  const tokenB = await mint(accountB);

  // Each account mints one key (device/agent). The mint's access key id and
  // secret are the material that must never reach the export, so they are held
  // here and checked for by value below rather than by the word "secret",
  // which a leak would not contain.
  const mintedA = await store.mintKey(accountA, { kind: "agent", name: "tool-a" });
  const mintedB = await store.mintKey(accountB, { kind: "device", name: "tool-b" });

  // Seed file index rows for both accounts and version rows for A only.
  db.prepare(
    "INSERT INTO file_index (account_id, path, name, parent, size_bytes, modified_at, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(
      "acct-a",
      "/notes.txt",
      "notes.txt",
      "/",
      100,
      "2026-09-30T10:00:00Z",
      "2026-09-30T10:00:00Z",
    )
    .run();
  db.prepare(
    "INSERT INTO file_index (account_id, path, name, parent, size_bytes, modified_at, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(
      "acct-b",
      "/photo.jpg",
      "photo.jpg",
      "/",
      5000,
      "2026-09-30T11:00:00Z",
      "2026-09-30T11:00:00Z",
    )
    .run();
  db.prepare(
    "INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind("acct-a", "f1", "/notes.txt", 100, 1700000000000, null)
    .run();

  // Export as account A: must not leak B's rows.
  const res = await dispatch(
    new Request("https://api.test/v1/export", {
      headers: { authorization: `Bearer ${tokenA}` },
    }),
    ctx,
  );
  assert.equal(res.status, 200, "signed-in export must answer 200");
  const body = await res.json();

  assert.equal(body.account.id, "acct-a", "account id is the caller's");
  assert.equal(body.keys.length, 1, "only the caller's keys");
  assert.equal(body.keys[0].name, "tool-a", "the caller's key name");
  assert.equal(body.files.length, 1, "only the caller's file index rows");
  assert.equal(body.files[0].path, "/notes.txt");
  assert.equal(body.versions.length, 1, "only the caller's version rows");
  assert.equal(body.versions[0].b2FileId, "f1");

  // B's rows must not appear anywhere in A's document.
  const text = JSON.stringify(body);
  assert.equal(text.includes("acct-b"), false, "the other account's id must not leak");
  assert.equal(text.includes("photo.jpg"), false, "the other account's file must not leak");
  assert.equal(text.includes("tool-b"), false, "the other account's key must not leak");
  assert.equal(text.includes("notes.txt"), true, "the caller's own file must be in it");

  // The same rule from the other side: B exports B's row and A's never
  // appears, so the filter is on the caller's account and not on which
  // account was seeded first.
  const asB = await dispatch(
    new Request("https://api.test/v1/export", {
      headers: { authorization: `Bearer ${tokenB}` },
    }),
    ctx,
  );
  assert.equal(asB.status, 200, "B's export must answer 200 too");
  const bBody = await asB.json();
  assert.equal(bBody.account.id, "acct-b", "B exports its own account row");
  assert.equal(bBody.files.length, 1, "B sees only its own file index row");
  assert.equal(bBody.files[0].path, "/photo.jpg");
  assert.equal(bBody.keys.length, 1, "B sees only its own key");
  assert.equal(bBody.keys[0].name, "tool-b");
  assert.equal(bBody.versions.length, 0, "B has no version rows of its own");
  const bText = JSON.stringify(bBody);
  assert.equal(bText.includes("acct-a"), false, "A's account must not leak into B's export");
  assert.equal(bText.includes("notes.txt"), false, "A's file must not leak into B's export");
  assert.equal(bText.includes("tool-a"), false, "A's key must not leak into B's export");

  // No key material appears in either answer: not the secret, not the access
  // key id, and not the store's own hash of the secret. Checked by value,
  // because a leak is a value, not a field name.
  for (const [label, document_text] of [
    ["A", text],
    ["B", bText],
  ]) {
    for (const material of [
      mintedA.secret,
      mintedA.accessKeyId,
      mintedB.secret,
      mintedB.accessKeyId,
    ]) {
      assert.equal(
        document_text.includes(material),
        false,
        `${label}'s export must not carry key material ${material.slice(0, 4)}…`,
      );
    }
    for (const field of ["secret", "secretHash", "accessKeyId", "sessionToken"]) {
      assert.equal(
        document_text.includes(`"${field}"`),
        false,
        `${label}'s export must not carry the ${field} field`,
      );
    }
  }
});

test("GET /v1/export is an account route gated by auth:account", async () => {
  const { routes } = await import("../src/routes.js");
  const route = routes.find((r) => r.path === "/v1/export");
  assert.ok(route, "/v1/export must be registered");
  assert.equal(route.method, "GET");
  assert.equal(route.auth, "account", "export is account-gated");
});

test("a page that stops at the cap says so, and the cursor continues it", async () => {
  // A Worker response cannot hold a drive's whole file history, so the export
  // is a bounded page. A person told "you have no files" when the page simply
  // stopped would keep a data loss they never saw, so a short page must carry
  // `complete: false` and a cursor, and the cursor must pick up exactly where
  // the first page left off with no gap and no repeat.
  const sqlite = new DatabaseSync(":memory:");
  const db = exportD1(sqlite);
  const clock = fixedClock();
  const store = createMemoryStore();
  const account = { id: "acct-big", name: "Big", email: "big@x.com" };
  const ctx = { env: {}, db, store, now: clock.now };

  const code = await store.requestDeviceCode({ name: account.name });
  await store.approveDeviceCode(code.userCode, account);
  const polled = await store.pollDeviceCode(code.deviceCode);
  const token = polled.status === "approved" ? polled.deviceToken : "";

  // One more file than a page holds, so the first page must stop short.
  const total = EXPORT_ROW_CAP + 1;
  const insertSql =
    "INSERT INTO file_index (account_id, path, name, parent, size_bytes) VALUES (?1, ?2, ?3, '/', ?4)";
  const insert = sqlite.prepare(sqlitePlaceholders(insertSql));
  for (let i = 0; i < total; i++) {
    // Zero-padded so the path order is the same as the numeric order, which is
    // what the keyset cursor walks.
    insert.run("acct-big", `/f${String(i).padStart(6, "0")}.txt`, `f${i}.txt`, i);
  }
  // One version row that fits in the first page. It must appear in the merged
  // export exactly once: a later page (driven by the file cursor) must not
  // re-read the version list and duplicate it, which is the bug a live run of
  // `drive export` found against a hand-written stand-in on 2026-10-02.
  const versionSql =
    "INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)";
  sqlite
    .prepare(sqlitePlaceholders(versionSql))
    .run("acct-big", "v1", "/f000000.txt", 1, 1700000000000);

  const first = await dispatch(
    new Request("https://api.test/v1/export", {
      headers: { authorization: `Bearer ${token}` },
    }),
    ctx,
  );
  const firstBody = await first.json();
  assert.equal(firstBody.files.length, EXPORT_ROW_CAP, "a page carries the cap, no more");
  assert.equal(firstBody.complete, false, "a short page must not claim to be the whole drive");
  assert.equal(
    typeof firstBody.next.fileCursor,
    "string",
    "a short page carries the cursor that continues it",
  );

  // Walking the cursor must reach the one row the first page could not hold,
  // and must not repeat a row the first page already carried.
  /** @param {any} body @returns {{files: Array<{path: string}>, versions: Array<{b2FileId: string}>, complete: boolean, next: {fileCursor: string|null}}} */
  const page = (body) => body;
  const seen = new Set(firstBody.files.map((/** @type {{path: string}} */ file) => file.path));
  const seenVersions = new Set(
    firstBody.versions.map((/** @type {{b2FileId: string}} */ version) => version.b2FileId),
  );
  let cursor = firstBody.next.fileCursor;
  let pages = 1;
  let last = firstBody;
  while (cursor !== null && pages < 10) {
    const next = await dispatch(
      new Request(`https://api.test/v1/export?fileCursor=${encodeURIComponent(cursor)}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      ctx,
    );
    last = page(await next.json());
    for (const file of last.files) {
      assert.equal(seen.has(file.path), false, `${file.path} was exported twice`);
      seen.add(file.path);
    }
    for (const version of last.versions) {
      assert.equal(
        seenVersions.has(version.b2FileId),
        false,
        `version ${version.b2FileId} was exported twice`,
      );
      seenVersions.add(version.b2FileId);
    }
    cursor = last.next.fileCursor;
    pages += 1;
  }
  assert.equal(seen.size, total, "walking the cursor reaches every file, once each");
  assert.equal(
    seenVersions.size,
    1,
    "the version list is delivered once, not re-read by the file-cursor pages",
  );
  assert.equal(last.complete, true, "the last page carries the whole drive");
});
