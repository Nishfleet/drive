// GET /v1/export: the signed-in account's own data, never another
// account's. Read-only; no secret is returned.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import "urlpattern-polyfill";
import { createMemoryStore } from "../src/keystore.js";
import { createD1DeviceSigninStore } from "../src/device-signin.js";
import { dispatch } from "../src/index.js";
import { applyMigrations, d1Over } from "../../../test/d1-sqlite.mjs";

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
 * @param {DatabaseSync} sqlite
 */
function exportD1(sqlite) {
  applyMigrations(sqlite);
  const inner = d1Over(sqlite);
  return {
    ...inner,
    /** db.batch in db.js passes prepared+bound statements; _exec
     * (d1Over's prepared-statement method) re-runs them against SQLite. */
    batch(stmts) {
      return stmts.map((s) => s._exec());
    },
  };
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
  db.prepare("INSERT INTO file_index (account_id, path, name, parent, size_bytes, modified_at, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind("acct-a", "/notes.txt", "notes.txt", "/", 100, "2026-09-30T10:00:00Z", "2026-09-30T10:00:00Z").run();
  db.prepare("INSERT INTO file_index (account_id, path, name, parent, size_bytes, modified_at, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind("acct-b", "/photo.jpg", "photo.jpg", "/", 5000, "2026-09-30T11:00:00Z", "2026-09-30T11:00:00Z").run();
  db.prepare("INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind("acct-a", "f1", "/notes.txt", 100, 1700000000000, null).run();

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

  // B's rows must not appear anywhere in the document.
  const text = JSON.stringify(body);
  assert.equal(text.includes("acct-b"), false, "the other account's id must not leak");
  assert.equal(text.includes("photo.jpg"), false, "the other account's file must not leak");
  assert.equal(text.includes("tool-b"), false, "the other account's key must not leak");

  // No secret value appears in the answer (keys are never returned raw).
  assert.equal(text.includes("secret"), false, "no secret leaks into the export");
});

test("GET /v1/export is an account route gated by auth:account", async () => {
  const { routes } = await import("../src/routes.js");
  const route = routes.find((r) => r.path === "/v1/export");
  assert.ok(route, "/v1/export must be registered");
  assert.equal(route.method, "GET");
  assert.equal(route.auth, "account", "export is account-gated");
});
