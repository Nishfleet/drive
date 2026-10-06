// Drive issue #524: sign-in safety — the second factor (TOTP + passkeys +
// recovery codes). Tests the REAL better-auth plugin set over the REAL
// SQLite D1 shim, so the shape this code relies on (the enable call,
// verifyTOTP/verifyBackupCode, session rotation, and the storage schema)
// is proven on real records — a mock of the plugin would miss the
// schema mismatch that the production D1 deployment would hit.
//
// Probes:
//   1. Enrollment: the one-shot recovery codes, encrypted storage, flag.
//   2. Passkeys: the stock endpoints answer with the expected origin.
//   3. The armed page shows the second-factor field; the unarmed one
//      does not — and the second factor holds the approval.
//   4. Wrong / missing / recovery / correct codes: approve nothing,
//      approve once, reuse refused.
//   5. The site worker: CSRF blocks a cross-site post; the mounted
//      /api/auth/* route is classified public so the account gate passes.
//   6. Arm has no effect on the email sign-in itself (documented choice).

import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_COOKIE_PREFIX } from "../core/auth.js";
import { createD1DeviceSigninStore } from "../core/device-signin.js";
import { createMemoryStore } from "../core/keystore.js";
import worker from "../src/index.js";
import { dispatch } from "../workers/api/src/index.js";
import {
  armTwoFactor,
  createTestAuth,
  sessionHeaders,
  signIn,
  TEST_BASE_URL,
  totpCode,
} from "./harness.mjs";

const _SESSION_COOKIE = `__Secure-${AUTH_COOKIE_PREFIX}.session_token`;

const workerFetch =
  /** @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );

/** A fake limiter that always passes. */
function passLimiter() {
  return { success: true };
}

/** The migrations the api-side approve path touches: the device code rows
 * (0007), the accounts its approval posts into (0010), and the sign-in
 * family's own schema (0005, 0011, and the second-factor file 0028). */
const DEVICE_MIGRATIONS = [
  "drive/0007_device_codes.sql",
  "drive/0010_accounts_devices.sql",
  "drive/0005_better_auth.sql",
  "drive/0011_rate_limit.sql",
  "drive/0028_two_factor_passkey.sql",
];

/**
 * An auth instance over a database that also has the device code tables —
 * the pair the approval route joins.
 */
function apiMade() {
  return createTestAuth({ migrations: DEVICE_MIGRATIONS });
}

/**
 * The env the site Worker's real dispatch is driven with (test/signin.test.mjs
 * builds the same): the customer database and the two Better Auth settings.
 * @param {ReturnType<typeof createTestAuth>} made
 */
function siteEnv(made) {
  return {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite",
    BETTER_AUTH_URL: TEST_BASE_URL,
  };
}

/**
 * The api Worker dispatched with the real better-auth instance and a
 * device store over the same database — so the approval route's
 * twoFactorEnabled gate reads the account the session cookie resolves
 * to.
 * @param {ReturnType<typeof createTestAuth>} made
 * @returns {(request: Request) => Promise<Response>}
 */
function apiDispatch(made) {
  return (request) =>
    dispatch(request, {
      env: {
        DEVICE_RATE_LIMITER: { limit: passLimiter },
        DEVICE_GLOBAL_RATE_LIMITER: { limit: passLimiter },
      },
      db: made.db,
      store: createMemoryStore({
        signin: createD1DeviceSigninStore(made.db, { now: () => 0 }),
      }),
      accounts: made.auth,
      account: null,
      now: () => 0,
    });
}

/** A POST body builder for form-encoded device-approve requests.
 * @param {Record<string, string>} fields
 */
function approveBody(fields) {
  const body = new URLSearchParams(fields);
  return body.toString();
}

// ---------------------------------------------------------------- enrollment

test("enabling two-factor shows the recovery codes once and stores them encrypted", async () => {
  const made = createTestAuth();
  const signed = await signIn(made, "armed@example.com");
  // `body: {}` is the library's default method, the reader: the codes come
  // back on the enrollment answer, and the cast is the union's totp branch.
  const enabled = /** @type {{totpURI: string, backupCodes: string[]}} */ (
    await made.auth.api.enableTwoFactor({
      body: {},
      headers: sessionHeaders(signed.cookie),
    })
  );
  assert.equal(enabled.backupCodes.length, 10, "ten codes returned once");
  assert.equal(
    enabled.backupCodes.every((/** @type {string} */ c) => c.length >= 8),
    true,
  );
  // The stored blob is encrypted (hex) — the one-time codes never land
  // in the database in the clear.
  const row = made.db.sqlite
    .prepare("SELECT backupCodes FROM twoFactor WHERE userId = ?")
    .get(signed.account.id);
  assert.ok(row, "a twoFactor row was created");
  const stored = String(row.backupCodes);
  assert.ok(!stored.includes(enabled.backupCodes[0]), "stored codes are not plaintext");
  const session = await made.auth.api.getSession({ headers: sessionHeaders(signed.cookie) });
  assert.equal(session?.user.twoFactorEnabled, false, "flag is off until a code confirms");
});

test("the first correct code arms the account and rotates the session", async () => {
  const made = apiMade();
  const armed = await armTwoFactor(made, "armed@example.com");
  const session = await made.auth.api.getSession({ headers: sessionHeaders(armed.cookie) });
  assert.equal(session?.user.twoFactorEnabled, true);
});

// ---------------------------------------------------------------- passkeys

test("the stock passkey endpoints answer the mounted api", async () => {
  const made = createTestAuth();
  const env = siteEnv(made);
  const signed = await signIn(made, "pw@example.com");
  const options = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/auth/passkey/generate-register-options`, {
      headers: { origin: TEST_BASE_URL, cookie: signed.cookie },
    }),
    env,
  );
  assert.equal(options.status, 200);
  const body = await options.json();
  assert.equal(body.rp.name, "drive");
  assert.equal(body.rp.id, "drive.test");
  const list = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/auth/passkey/list-user-passkeys`, {
      headers: { cookie: signed.cookie },
    }),
    env,
  );
  assert.deepEqual(await list.json(), []);
});

// ---------------------------------------------------- the api approve path

test("an unarmed account approves a device code as before", async () => {
  const made = apiMade();
  const signed = await signIn(made, "open@example.com");
  const requestCode = await apiDispatch(made)(
    new Request(`${TEST_BASE_URL}/v1/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_BASE_URL },
      body: JSON.stringify({ name: "laptop" }),
    }),
  );
  assert.equal(requestCode.status, 200, "code issued");
  const { userCode, deviceCode } = await requestCode.json();
  const response = await apiDispatch(made)(
    new Request(`${TEST_BASE_URL}/v1/device/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: TEST_BASE_URL,
        cookie: signed.cookie,
      },
      body: approveBody({ user_code: userCode }),
    }),
  );
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes("is connected"), "approved: connected page");
  const poll = await apiDispatch(made)(
    new Request(`${TEST_BASE_URL}/v1/device/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: TEST_BASE_URL,
        cookie: signed.cookie,
      },
      body: JSON.stringify({ device_code: deviceCode }),
    }),
  );
  const minted = await poll.json();
  assert.equal(minted.status, "approved");
  assert.ok(minted.deviceToken, "the CLI's poll gets the key");
});

test("an armed account gets the second-factor field and is refused without it", async () => {
  const made = apiMade();
  const armed = await armTwoFactor(made, "armed@example.com");
  const requestCode = await apiDispatch(made)(
    new Request(`${TEST_BASE_URL}/v1/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_BASE_URL },
      body: JSON.stringify({ name: "laptop" }),
    }),
  );
  const { userCode, deviceCode } = await requestCode.json();
  const page = await apiDispatch(made)(
    new Request(`${TEST_BASE_URL}/v1/device/approve`, {
      headers: { origin: TEST_BASE_URL, cookie: armed.cookie },
    }),
  );
  const text = await page.text();
  assert.ok(text.includes('name="second_factor"'), "field is shown when armed");
  const post = await apiDispatch(made)(
    new Request(`${TEST_BASE_URL}/v1/device/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: TEST_BASE_URL,
        cookie: armed.cookie,
      },
      body: approveBody({ user_code: userCode }),
    }),
  );
  const body = await post.text();
  assert.ok(body.includes("Type the code from your authentication app"), "missing code is refused");
  const poll = await apiDispatch(made)(
    new Request(`${TEST_BASE_URL}/v1/device/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: TEST_BASE_URL,
        cookie: armed.cookie,
      },
      body: JSON.stringify({ device_code: deviceCode }),
    }),
  );
  assert.equal((await poll.json()).status, "pending", "the code is still pending");
});

test("a wrong code approves nothing and the code stays pending", async () => {
  const made = apiMade();
  const armed = await armTwoFactor(made, "armed@example.com");
  const requestCode = await apiDispatch(made)(
    new Request(`${TEST_BASE_URL}/v1/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_BASE_URL },
      body: JSON.stringify({ name: "laptop" }),
    }),
  );
  const { userCode, deviceCode } = await requestCode.json();
  const response = await apiDispatch(made)(
    new Request(`${TEST_BASE_URL}/v1/device/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: TEST_BASE_URL,
        cookie: armed.cookie,
      },
      body: approveBody({ user_code: userCode, second_factor: "000000" }),
    }),
  );
  assert.ok((await response.text()).includes("That code did not match"), "wrong notice");
  const poll = await apiDispatch(made)(
    new Request(`${TEST_BASE_URL}/v1/device/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: TEST_BASE_URL,
        cookie: armed.cookie,
      },
      body: JSON.stringify({ device_code: deviceCode }),
    }),
  );
  assert.equal((await poll.json()).status, "pending", "the code is still pending");
});

test("the correct code approves; a recovery code approves once and reuse is refused", async () => {
  const made = apiMade();
  const armed = await armTwoFactor(made, "armed@example.com");

  const requestCode = async () => {
    const response = await apiDispatch(made)(
      new Request(`${TEST_BASE_URL}/v1/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_BASE_URL },
        body: JSON.stringify({ name: "laptop" }),
      }),
    );
    return response.json();
  };
  /** @param {string} code @param {string} secondFactor */
  const approve = async (code, secondFactor) =>
    apiDispatch(made)(
      new Request(`${TEST_BASE_URL}/v1/device/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: TEST_BASE_URL,
          cookie: armed.cookie,
        },
        body: approveBody({ user_code: code, second_factor: secondFactor }),
      }),
    );
  /** @param {string} code */
  const poll = async (code) => {
    const response = await apiDispatch(made)(
      new Request(`${TEST_BASE_URL}/v1/device/token`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: TEST_BASE_URL,
          cookie: armed.cookie,
        },
        body: JSON.stringify({ device_code: code }),
      }),
    );
    return response.json();
  };

  const one = await requestCode();
  const right = await approve(one.userCode, totpCode(armed.secret));
  assert.equal(right.status, 200);
  assert.ok(await right.text().then((t) => t.includes("is connected")));
  const minted = await poll(one.deviceCode);
  assert.equal(minted.status, "approved", "the TOTP code approved");

  const two = await requestCode();
  const recovered = await approve(two.userCode, armed.backupCodes[0]);
  assert.equal(recovered.status, 200);
  assert.equal((await poll(two.deviceCode)).status, "approved", "the recovery code approved");

  const three = await requestCode();
  const reused = await approve(three.userCode, armed.backupCodes[0]);
  assert.ok((await reused.text()).includes("That code did not match"), "reuse refused");
  assert.equal(
    (await poll(three.deviceCode)).status,
    "pending",
    "the recovery code did not approve twice",
  );
});

// ------------------------------------------------------------ site worker

test("the site worker mounts the auth family and keeps cross-site posts out", async () => {
  const made = createTestAuth();
  const env = siteEnv(made);
  const signed = await signIn(made, "site@example.com");
  // GET returns the session JSON — the mount is live and the account gate
  // passes because /api/auth/* is public (the account-gate walk covers it).
  const session = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/auth/get-session`, {
      headers: { cookie: signed.cookie },
    }),
    env,
  );
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.email, "site@example.com");
  // A cross-site post to the enable endpoint is refused at the site's
  // own same-origin check before Better Auth sees it.
  const cross = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/auth/two-factor/enable`, {
      method: "POST",
      headers: {
        origin: "https://evil.test",
        cookie: signed.cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    }),
    env,
  );
  assert.equal(cross.status, 403);
});

// Review C: the public /api/auth/* mount serves only the second-factor and
// passkey routes. The magic-link send (and verify) stay on /api/signin, which
// carries the site's own limits, so an anonymous POST here mails nothing.
test("the public auth mount refuses the magic-link send and verify", async () => {
  const made = createTestAuth();
  /** @type {string[]} */
  const sent = [];
  const env = {
    ...siteEnv(made),
    EMAIL: { send: async (/** @type {unknown} */ m) => sent.push(String(m)) },
  };
  for (const path of ["/api/auth/sign-in/magic-link", "/api/auth/magic-link/verify"]) {
    const response = await workerFetch(
      new Request(`${TEST_BASE_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_BASE_URL },
        body: JSON.stringify({ email: "anon@example.com" }),
      }),
      env,
    );
    assert.equal(response.status, 404, `${path} is not served on the public mount`);
  }
  assert.equal(sent.length, 0, "no mail left");
});

test("arming two-factor does not change the email sign-in", async () => {
  const made = createTestAuth();
  await armTwoFactor(made, "armed@example.com");
  const second = await signIn(made, "armed@example.com");
  const session = await made.auth.api.getSession({
    headers: sessionHeaders(second.cookie),
  });
  assert.equal(session?.user.email, "armed@example.com");
});

// The account gate classifies the auth family public by prefix: PUBLIC_ROUTES
// (src/index.js) carries "/api/auth/*", and isPublic strips the trailing "/*".
// The signed-in get-session is proven above; this proves the wildcard is not
// silently an exact match, because the one place a caller with no session must
// reach is the auth family, to register a passkey or turn a factor on before
// there is a session at all. The anonymous answer is "no session" (a null
// body), never a 401 from the account gate.
test("an anonymous caller reaches the mounted auth family", async () => {
  const made = createTestAuth();
  const response = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/auth/get-session`, {
      // No cookie: a signed-out browser.
    }),
    siteEnv(made),
  );
  assert.equal(response.status, 200, "the account gate let the anonymous request through");
  const body = await response.json();
  assert.ok(body === null || body?.session == null, "no session resolves for an anonymous caller");
});

// Drive#524 close: the second the route reads "does this account have a
// factor" must not let its own failure read as "no, it does not". This wrapper
// resolves the live session for the account gate (its one read), then throws
// on the route's own second read, so armedness cannot be answered. The account
// has a factor and none is supplied, so the approval is refused and the code
// stays pending — where a fail-OPEN read would have approved it.
test("a second-factor read that cannot be answered refuses the approval", async () => {
  const made = apiMade();
  const armed = await armTwoFactor(made, "unreadable@example.com");
  const realGetSession = made.auth.api.getSession.bind(made.auth);
  /** @type {number} */
  let reads = 0;
  const unreadable = {
    api: {
      async getSession(/** @type {{headers: Headers}} */ options) {
        reads += 1;
        // The account gate makes one read to resolve the session; every read
        // after that is the route asking whether the account has a factor.
        if (reads === 1) {
          return realGetSession(options);
        }
        throw new Error("the armedness read failed in flight");
      },
    },
  };
  const send = (/** @type {Request} */ request) =>
    dispatch(request, {
      env: {
        DEVICE_RATE_LIMITER: { limit: passLimiter },
        DEVICE_GLOBAL_RATE_LIMITER: { limit: passLimiter },
      },
      db: made.db,
      store: createMemoryStore({
        signin: createD1DeviceSigninStore(made.db, { now: () => 0 }),
      }),
      accounts: unreadable,
      account: null,
      now: () => 0,
    });
  const start = await send(
    new Request(`${TEST_BASE_URL}/v1/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_BASE_URL },
      body: JSON.stringify({ name: "laptop" }),
    }),
  );
  const { userCode, deviceCode } = await start.json();
  // No second factor supplied, so the unreadable armed state is treated as
  // armed: the page asks for the factor rather than connecting the device.
  const approve = await send(
    new Request(`${TEST_BASE_URL}/v1/device/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: TEST_BASE_URL,
        cookie: armed.cookie,
      },
      body: approveBody({ user_code: userCode }),
    }),
  );
  const body = await approve.text();
  assert.equal(approve.status, 200, "the page returns, not a server error");
  assert.ok(
    body.includes("Type the code from your authentication app"),
    "the unreadable factor reads as armed, so a second factor is asked for",
  );
  assert.ok(!body.includes("is connected"), "nothing connects when the factor cannot be read");
  const poll = await send(
    new Request(`${TEST_BASE_URL}/v1/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_BASE_URL },
      body: JSON.stringify({ device_code: deviceCode }),
    }),
  );
  assert.equal(
    (await poll.json()).status,
    "pending",
    "the code stays pending; nothing was approved",
  );
});
