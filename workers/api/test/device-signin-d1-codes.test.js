import assert from "node:assert/strict";
import { test } from "node:test";
import "urlpattern-polyfill";
import { sha256Hex } from "../../../core/db.js";
import {
  createD1DeviceSigninStore,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_TOKEN_TTL_SECONDS,
} from "../../../core/device-signin.js";
import { createMemoryStore } from "../../../core/keystore.js";
import { createTestD1 } from "../../../test/harness.mjs";
import { dispatch } from "../src/index.js";
import { ACCOUNT, accountsFor, makeFakeD1, SESSION_COOKIE } from "./device-signin-d1-helpers.js";

// Consuming a code and writing its token are one transaction, so a failure
// between them cannot lose a sign-in a person already approved: the row is
// rolled back to `approved` and the next poll mints the token for real. Before
// this, the two statements were separate and the code was spent either way.
// Two polls of the same approved code at once (two terminals, or one CLI
// retrying): the conditional consume stamps the winner's nonce and the token
// insert is guarded by that nonce, so exactly one token row is written and the
// loser answers `expired` rather than leaving a credential behind that no
// caller holds. A plain batch would run both inserts, because a batch cannot
// branch on what its first statement changed.
test("two polls of one approved code mint exactly one token row", async () => {
  const db = makeFakeD1();
  const store = createD1DeviceSigninStore(db, { now: () => 0 });
  const code = await store.requestDeviceCode({ name: "laptop" });
  await store.approveDeviceCode(code.userCode, ACCOUNT);

  const [first, second] = await Promise.all([
    store.pollDeviceCode(code.deviceCode),
    createD1DeviceSigninStore(db, { now: () => 0 }).pollDeviceCode(code.deviceCode),
  ]);
  const winners = [first, second].filter((result) => result.status === "approved");
  assert.equal(winners.length, 1, "exactly one poll holds the code");
  assert.equal(db.tokens.size, 1, "the loser inserted no token row");
  assert.equal(
    winners[0].status === "approved" &&
      (await store.accountForDeviceToken(winners[0].deviceToken)) !== null,
    true,
    "the token that was handed out resolves",
  );
  // And the loser is `expired`, not a usable answer.
  const losers = [first, second].filter((result) => result.status !== "approved");
  assert.equal(losers.length, 1);
  assert.deepEqual(losers[0], { status: "expired" });
});

// A code that already names one account is spent, so the idempotent "approving
// twice" path cannot hand somebody else's approved sign-in to a second pair of
// hands: a second signed-in user who learns the user code is refused.
test("a second person cannot approve a code that already names an account", async () => {
  const db = makeFakeD1();
  const store = createD1DeviceSigninStore(db, { now: () => 0 });
  const code = await store.requestDeviceCode({ name: "laptop" });
  await store.approveDeviceCode(code.userCode, ACCOUNT);

  const intruder = { id: "acct_2", name: "Someone else", email: "other@example.com" };
  assert.deepEqual(await store.approveDeviceCode(code.userCode, intruder), {
    error: "approved-code",
  });
  // The code still names its first approver, and the poll still mints for them.
  assert.deepEqual(await store.approveDeviceCode(code.userCode, ACCOUNT), {
    error: "approved-code",
  });
  const polled = await store.pollDeviceCode(code.deviceCode);
  assert.equal(polled.status, "approved");
  assert.equal(polled.account.id, ACCOUNT.id);
});

// The same rule on the stand-in the tests and a database-less deployment use:
// the two stores must answer the same question the same way.
test("the in-memory store refuses an already approved code too", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const code = await store.requestDeviceCode({ name: "laptop" });
  await store.approveDeviceCode(code.userCode, ACCOUNT);
  assert.deepEqual(
    await store.approveDeviceCode(code.userCode, { id: "acct_2", name: "Someone else", email: "" }),
    { error: "approved-code" },
  );
});

// The migrations are data, and data is not rolled back, so the D1 rule is that
// a migration PR proves its new READ and its new WRITE path against the real
// schema rather than a stand-in that agrees with itself. This walks the real
// file in `migrations/drive/0007_device_codes.sql` over a real SQLite engine
// (test/harness.mjs, the same D1-shaped adapter the site's own tests use), so
// the SQL the Worker prepares runs against the DDL the deploy applies.
test("the store's read and write paths run against the real migration", async () => {
  const db = createTestD1({
    migrations: ["drive/0007_device_codes.sql", "drive/0010_accounts_devices.sql"],
  });
  const sqlite = db.sqlite;

  // A code one instance starts, another instance approves and consumes: nothing
  // here is in memory.
  const first = createD1DeviceSigninStore(db, { now: () => 0 });
  const code = await first.requestDeviceCode({ name: "laptop" });
  const second = createD1DeviceSigninStore(db, { now: () => 0 });
  assert.deepEqual(await second.pollDeviceCode(code.deviceCode), { status: "pending" });
  assert.deepEqual(await second.approveDeviceCode(code.userCode, ACCOUNT), {
    accountId: ACCOUNT.id,
    name: ACCOUNT.name,
  });
  const minted = await second.pollDeviceCode(code.deviceCode);
  assert.equal(minted.status, "approved");
  if (minted.status !== "approved") {
    throw new Error("expected an approved poll");
  }
  assert.equal(minted.account.id, ACCOUNT.id);

  // The rows are real: the token is on disk as a digest with the window the
  // schema declares, and the code is spent.
  const [tokenRow] = sqlite.prepare("SELECT * FROM device_tokens").all();
  assert.equal(tokenRow.expires_at, DEVICE_TOKEN_TTL_SECONDS);
  assert.equal(tokenRow.revoked_at, null);
  assert.equal(tokenRow.token_hash, await sha256Hex(minted.deviceToken));
  const [codeRow] = sqlite.prepare("SELECT * FROM device_codes").all();
  assert.equal(codeRow.status, "used");

  // The write path for the window: a revoke lands on the row and the read path
  // refuses the token from then on, and the sweep drops the spent code row.
  const revoked = /** @type {{revoked: true, expiresAt: number, revokedAt: number}} */ (
    /** @type {unknown} */ (await second.revokeDeviceToken(minted.deviceToken))
  );
  assert.equal(revoked.revoked, true, "the token can be revoked");
  assert.equal(await second.accountForDeviceToken(minted.deviceToken), null);
  assert.equal(await second.sweepDeviceTokens(), 1, "the revoked token row went");
});

test("a token write that fails leaves the code approved, so no approved sign-in is lost", async () => {
  const nowMs = 0;
  const db = makeFakeD1({ failOn: "INSERT INTO device_tokens" });
  const store = createD1DeviceSigninStore(db, { now: () => nowMs });
  const code = await store.requestDeviceCode({ name: "laptop" });
  await store.approveDeviceCode(code.userCode, ACCOUNT);

  await assert.rejects(
    () => createD1DeviceSigninStore(db, { now: () => nowMs }).pollDeviceCode(code.deviceCode),
    /was made to fail/,
  );
  assert.equal(db.codes.size, 1, "the rolled-back transaction left no token row");
  assert.equal(db.tokens.size, 0);
  // The code is not spent: the same approved code still mints its token.
  const minted = await createD1DeviceSigninStore(db, { now: () => nowMs }).pollDeviceCode(
    code.deviceCode,
  );
  assert.equal(minted.status, "approved");
  assert.equal(minted.account.id, ACCOUNT.id);
  assert.deepEqual(
    await createD1DeviceSigninStore(db, { now: () => nowMs }).accountForDeviceToken(
      minted.deviceToken,
    ),
    ACCOUNT,
  );
});

// A request that starts while the code is alive can finish after it dies. The
// expiry predicate is inside the write that changes the row, not only in the
// read before it, so the boundary is the database's to refuse.
test("a code that expires between the read and the write is never approved or consumed", async () => {
  let nowMs = 0;
  const clock = { now: () => nowMs };
  // The clock jumps past the TTL on the read the store makes first.
  const db = makeFakeD1({ onRead: () => (nowMs += (DEVICE_CODE_TTL_SECONDS + 1) * 1000) });
  const store = createD1DeviceSigninStore(db, clock);
  const code = await store.requestDeviceCode({ name: "laptop" });

  assert.deepEqual(await store.approveDeviceCode(code.userCode, ACCOUNT), {
    error: "expired-code",
  });
  const row = db.codes.values().next().value;
  assert.equal(row.status, "pending", "the write refused, so nothing was attached");

  // The same boundary on the poll: the consume predicate refuses and no token
  // row is left behind by the insert that follows it in the transaction.
  const live = makeFakeD1();
  const liveStore = createD1DeviceSigninStore(live, clock);
  const liveCode = await liveStore.requestDeviceCode({ name: "laptop" });
  await liveStore.approveDeviceCode(liveCode.userCode, ACCOUNT);
  nowMs += DEVICE_CODE_TTL_SECONDS * 1000 + 1;
  assert.deepEqual(await liveStore.pollDeviceCode(liveCode.deviceCode), { status: "expired" });
});

// `/v1/device/code` is public, so an unlimited version of it is a way to fill
// the table from anywhere. The sweep is what makes the row count bounded: every
// code request deletes the rows already past their TTL, in the same
// transaction as its own insert, and never its own row.
test("a code request sweeps the rows already past their TTL", async () => {
  let nowMs = 0;
  const db = makeFakeD1();
  const store = createD1DeviceSigninStore(db, { now: () => nowMs });
  const first = await store.requestDeviceCode({ name: "laptop" });
  const second = await store.requestDeviceCode({ name: "desktop" });
  assert.equal(db.codes.size, 2);

  nowMs += (DEVICE_CODE_TTL_SECONDS + 1) * 1000;
  const third = await createD1DeviceSigninStore(db, { now: () => nowMs }).requestDeviceCode({
    name: "phone",
  });
  assert.equal(db.codes.size, 1, "both dead rows went, the live one stayed");
  assert.equal([...db.codes.values()][0].user_code, third.userCode);

  // A dead row is dead everywhere: the instance that made it cannot poll it.
  assert.deepEqual(
    await createD1DeviceSigninStore(db, { now: () => nowMs }).pollDeviceCode(first.deviceCode),
    {
      status: "unknown",
    },
  );
  assert.deepEqual(
    await createD1DeviceSigninStore(db, { now: () => nowMs }).pollDeviceCode(second.deviceCode),
    {
      status: "unknown",
    },
  );
});

// The two public device routes are the CLI's only credential-free calls, and
// each one costs the database a write or a read, so each spends its own edge
// limit before it reaches D1 (drive#136). The row count is the proof that a
// refused call costs nothing: an unlimited version of this is a way to fill
// the table from anywhere.
test("the public device routes are rate limited before they reach the database", async () => {
  const db = makeFakeD1();
  const signin = createD1DeviceSigninStore(db, { now: () => 0 });
  /** @param {boolean} success */
  const limiter = (success) => ({ limit: async () => ({ success }) });
  /** @param {Record<string, unknown>} env */
  const ctxWith = (env) => ({
    env,
    db,
    store: createMemoryStore({ signin }),
    // No session resolves here, so a public-route request stays public.
    accounts: accountsFor("sess_never_minted"),
    account: null,
    now: () => 0,
  });
  const allowed = {
    DEVICE_RATE_LIMITER: limiter(true),
    DEVICE_GLOBAL_RATE_LIMITER: limiter(true),
  };
  const startCode = () =>
    dispatch(
      new Request("https://api.test/v1/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "laptop" }),
      }),
      ctxWith(allowed),
    );

  const deniedCode = await dispatch(
    new Request("https://api.test/v1/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "laptop" }),
    }),
    ctxWith({ ...allowed, DEVICE_RATE_LIMITER: limiter(false) }),
  );
  assert.equal(deniedCode.status, 429);
  assert.equal(deniedCode.headers.get("retry-after"), "60");
  assert.equal(db.codes.size, 0, "the refused code request wrote no row");

  const missingCode = await dispatch(
    new Request("https://api.test/v1/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "laptop" }),
    }),
    ctxWith({ DEVICE_GLOBAL_RATE_LIMITER: limiter(true) }),
  );
  assert.equal(missingCode.status, 503, "no binding is a closed door, not an open one");
  assert.equal(db.codes.size, 0);

  const deniedPoll = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: "dev_nothing" }),
    }),
    ctxWith({ ...allowed, DEVICE_GLOBAL_RATE_LIMITER: limiter(false) }),
  );
  assert.equal(deniedPoll.status, 429);
  assert.equal(db.tokens.size, 0, "the refused poll minted nothing");

  // The approve page's GET is limited in its own bucket too (drive#518
  // review): it names a pending code's device and time, so an unlimited page
  // is an existence oracle for codes a phishing page is cycling.
  const deniedPage = await dispatch(
    new Request("https://api.test/v1/device/approve?user_code=ABCD1234"),
    ctxWith({ ...allowed, DEVICE_RATE_LIMITER: limiter(false) }),
  );
  assert.equal(deniedPage.status, 429);

  // With the bindings present the same calls run: the limit is on volume, not
  // on the flow.
  const started = await startCode();
  assert.equal(started.status, 200);
  assert.equal(db.codes.size, 1);
});

// The route calls the store, so the D1 store's asynchrony is the request
// path's too: without the `await` the unknown/expired branch would render the
// success page while writing nothing. This walks the real dispatcher with the
// D1-backed store behind it.
test("the approve route leaves an unknown or expired code unapproved over D1", async () => {
  const db = makeFakeD1();
  let nowMs = 0;
  const store = createMemoryStore({
    signin: createD1DeviceSigninStore(db, { now: () => nowMs }),
  });
  const accounts = accountsFor("sess_ok");
  const ctx = {
    env: {
      DEVICE_RATE_LIMITER: { limit: async () => ({ success: true }) },
      DEVICE_GLOBAL_RATE_LIMITER: { limit: async () => ({ success: true }) },
    },
    db,
    store,
    accounts,
    account: null,
    now: () => nowMs,
  };
  /** @param {string} userCode */
  const approve = (userCode) =>
    dispatch(
      new Request("https://api.test/v1/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${SESSION_COOKIE}=sess_ok`,
        },
        body: `user_code=${encodeURIComponent(userCode)}`,
      }),
      ctx,
    );

  const unknownPage = await approve("ZZZZ-ZZZZ");
  assert.equal(unknownPage.status, 200);
  assert.doesNotMatch(await unknownPage.text(), /Approved\. Return to the terminal/);

  const code = await store.requestDeviceCode({ name: "laptop" });
  nowMs += (DEVICE_CODE_TTL_SECONDS + 1) * 1000;
  const expiredPage = await approve(code.userCode);
  assert.equal(expiredPage.status, 200);
  const expiredBody = await expiredPage.text();
  assert.match(expiredBody, /expired/);
  assert.doesNotMatch(expiredBody, /Approved\. Return to the terminal/);
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "expired" });
});

// The DEVICE code route is the same story: the D1 store's `requestDeviceCode`
// is a Promise, so an unawaited call answers `{}` with an undefined user code
// and the CLI has nothing to show. This walks the real dispatcher with the
// D1-backed store behind it, then starts the code on a second store instance
// (the way a second Worker isolate would) and polls it there.
test("a code started by the route is approvable from a fresh instance (drive#136 a over D1)", async () => {
  const db = makeFakeD1();
  const store = createMemoryStore({
    signin: createD1DeviceSigninStore(db, { now: () => 0 }),
  });
  const accounts = accountsFor("sess_ok");
  /** @param {import("../../../core/device-signin.js").DeviceSigninStore} signin */
  const ctxFor = (signin) => ({
    env: {
      DEVICE_RATE_LIMITER: { limit: async () => ({ success: true }) },
      DEVICE_GLOBAL_RATE_LIMITER: { limit: async () => ({ success: true }) },
    },
    db,
    store: createMemoryStore({ signin }),
    accounts,
    account: null,
    now: () => 0,
  });

  const codeRes = await dispatch(
    new Request("https://api.test/v1/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nish's MacBook" }),
    }),
    ctxFor(store),
  );
  assert.equal(codeRes.status, 200, "the code route answered with the D1 store behind it");
  const firstCode = await codeRes.json();
  assert.match(firstCode.userCode, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.equal(firstCode.deviceCode.length > 0, true);
  assert.equal(firstCode.expiresIn, DEVICE_CODE_TTL_SECONDS);

  // A fresh instance answers the same code route: no module-level state holds it.
  const second = createD1DeviceSigninStore(db, { now: () => 0 });
  const started = await dispatch(
    new Request("https://api.test/v1/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nish's MacBook" }),
    }),
    ctxFor(second),
  );
  assert.equal(started.status, 200);
  const code = await started.json();
  assert.match(code.userCode, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.equal(code.deviceCode.length > 0, true);
  assert.notEqual(code.deviceCode, code.userCode);
  assert.equal(code.expiresIn, DEVICE_CODE_TTL_SECONDS);
  assert.notEqual(code.userCode, firstCode.userCode, "each code is its own row");

  // A third instance over the same database sees the code and can approve it.
  const third = createD1DeviceSigninStore(db, { now: () => 0 });
  const pageCtx = ctxFor(third);
  const approved = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=sess_ok`,
        origin: "https://api.test",
      },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    }),
    pageCtx,
  );
  assert.equal(approved.status, 200);

  // The CLI's poll, from a fourth instance, holds the token exactly once.
  const fourth = createD1DeviceSigninStore(db, { now: () => 0 });
  const polled = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: code.deviceCode }),
    }),
    ctxFor(fourth),
  );
  assert.equal(polled.status, 200);
  const token = await polled.json();
  assert.equal(token.status, "approved");
  assert.equal(token.account.id, ACCOUNT.id);
  assert.equal(token.deviceToken.length > 0, true);

  // A fifth instance resolves the token it never minted in memory.
  const fifth = createD1DeviceSigninStore(db, { now: () => 0 });
  assert.deepEqual(await fifth.accountForDeviceToken(token.deviceToken), ACCOUNT);
});
