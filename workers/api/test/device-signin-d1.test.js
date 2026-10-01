import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_COOKIE } from "../../../src/accounts.js";
import { createD1DeviceSigninStore, DEVICE_CODE_TTL_SECONDS } from "../src/device-signin.js";
import { dispatch } from "../src/index.js";
import { createMemoryStore } from "../src/keystore.js";

// A minimal D1 stand-in for the device sign-in store: it implements the exact
// statements device-signin.js prepares, over Maps, so two store instances share
// one database the way two Worker isolates share a real D1. That sharing is the
// point of the test — the code lives in the database, not in module state.
function makeFakeD1() {
  /** @type {Map<string, any>} */ const codes = new Map();
  /** @type {Map<string, any>} */ const byUserCode = new Map();
  /** @type {Map<string, any>} */ const tokens = new Map();

  function prepare(sql) {
    const s = sql.replace(/\s+/g, " ").trim();
    return {
      bind(...params) {
        return {
          async first() {
            if (s.includes("FROM device_codes WHERE user_code")) {
              return byUserCode.get(params[0]) ?? null;
            }
            if (s.includes("FROM device_codes WHERE device_code_hash")) {
              return codes.get(params[0]) ?? null;
            }
            if (s.includes("FROM device_tokens WHERE token_hash")) {
              return tokens.get(params[0]) ?? null;
            }
            throw new Error(`fake D1: unexpected first() SQL: ${s}`);
          },
          async run() {
            if (s.startsWith("INSERT INTO device_codes")) {
              const [hash, userCode, name, createdAt, expiresAt] = params;
              const row = {
                device_code_hash: hash,
                user_code: userCode,
                name,
                status: "pending",
                account_id: "",
                account_name: "",
                account_email: "",
                created_at: createdAt,
                expires_at: expiresAt,
              };
              codes.set(hash, row);
              byUserCode.set(userCode, row);
              return { success: true, meta: { changes: 1 } };
            }
            if (s.startsWith("UPDATE device_codes SET status = 'approved'")) {
              const [accountId, accountName, accountEmail, userCode] = params;
              const row = byUserCode.get(userCode);
              if (row?.status !== "pending") {
                return { success: true, meta: { changes: 0 } };
              }
              row.status = "approved";
              row.account_id = accountId;
              row.account_name = accountName;
              row.account_email = accountEmail;
              return { success: true, meta: { changes: 1 } };
            }
            if (s.startsWith("UPDATE device_codes SET status = 'used'")) {
              const row = codes.get(params[0]);
              if (row?.status !== "approved") {
                return { success: true, meta: { changes: 0 } };
              }
              row.status = "used";
              return { success: true, meta: { changes: 1 } };
            }
            if (s.startsWith("INSERT INTO device_tokens")) {
              const [hash, accountId, accountName, accountEmail, createdAt] = params;
              tokens.set(hash, {
                token_hash: hash,
                account_id: accountId,
                account_name: accountName,
                account_email: accountEmail,
                created_at: createdAt,
              });
              return { success: true, meta: { changes: 1 } };
            }
            throw new Error(`fake D1: unexpected run() SQL: ${s}`);
          },
        };
      },
    };
  }

  return { prepare, codes, byUserCode, tokens };
}

const ACCOUNT = { id: "acct_1", name: "Nish", email: "nish@example.com" };

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
  const accounts = {
    async accountForSession(token) {
      return token === "sess_ok" ? ACCOUNT : null;
    },
  };
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
  const accounts = {
    async accountForSession(token) {
      return token === "sess_ok" ? ACCOUNT : null;
    },
  };
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
