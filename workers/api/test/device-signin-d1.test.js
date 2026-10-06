import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import "urlpattern-polyfill";
import {
  createD1DeviceSigninStore,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_TOKEN_TTL_SECONDS,
} from "../../../core/device-signin.js";
import { ACCOUNT, makeFakeD1 } from "./device-signin-d1-helpers.js";

/** @typedef {ReturnType<typeof makeFakeD1>} FakeD1 */

test("a code started on one instance is approved and polled on fresh ones (drive#136 a)", async () => {
  const db = makeFakeD1();
  const first = createD1DeviceSigninStore(db, { now: () => 0 });

  const code = await first.requestDeviceCode({ name: "Nish's MacBook" });
  assert.match(code.userCode, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.equal(code.expiresIn, DEVICE_CODE_TTL_SECONDS);

  // Nothing in memory holds the code: a brand-new instance over the same
  // database sees it, exactly as a new Worker isolate would.
  const second = createD1DeviceSigninStore(db, { now: () => 0 });
  assert.deepEqual(await second.pollDeviceCode(code.deviceCode), { status: "pending" });
  assert.deepEqual(await second.approveDeviceCode(code.userCode, ACCOUNT), {
    accountId: ACCOUNT.id,
    name: ACCOUNT.name,
  });

  const token = await second.pollDeviceCode(code.deviceCode);
  assert.equal(token.status, "approved");
  assert.equal(token.account.id, ACCOUNT.id);

  // A third instance resolves the token it never minted in memory.
  const third = createD1DeviceSigninStore(db, { now: () => 0 });
  assert.deepEqual(await third.accountForDeviceToken(token.deviceToken), ACCOUNT);

  // The secrets are stored only as digests: no column holds the device code or
  // the token the caller presented.
  assert.equal(db.codes.has(code.deviceCode), false);
  assert.equal(db.tokens.has(token.deviceToken), false);
});

test("the poll mints a token exactly once, across instances", async () => {
  const db = makeFakeD1();
  const store = createD1DeviceSigninStore(db, { now: () => 0 });
  const code = await store.requestDeviceCode({ name: "laptop" });
  await store.approveDeviceCode(code.userCode, ACCOUNT);

  const firstPoll = await store.pollDeviceCode(code.deviceCode);
  assert.equal(firstPoll.status, "approved");
  const secondPoll = await createD1DeviceSigninStore(db, { now: () => 0 }).pollDeviceCode(
    code.deviceCode,
  );
  assert.deepEqual(secondPoll, { status: "expired" });
});

test("an expired code is never approved or polled to a token", async () => {
  const db = makeFakeD1();
  let nowMs = 0;
  const store = createD1DeviceSigninStore(db, { now: () => nowMs });
  const code = await store.requestDeviceCode({ name: "laptop" });
  nowMs += (DEVICE_CODE_TTL_SECONDS + 1) * 1000;

  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "expired" });
  assert.deepEqual(await store.approveDeviceCode(code.userCode, ACCOUNT), {
    error: "expired-code",
  });
});

test("an unknown code is refused and a bad user code attaches nothing", async () => {
  const db = makeFakeD1();
  const store = createD1DeviceSigninStore(db, { now: () => 0 });
  assert.deepEqual(await store.pollDeviceCode("dev_never-issued"), { status: "unknown" });
  assert.deepEqual(await store.approveDeviceCode("ZZZZ-ZZZZ", ACCOUNT), {
    error: "unknown-code",
  });
  assert.equal(await store.accountForDeviceToken("dtok_forged"), null);
});

// ---- the token window over D1 (drive#176, kept through drive#136) ----
//
// The expiry and the revocation used to live in a per-isolate Map. They are now
// columns on the row a poll wrote, so these prove the same three answers the
// in-memory store gives, read from a database by an instance that minted
// nothing: past the window is no account, a revoke is a second write that
// reports the first, and the sweep drops exactly the dead rows.

// Walks the whole flow over D1 and hands back the token a fresh instance can
// resolve, which is the point: nothing below depends on module state.
/**
 * @param {FakeD1} db
 * @param {() => number} now
 */
async function mintOverD1(db, now) {
  const store = createD1DeviceSigninStore(db, { now });
  const code = await store.requestDeviceCode({ name: "laptop" });
  await store.approveDeviceCode(code.userCode, ACCOUNT);
  const polled = await createD1DeviceSigninStore(db, { now }).pollDeviceCode(code.deviceCode);
  assert.equal(polled.status, "approved");
  if (polled.status !== "approved") {
    throw new Error("expected an approved poll");
  }
  return polled.deviceToken;
}

test("a device token past its TTL resolves to no account over D1", async () => {
  let nowMs = 0;
  const db = makeFakeD1();
  const deviceToken = await mintOverD1(db, () => nowMs);
  // An instance that never minted it still resolves it while it is live.
  assert.deepEqual(
    await createD1DeviceSigninStore(db, { now: () => nowMs }).accountForDeviceToken(deviceToken),
    ACCOUNT,
  );

  nowMs += (DEVICE_TOKEN_TTL_SECONDS + 1) * 1000;
  assert.equal(
    await createD1DeviceSigninStore(db, { now: () => nowMs }).accountForDeviceToken(deviceToken),
    null,
    "an expired token is the same answer as one that was never minted",
  );
  // The row is still on disk: refusing it is the lookup's job, not a sweep's.
  assert.equal(db.tokens.size, 1);
});

test("a revoke over D1 is one write that reports the first, and the token stops resolving", async () => {
  const nowMs = 0;
  const db = makeFakeD1();
  const deviceToken = await mintOverD1(db, () => nowMs);

  const first = /** @type {{revoked: true, expiresAt: number, revokedAt: number}} */ (
    /** @type {unknown} */ (
      await createD1DeviceSigninStore(db, { now: () => nowMs }).revokeDeviceToken(deviceToken)
    )
  );
  assert.equal(first.revoked, true);
  assert.equal(first.revokedAt, 0, "revoked at the clock the caller gave");
  assert.equal(first.expiresAt, DEVICE_TOKEN_TTL_SECONDS);

  // Revoking again changes nothing and reports what the first did, not a
  // second kill at a later instant.
  assert.deepEqual(
    await createD1DeviceSigninStore(db, { now: () => nowMs }).revokeDeviceToken(deviceToken),
    first,
  );
  assert.equal(
    await createD1DeviceSigninStore(db, { now: () => nowMs }).accountForDeviceToken(deviceToken),
    null,
  );
  // A token the database never held is a named refusal, not a false promise.
  assert.deepEqual(
    await createD1DeviceSigninStore(db, { now: () => nowMs }).revokeDeviceToken("dtok_forged"),
    { error: "not-found" },
  );
});

test("the D1 sweep drops the expired and the revoked token rows and leaves the live one", async () => {
  let nowMs = 0;
  const db = makeFakeD1();
  const expiredToken = await mintOverD1(db, () => nowMs);
  const revokedToken = await mintOverD1(db, () => nowMs);
  await createD1DeviceSigninStore(db, { now: () => nowMs }).revokeDeviceToken(revokedToken);

  nowMs += (DEVICE_TOKEN_TTL_SECONDS + 1) * 1000;
  const liveToken = await mintOverD1(db, () => nowMs);

  assert.equal(await createD1DeviceSigninStore(db, { now: () => nowMs }).sweepDeviceTokens(), 2);
  assert.equal(db.tokens.size, 1, "only the live row is left");
  assert.deepEqual(
    await createD1DeviceSigninStore(db, { now: () => nowMs }).accountForDeviceToken(liveToken),
    ACCOUNT,
  );
  assert.equal(
    await createD1DeviceSigninStore(db, { now: () => nowMs }).accountForDeviceToken(expiredToken),
    null,
  );
});

// The store's SQL names a table and a set of columns; the migration is what
// creates them. Nothing in a Worker runs the migration (the api Worker has no
// deploy config in this tree, drive#168), so this is the check that the SQL the
// Worker prepares and the DDL the database gets cannot drift apart: a column
// renamed in the migration, or a table the migration never creates, fails here.
test("the migration creates every table and column the store's SQL names", () => {
  const ddl = readFileSync(
    new URL("../../../migrations/drive/0007_device_codes.sql", import.meta.url),
    "utf8",
  );
  /** @param {string} table */
  const columnsOf = (table) => {
    const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\((.*?)\\n\\);`, "s").exec(
      ddl,
    )?.[1];
    assert.ok(body, `the migration never creates ${table}`);
    // The CHECK list on `status` holds commas of its own, so each line is read
    // from its start rather than split on them.
    return body
      .split("\n")
      .map((line) => /^\s{2}([a-z_]+)\s/.exec(line)?.[1])
      .filter((name) => name !== undefined);
  };

  assert.deepEqual(columnsOf("device_codes"), [
    "device_code_hash",
    "user_code",
    "name",
    "status",
    "account_id",
    "account_name",
    "account_email",
    "created_at",
    "expires_at",
    "consumed_by",
  ]);
  assert.deepEqual(columnsOf("device_tokens"), [
    "token_hash",
    "account_id",
    "account_name",
    "account_email",
    "created_at",
    "expires_at",
    "revoked_at",
  ]);
  // The sweep the code route runs on every request is a full scan without the
  // first index, and the token sweep is a full scan without the second.
  assert.match(
    ddl,
    /CREATE INDEX IF NOT EXISTS device_codes_expires_at ON device_codes \(expires_at\)/,
  );
  assert.match(
    ddl,
    /CREATE INDEX IF NOT EXISTS device_tokens_expires_at ON device_tokens \(expires_at\)/,
  );
});
