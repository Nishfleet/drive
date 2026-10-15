import assert from "node:assert/strict";
import { test } from "node:test";
import "urlpattern-polyfill";
import { createD1DeviceSigninStore, DEVICE_CODE_TTL_SECONDS } from "../../../core/device-signin.js";
import { createMemoryStore } from "../../../core/keystore.js";
import { dispatch } from "../src/index.js";
import {
  ACCOUNT,
  accountsFor,
  makeFakeD1,
  SESSION_COOKIE,
  STAND_IN_CODE,
} from "./device-signin-d1-helpers.js";

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

// The approval page with a second factor on the account (drive#524). The
// stand-in `accountsFor` reads the library's own flag and answers the two
// stock verify endpoints, so this walks the route's rule: an armed account
// cannot approve a device code without a correct second factor, the code
// stays pending, and a surface that claims the account is armed but cannot
// verify a code approves nothing at all (fail closed).
test("an armed account needs the second factor, and the code stays pending without it", async () => {
  const db = makeFakeD1();
  const store = createMemoryStore({
    signin: createD1DeviceSigninStore(db, { now: () => 0 }),
  });
  /** @param {ReturnType<typeof accountsFor>} accounts */
  const ctxFor = (accounts) => ({
    env: {
      DEVICE_RATE_LIMITER: { limit: async () => ({ success: true }) },
      DEVICE_GLOBAL_RATE_LIMITER: { limit: async () => ({ success: true }) },
    },
    db,
    store,
    accounts,
    account: null,
    now: () => 0,
  });
  const ctx = ctxFor(accountsFor("sess_ok", { armed: true, verify: true }));
  const started = await store.requestDeviceCode({ name: "laptop" });
  /** @param {string} userCode @param {string} [secondFactor] */
  const approve = (userCode, secondFactor = "") =>
    dispatch(
      new Request("https://api.test/v1/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${SESSION_COOKIE}=sess_ok`,
        },
        body: new URLSearchParams({ user_code: userCode, second_factor: secondFactor }).toString(),
      }),
      ctx,
    );

  // No code typed: refused, nothing consumed.
  const blank = await approve(started.userCode);
  assert.equal(blank.status, 200, "the page comes back, not a server error");
  assert.doesNotMatch(await blank.text(), /is connected/);
  assert.deepEqual(await store.pollDeviceCode(started.deviceCode), { status: "pending" });

  // Wrong code: refused the same way.
  const wrong = await approve(started.userCode, "000000");
  assert.doesNotMatch(await wrong.text(), /is connected/);
  assert.deepEqual(await store.pollDeviceCode(started.deviceCode), { status: "pending" });

  // Correct code: approved, and the CLI's poll gets the key.
  const right = await approve(started.userCode, STAND_IN_CODE);
  assert.match(await right.text(), /is connected/);
  const polled = await store.pollDeviceCode(started.deviceCode);
  assert.equal(polled.status, "approved");
  assert.ok(polled.status === "approved" && polled.deviceToken.length > 0);
});

test("an account that claims a second factor but cannot verify one approves nothing", async () => {
  const db = makeFakeD1();
  const store = createMemoryStore({
    signin: createD1DeviceSigninStore(db, { now: () => 0 }),
  });
  const ctx = {
    env: {
      DEVICE_RATE_LIMITER: { limit: async () => ({ success: true }) },
      DEVICE_GLOBAL_RATE_LIMITER: { limit: async () => ({ success: true }) },
    },
    db,
    store,
    // Armed, but no verify endpoints: the route must fail closed rather than
    // fall through to approving on the flag alone.
    accounts: accountsFor("sess_ok", { armed: true }),
    account: null,
    now: () => 0,
  };
  const started = await store.requestDeviceCode({ name: "laptop" });
  const page = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=sess_ok`,
      },
      body: new URLSearchParams({
        user_code: started.userCode,
        second_factor: STAND_IN_CODE,
      }).toString(),
    }),
    ctx,
  );
  assert.doesNotMatch(await page.text(), /is connected/);
  assert.deepEqual(await store.pollDeviceCode(started.deviceCode), { status: "pending" });
});

// drive#524 review B: armed-ness is read from the user row by the account id
// the gate resolved, so an approval carried by a bearer device token (no
// cookie for getSession to read) is gated like a cookie approval, and a user
// row that cannot be read refuses instead of approving.
test("a bearer-token approval of an armed account is refused, and so is an unreadable user row", async () => {
  const armedUsers = new Set();
  const db = makeFakeD1({ armedUsers });
  const store = createMemoryStore({
    signin: createD1DeviceSigninStore(db, { now: () => 0 }),
  });
  const ctx = {
    env: {
      DEVICE_RATE_LIMITER: { limit: async () => ({ success: true }) },
      DEVICE_GLOBAL_RATE_LIMITER: { limit: async () => ({ success: true }) },
    },
    db,
    store,
    // Like the library, the verify endpoints need the browser session: a
    // bearer-only request has no cookie, so it can never present a factor.
    accounts: (() => {
      const stub = accountsFor("sess_ok", { armed: false, verify: true });
      /** @param {{body: {code: string}, headers: Headers}} args */
      const needsSession = async ({ body, headers }) => {
        if (!headers.get("cookie")) throw new Error("no session");
        if (body.code !== STAND_IN_CODE) throw new Error("invalid code");
        return {};
      };
      return { api: { ...stub.api, verifyTOTP: needsSession, verifyBackupCode: needsSession } };
    })(),
    account: null,
    now: () => 0,
  };
  // The first device is approved while the account has no factor, to get a token.
  const first = await store.requestDeviceCode({ name: "first" });
  await store.approveDeviceCode(first.userCode, ACCOUNT);
  const polled = await store.pollDeviceCode(first.deviceCode);
  assert.equal(polled.status, "approved");
  const bearer = polled.status === "approved" ? polled.deviceToken : "";
  /** @param {string} userCode */
  const approveByBearer = (userCode) =>
    dispatch(
      new Request("https://api.test/v1/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${bearer}`,
        },
        body: new URLSearchParams({ user_code: userCode, second_factor: STAND_IN_CODE }).toString(),
      }),
      ctx,
    );

  // Control: no factor on the account, so the bearer approval goes through.
  const open = await store.requestDeviceCode({ name: "open" });
  assert.match(await (await approveByBearer(open.userCode)).text(), /is connected/);

  // The account turns the factor on: the same bearer approval is refused.
  armedUsers.add(ACCOUNT.id);
  const second = await store.requestDeviceCode({ name: "second" });
  const refused = await approveByBearer(second.userCode);
  assert.doesNotMatch(await refused.text(), /is connected/);
  assert.deepEqual(await store.pollDeviceCode(second.deviceCode), { status: "pending" });

  // The user row cannot be read: refused, not waved through.
  armedUsers.delete(ACCOUNT.id);
  const failing = makeFakeD1({ userReadFails: true });
  const failStore = createMemoryStore({
    signin: createD1DeviceSigninStore(failing, { now: () => 0 }),
  });
  const seed = await failStore.requestDeviceCode({ name: "seed" });
  await failStore.approveDeviceCode(seed.userCode, ACCOUNT);
  const seedPoll = await failStore.pollDeviceCode(seed.deviceCode);
  const failBearer = seedPoll.status === "approved" ? seedPoll.deviceToken : "";
  const third = await failStore.requestDeviceCode({ name: "third" });
  const unreadable = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${failBearer}`,
      },
      body: new URLSearchParams({ user_code: third.userCode }).toString(),
    }),
    { ...ctx, db: failing, store: failStore },
  );
  assert.doesNotMatch(await unreadable.text(), /is connected/);
  assert.deepEqual(await failStore.pollDeviceCode(third.deviceCode), { status: "pending" });
});

test("the approve page asks for the second factor only when the account has one", async () => {
  const db = makeFakeD1();
  const store = createMemoryStore({
    signin: createD1DeviceSigninStore(db, { now: () => 0 }),
  });
  const started = await store.requestDeviceCode({ name: "laptop" });
  const page = async (/** @type {ReturnType<typeof accountsFor>} */ accounts) => {
    const response = await dispatch(
      new Request(`https://api.test/v1/device/approve?user_code=${started.userCode}`, {
        headers: { cookie: `${SESSION_COOKIE}=sess_ok` },
      }),
      {
        env: {
          DEVICE_RATE_LIMITER: { limit: async () => ({ success: true }) },
          DEVICE_GLOBAL_RATE_LIMITER: { limit: async () => ({ success: true }) },
        },
        db,
        store,
        accounts,
        account: null,
        now: () => 0,
      },
    );
    assert.equal(response.status, 200);
    return response.text();
  };
  assert.doesNotMatch(await page(accountsFor("sess_ok")), /name="second_factor"/);
  assert.match(
    await page(accountsFor("sess_ok", { armed: true, verify: true })),
    /name="second_factor"/,
  );
});
