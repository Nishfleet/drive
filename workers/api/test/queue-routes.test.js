// The queue-report route (drive issue #318), walked through the real registry
// and the real dispatcher (not the handler called directly), the way
// device-keys.test.js walks the device flow: a device signs in, reports its
// queue, the row lands, a report inside the interval is refused, and the
// account gate answers an anonymous caller 401 before any handler runs.
//
// The credential is a real device token, minted by walking the real sign-in
// flow over the real dispatcher: the reporter loop posts with the token
// cmd/drive/report.go reads out of the credentials file, so a test that
// invented one would not be walking the same path.

import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_COOKIE_PREFIX } from "../../../core/auth.js";
import { createMemoryStore } from "../../../core/keystore.js";
import { failureMessage } from "../../../core/messages.js";
import { createD1QueueStore, QUEUE_REPORT_INTERVAL_SECONDS } from "../../../core/queues.js";
import { createTestD1 } from "../../../test/harness.mjs";
import { dispatch } from "../src/index.js";
import { parseQueueReport, reportUploadQueueRoute } from "../src/queue-routes.js";

const QUEUE = { files: 3, uploadedBytes: 300_000_000, totalBytes: 1_200_000_000, paused: false };

// The session cookie Better Auth mints, named by core/auth.js
// `AUTH_COOKIE_PREFIX`: the approval is an account route, so walking the flow
// past the page needs one.
const SESSION_COOKIE = `__Secure-${AUTH_COOKIE_PREFIX}.session_token`;

// The edge limits the device sign-in routes fail closed without (drive issue
// #147): fake pass-throughs, so the flow is walked the way production runs it
// with the bindings configured. The queue-report route spends no edge bucket —
// its interval is the rate limit — so this is the device half only.
function limits() {
  const pass = {
    /** @param {{key: string}} _options */
    async limit(_options) {
      return { success: true };
    },
  };
  return { DEVICE_RATE_LIMITER: pass, DEVICE_GLOBAL_RATE_LIMITER: pass };
}

/**
 * @param {number} [startSeconds]
 * @returns {{now: () => number, advance: (seconds: number) => void}}
 */
function fixedClock(startSeconds = 1_000_000) {
  let seconds = startSeconds;
  return {
    now: () => seconds * 1000,
    advance: (by) => {
      seconds += by;
    },
  };
}

/**
 * The sign-in flow's stand-in, read only by the account gate: one token is a
 * signed-in person, every other value the browser could invent is not.
 * @param {string} token
 * @param {{id: string, name: string}} account
 */
function accountsFor(token, account) {
  return {
    api: {
      /** @param {{headers: Headers}} options */
      async getSession({ headers }) {
        const cookie = headers.get("cookie") ?? "";
        const found = cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
        return found?.slice(SESSION_COOKIE.length + 1) === token
          ? { user: { ...account, email: `${account.id}@example.com` } }
          : null;
      },
    },
  };
}

/**
 * Walks the real device sign-in over the real dispatcher and returns the token
 * the CLI keeps, the way cmd/drive/report.go reads it.
 * @param {ReturnType<typeof createMemoryStore>} store
 * @param {ReturnType<typeof fixedClock>} clock
 * @param {ReturnType<typeof import("../../../core/queues.js").createD1QueueStore>|null} queues
 * @param {{id: string, name: string}} account
 * @returns {Promise<{token: string, sessionToken: string}>}
 */
async function signInDevice(store, clock, queues, account) {
  const sessionToken = `sess-${account.id}`;
  const accounts = accountsFor(sessionToken, account);
  const ctx = () => ({ env: limits(), db: null, store, queues, now: clock.now, accounts });
  const code = await (
    await dispatch(
      new Request("https://api.test/v1/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: account.name }),
      }),
      ctx(),
    )
  ).json();
  const approved = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
      },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    }),
    ctx(),
  );
  assert.equal(approved.status, 200, "the person could not approve the code");
  const polled = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: code.deviceCode }),
    }),
    ctx(),
  );
  const result = await polled.json();
  assert.equal(result.status, "approved");
  return { token: result.deviceToken, sessionToken };
}

/**
 * A dispatch context with a signed-in device: the store the account gate reads
 * the bearer token through, and the D1 queue store the route writes.
 * @param {{clock: ReturnType<typeof fixedClock>, db?: ReturnType<typeof createTestD1>, account?: {id: string, name: string}|null, withQueues?: boolean}} options
 */
async function signedIn({
  clock,
  db = createTestD1(),
  account = { id: "acct_1", name: "Your drive" },
  withQueues = true,
}) {
  const store = createMemoryStore({ now: clock.now });
  const queues = withQueues ? createD1QueueStore(db, { now: clock.now }) : null;
  const signed =
    account === null
      ? { token: "", sessionToken: "" }
      : await signInDevice(store, clock, queues, account);
  return {
    store,
    queues,
    token: signed.token,
    ctx: { env: limits(), db: null, store, queues, now: clock.now, accounts: undefined },
  };
}

/**
 * @param {unknown} body
 * @param {string} token the device token the mount holds; empty for a caller
 *   that presents no bearer at all
 * @returns {Request}
 */
function postQueue(body, token) {
  return new Request("https://api.test/v1/queue", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

test("the route is in the registry behind the account gate", async () => {
  // A report is a credential-holding write, so the registry declares it an
  // account route and the gate answers an anonymous caller 401 with the
  // message table's words. The gate is walked over the real Hono table by
  // workers/api/test/index.test.js; this is the same path with no token.
  const clock = fixedClock();
  const { ctx, token } = await signedIn({ clock });
  // No bearer at all, then a token this drive never minted: both are the
  // gate's 401, so the route cannot tell a dead credential from a made-up one.
  for (const presented of ["", "made-up"]) {
    const anonymous = await dispatch(postQueue(QUEUE, presented), ctx);
    assert.equal(anonymous.status, 401, `a caller with ${presented || "no"} token was answered`);
    assert.equal(anonymous.headers.get("www-authenticate"), 'Bearer realm="drive"');
    assert.deepEqual(await anonymous.json(), { error: failureMessage("unauthorized") });
  }
  // The same store, with the token the flow really minted, is a 200 — so the
  // 401 above is the credential and not a route that refuses everyone.
  assert.equal((await dispatch(postQueue(QUEUE, token), ctx)).status, 200);
});

test("a device's report is stored and read back as its own queue", async () => {
  const clock = fixedClock();
  const { ctx, token, queues } = await signedIn({ clock });
  assert.ok(queues, "the test needs the queue store");
  const stored = await dispatch(postQueue(QUEUE, token), ctx);
  assert.equal(stored.status, 200, await stored.clone().text());
  const body = await stored.json();
  assert.equal(body.reported, true);
  assert.equal(body.reportedAt, 1_000_000);
  assert.deepEqual(await queues.latest("acct_1"), QUEUE);
});

test("a second report inside the interval is refused with retry-after", async () => {
  // The rate limit the issue asks for: a real mount's loop ticks at the
  // interval, so it cannot trip it, and a caller that tries is told when to
  // come back rather than being silently dropped.
  const clock = fixedClock();
  const { ctx, token, queues } = await signedIn({ clock });
  assert.ok(queues, "the test needs the queue store");
  assert.equal((await dispatch(postQueue(QUEUE, token), ctx)).status, 200);
  clock.advance(2);
  const tooSoon = await dispatch(postQueue({ ...QUEUE, uploadedBytes: 900_000_000 }, token), ctx);
  assert.equal(tooSoon.status, 429);
  assert.ok(tooSoon.headers.get("retry-after"), "the refusal names when to try again");
  // The refused report changed nothing: the row still carries the first one.
  assert.equal((await queues.latest("acct_1"))?.uploadedBytes, 300_000_000);
  clock.advance(QUEUE_REPORT_INTERVAL_SECONDS - 2);
  assert.equal(
    (await dispatch(postQueue({ ...QUEUE, uploadedBytes: 900_000_000 }, token), ctx)).status,
    200,
  );
  assert.equal((await queues.latest("acct_1"))?.uploadedBytes, 900_000_000);
});

test("a report that is not a queue is a 400 naming the field", async () => {
  // A broken report fails here rather than storing a plausible line about
  // bytes nobody counted, and every refusal names itself.
  const clock = fixedClock();
  const { ctx, token, queues } = await signedIn({ clock });
  assert.ok(queues, "the test needs the queue store");
  /** @type {Array<[Record<string, unknown>, RegExp]>} */
  const cases = [
    [{ ...QUEUE, files: -1 }, /files/],
    [{ ...QUEUE, files: 1.5 }, /files/],
    [{ ...QUEUE, uploadedBytes: "many" }, /uploadedBytes/],
    [{ ...QUEUE, totalBytes: -5 }, /totalBytes/],
    [{ ...QUEUE, paused: "yes" }, /paused/],
    [{ ...QUEUE, uploadedBytes: 2_000_000_000 }, /uploadedBytes/],
  ];
  for (const [body, names] of cases) {
    const refused = await dispatch(postQueue(body, token), ctx);
    assert.equal(refused.status, 400, `${JSON.stringify(body)} was accepted`);
    assert.match(
      (await refused.json()).error,
      names,
      `${JSON.stringify(body)} did not name the field`,
    );
  }
  // A body that is not JSON, and one that is not an object.
  for (const raw of ["not json", "[1,2]", '"queue"']) {
    const refused = await dispatch(
      new Request("https://api.test/v1/queue", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: raw,
      }),
      ctx,
    );
    assert.equal(refused.status, 400, `${raw} was accepted`);
  }
  assert.equal(await queues.latest("acct_1"), null, "a refused report wrote no row");
});

test("a report needs the queue fields, not a default", () => {
  // The parse is exported so the same rules are pinned without HTTP: a missing
  // field is refused, because a report that defaults a missing byte count to 0
  // is a queue nobody measured.
  assert.deepEqual(parseQueueReport(QUEUE), { report: QUEUE });
  for (const missing of ["files", "uploadedBytes", "totalBytes"]) {
    /** @type {Record<string, unknown>} */
    const body = { ...QUEUE };
    delete body[missing];
    const parsed = parseQueueReport(body);
    assert.ok("error" in parsed, `${missing} defaulted rather than being refused`);
    assert.match(parsed.error, new RegExp(missing));
  }
  // An absent `paused` is an absent flag, not a refusal: it means not paused,
  // the same way `uploadProgress` reads it.
  const { paused: _paused, ...withoutPaused } = QUEUE;
  assert.deepEqual(parseQueueReport(withoutPaused), { report: { ...QUEUE, paused: false } });
});

test("the route names the one method it serves", async () => {
  const clock = fixedClock();
  const { ctx, token } = await signedIn({ clock });
  const wrong = await dispatch(
    new Request("https://api.test/v1/queue", { headers: { authorization: `Bearer ${token}` } }),
    ctx,
  );
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "POST");
});

test("a deployment with no database refuses rather than answering as though it had", async () => {
  const clock = fixedClock();
  const { ctx, token } = await signedIn({ clock, withQueues: false });
  const refused = await dispatch(postQueue(QUEUE, token), ctx);
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error, /queue report/);
});

test("the handler answers a direct call with no account the same way the gate does", async () => {
  // The gate answers an anonymous caller before the handler runs, so this half
  // is the belt-and-braces a unit test can drive without the gate: the route
  // itself does not treat a missing account as an open endpoint.
  const refused = await reportUploadQueueRoute(postQueue(QUEUE, "any"), { account: null });
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get("www-authenticate"), 'Bearer realm="drive"');
});

test("one device's report is never read as another's", async () => {
  const clock = fixedClock();
  const db = createTestD1();
  const one = await signedIn({ clock, db, account: { id: "acct_1", name: "One" } });
  const two = await signedIn({ clock, db, account: { id: "acct_2", name: "Two" } });
  const queues = createD1QueueStore(db, { now: clock.now });
  assert.equal((await dispatch(postQueue(QUEUE, one.token), one.ctx)).status, 200);
  clock.advance(QUEUE_REPORT_INTERVAL_SECONDS);
  assert.equal(
    (
      await dispatch(
        postQueue({ files: 1, uploadedBytes: 0, totalBytes: 4096, paused: true }, two.token),
        two.ctx,
      )
    ).status,
    200,
  );
  assert.deepEqual(await queues.latest("acct_1"), QUEUE);
  assert.deepEqual(await queues.latest("acct_2"), {
    files: 1,
    uploadedBytes: 0,
    totalBytes: 4096,
    paused: true,
  });
});
