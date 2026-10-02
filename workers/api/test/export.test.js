// GET /v1/export: the signed-in account's own data, never another
// account's. Read-only; no secret is returned.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import "urlpattern-polyfill";
import { applyMigrations, d1Over } from "../../../test/d1-sqlite.mjs";
import { createD1DeviceSigninStore } from "../src/device-signin.js";
import { dispatch } from "../src/index.js";
import { createMemoryStore } from "../src/keystore.js";

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
      /** db.batch (workers/api/src/db.js) hands over prepared, bound
       * statements; d1Over's `_exec` re-runs one against SQLite. */
      /** @param {Array<{_exec: () => Promise<unknown>}>} stmts */
      batch(stmts) {
        return stmts.map((statement) => statement._exec());
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

  // Each account mints one key (device/agent) — the memory store holds
  // them locally keyed by account id, and the export reads them via
  // store.listKeys(account).
  await store.mintKey(accountA, { kind: "agent", name: "tool-a" });
  await store.mintKey(accountB, { kind: "device", name: "tool-b" });

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

  // No secret value appears in either answer (keys are never returned raw).
  assert.equal(text.includes("secret"), false, "no secret leaks into the export");
  assert.equal(bText.includes("secret"), false, "no secret leaks into the export");
});

test("GET /v1/export is an account route gated by auth:account", async () => {
  const { routes } = await import("../src/routes.js");
  const route = routes.find((r) => r.path === "/v1/export");
  assert.ok(route, "/v1/export must be registered");
  assert.equal(route.method, "GET");
  assert.equal(route.auth, "account", "export is account-gated");
});
