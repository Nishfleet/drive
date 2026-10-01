import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SESSION_COOKIE } from "../../../src/accounts.js";
import { createD1DeviceSigninStore, DEVICE_CODE_TTL_SECONDS } from "../src/device-signin.js";
import { dispatch } from "../src/index.js";
import { createMemoryStore } from "../src/keystore.js";

// A minimal D1 stand-in for the device sign-in store: it implements the exact
// statements device-signin.js prepares, over Maps, so two store instances share
// one database the way two Worker isolates share a real D1. That sharing is the
// point of the test — the code lives in the database, not in module state.
//
// `batch` is a transaction here, as it is in D1: the statements run in order
// and a throw rolls every one of them back, so the store's "consume the code
// and write the token together" is really tested rather than asserted.
// `options.onRead` fires on every `first()`, which is how a test crosses the
// TTL between a read and the write that follows it; `options.failOn` names a
// statement prefix that throws, which is how a half-written pair is tested.
function makeFakeD1(options = {}) {
  /** @type {Map<string, any>} */ const codes = new Map();
  /** @type {Map<string, any>} */ const byUserCode = new Map();
  /** @type {Map<string, any>} */ const tokens = new Map();

  const snapshot = () => ({
    codes: new Map([...codes].map(([k, v]) => [k, { ...v }])),
    byUserCode: new Map(byUserCode),
    tokens: new Map(tokens),
  });
  const restore = (snap) => {
    codes.clear();
    byUserCode.clear();
    tokens.clear();
    for (const [k, v] of snap.codes) {
      codes.set(k, v);
    }
    for (const [k, v] of snap.byUserCode) {
      byUserCode.set(k, v);
    }
    for (const [k, v] of snap.tokens) {
      tokens.set(k, v);
    }
  };

  /** One statement, the way D1 runs it: mutate, or throw and change nothing. */
  function runStatement(s, params) {
    if (options.failOn !== undefined && s.startsWith(options.failOn)) {
      // One failure, then the database behaves again: the test proves the
      // retry after the rollback succeeds.
      delete options.failOn;
      throw new Error(
        `fake D1: ${s.split(" ")[0]} ${s.split(" ")[1]} ${s.split(" ")[2]} was made to fail`,
      );
    }
    if (s.startsWith("DELETE FROM device_codes")) {
      let changes = 0;
      for (const [hash, row] of codes) {
        if (row.expires_at <= params[0]) {
          codes.delete(hash);
          byUserCode.delete(row.user_code);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
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
      const [accountId, accountName, accountEmail, userCode, nowSecondsAt] = params;
      const row = byUserCode.get(userCode);
      if (row?.status !== "pending" || row.expires_at <= nowSecondsAt) {
        return { success: true, meta: { changes: 0 } };
      }
      row.status = "approved";
      row.account_id = accountId;
      row.account_name = accountName;
      row.account_email = accountEmail;
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE device_codes SET status = 'used'")) {
      const [hash, nowSecondsAt] = params;
      const row = codes.get(hash);
      if (row?.status !== "approved" || row.expires_at <= nowSecondsAt) {
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
  }

  function prepare(sql) {
    const s = sql.replace(/\s+/g, " ").trim();
    return {
      bind(...params) {
        return {
          sql: s,
          params,
          async first() {
            options.onRead?.();
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
            return runStatement(s, params);
          },
        };
      },
    };
  }

  return {
    prepare,
    /**
     * @param {Array<{sql: string, params: unknown[]}>} statements
     */
    async batch(statements) {
      const snap = snapshot();
      const results = [];
      try {
        for (const statement of statements) {
          results.push(runStatement(statement.sql, statement.params));
        }
      } catch (error) {
        restore(snap);
        throw error;
      }
      return results;
    },
    codes,
    byUserCode,
    tokens,
  };
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

// The store's SQL names a table and a set of columns; the migration is what
// creates them. Nothing in a Worker runs the migration (the api Worker has no
// deploy config in this tree, drive#168), so this is the check that the SQL the
// Worker prepares and the DDL the database gets cannot drift apart: a column
// renamed in the migration, or a table the migration never creates, fails here.
test("the migration creates every table and column the store's SQL names", () => {
  const ddl = readFileSync(
    new URL("../../../migrations/drive/0005_device_codes.sql", import.meta.url),
    "utf8",
  );
  const columnsOf = (table) => {
    const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\((.*?)\\n\\);`, "s").exec(
      ddl,
    )?.[1];
    assert.notEqual(body, undefined, `the migration never creates ${table}`);
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
  ]);
  assert.deepEqual(columnsOf("device_tokens"), [
    "token_hash",
    "account_id",
    "account_name",
    "account_email",
    "created_at",
  ]);
  // The sweep the code route runs on every request is a full scan without it.
  assert.match(
    ddl,
    /CREATE INDEX IF NOT EXISTS device_codes_expires_at ON device_codes \(expires_at\)/,
  );
});

// Consuming a code and writing its token are one transaction, so a failure
// between them cannot lose a sign-in a person already approved: the row is
// rolled back to `approved` and the next poll mints the token for real. Before
// this, the two statements were separate and the code was spent either way.
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
  const limiter = (success) => ({ limit: async () => ({ success }) });
  const ctxWith = (env) => ({
    env,
    db,
    store: createMemoryStore({ signin }),
    accounts: {
      async accountForSession() {
        return null;
      },
    },
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
