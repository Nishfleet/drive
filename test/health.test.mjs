// Tests for the health endpoint the outside monitor polls (drive issue #96,
// north star "Reliable": we hear about an outage before customers do).
//
// The three cases the issue names are the three that decide whether the
// endpoint is honest, and each is a test below: a healthy Worker answers 200
// with {"ok":true}, a database that cannot answer answers 503 naming that
// binding, and no body carries a secret or an internal. The rest pin the
// properties that make the answer trustworthy rather than merely green —
// that it is public (no account, no session, no cookie needed), that it is
// never cached (a cached 200 through an outage is a false all-clear), that it
// is bounded so a hung dependency cannot hang the probe, and that it answers
// through the Worker's own router rather than only when the module is imported
// by hand.
//
// Fakes stand in for the runtime: a D1 database whose read resolves, one
// whose read rejects, and one whose read never settles (the hang case). No
// network, no Worker runtime, matching the rest of the suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import {
  HEALTH_PATH,
  HEALTH_TIMEOUT_MS,
  checkHealth,
  d1Bindings,
  handleHealthRequest,
} from "../src/health.js";

/**
 * A D1Database stub answering only what the check uses. `mode` decides how
 * the trivial read resolves, so one fake covers healthy, broken and hung.
 */
function fakeD1(mode = "ok") {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      return {
        all(options = {}) {
          if (mode === "error") {
            return Promise.reject(
              new Error(
                "D1_ERROR: connection to 93c9f523-159c-4261-8541-d4c059906df3 failed: token=sk-secret-value",
              ),
            );
          }
          if (mode === "hang") {
            // Never settles on its own. The signal is what must end it, or
            // the race must — that is the whole point of the bound.
            return new Promise((resolve, reject) => {
              options.signal?.addEventListener("abort", () => {
                reject(new Error("The operation was aborted."));
              });
            });
          }
          return Promise.resolve({ results: [{ "1": 1 }] });
        },
      };
    },
  };
}

/**
 * A static-assets stub: a served path is a 200 and the path the probe asks
 * for is a 404, exactly as the runtime answers them. The check only needs a
 * response of any kind, so the 404 is the expected answer there.
 */
function fakeAssets() {
  const requests = [];
  return {
    requests,
    async fetch(request) {
      requests.push(request);
      return request.url.includes("__health_probe__")
        ? new Response(null, { status: 404 })
        : new Response("asset", { status: 200 });
    },
  };
}

const HEALTHY_ENV = () => ({
  WAITLIST_DB: fakeD1("ok"),
  ASSETS: fakeAssets(),
});

const GET = (path = HEALTH_PATH) =>
  new Request(`https://drive.test${path}`, { method: "GET" });

// --- the healthy answer ---------------------------------------------------

test("a healthy Worker answers 200 with {\"ok\":true}", async () => {
  const response = await handleHealthRequest(GET(), HEALTHY_ENV());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("the health answer is never cached", async () => {
  // A monitor that is handed a cached 200 during an outage is worse than no
  // monitor: it says all clear while the site is down.
  const response = await handleHealthRequest(GET(), HEALTHY_ENV());
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type"), /^application\/json/);
});

// --- the failing answer names the part -----------------------------------

test("a database that cannot answer is a 503 naming that binding", async () => {
  const env = { WAITLIST_DB: fakeD1("error"), ASSETS: fakeAssets() };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, failing: "WAITLIST_DB" });
});

test("a database that never answers is a 503, not a hung probe", async () => {
  // The bound is what stops a monitor's poll from outliving its own timeout,
  // which would read as "no data" rather than "down".
  const env = { WAITLIST_DB: fakeD1("hang"), ASSETS: fakeAssets() };
  const result = await checkHealth(env, { timeoutMs: 25 });
  assert.deepEqual(result, { ok: false, failing: "WAITLIST_DB" });
});

test("a missing asset layer is a 503 naming ASSETS", async () => {
  // The landing page is served by that binding on every non-API request, so
  // its absence is an outage and not a configuration nit.
  const response = await handleHealthRequest(GET(), { WAITLIST_DB: fakeD1("ok") });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, failing: "ASSETS" });
});

test("an asset layer that throws is a 503 naming ASSETS", async () => {
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    ASSETS: { fetch: () => Promise.reject(new Error("asset manifest missing")) },
  };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, failing: "ASSETS" });
});

test("every bound D1 database is checked, not just the first", async () => {
  // The binding list is read off env by shape, so a database added to
  // cloudflare.config.ts is checked the day it is added.
  const first = fakeD1("ok");
  const second = fakeD1("error");
  const env = {
    WAITLIST_DB: first,
    BILLING_DB: second,
    ASSETS: fakeAssets(),
  };
  const result = await checkHealth(env);
  assert.deepEqual(result, { ok: false, failing: "BILLING_DB" });
  assert.ok(first.calls.length > 0, "the healthy database was still checked");
  assert.ok(second.calls.length > 0, "the failing database was the one named");
});

test("d1Bindings finds the databases and ignores everything else", () => {
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
    EMAIL_SEND_TOKEN: "a-secret-value",
    MAIL_FROM: "drive@example.com",
  };
  assert.deepEqual(d1Bindings(env).map((b) => b.name), ["WAITLIST_DB"]);
});
// --- no secret or internal in the body -----------------------------------

test("no body carries a secret or an internal, healthy or not", async () => {
  const broken = {
    WAITLIST_DB: fakeD1("error"),
    ASSETS: fakeAssets(),
    EMAIL_SEND_TOKEN: "sk-a-real-looking-secret",
    MAIL_FROM: "drive@example.com",
  };
  for (const env of [HEALTHY_ENV(), broken]) {
    const response = await handleHealthRequest(GET(), env);
    const body = await response.text();
    for (const leak of [
      "sk-a-real-looking-secret",
      "sk-secret-value",
      "93c9f523-159c-4261-8541-d4c059906df3",
      "D1_ERROR",
      "connection to",
      "drive-waitlist",
      "Email Sending",
      "MAIL_FROM",
      "EMAIL_SEND_TOKEN",
      "Error",
      "at ",
      "drive.test",
    ]) {
      assert.ok(!body.includes(leak), `body leaked ${leak}: ${body}`);
    }
  }
});

test("the failing body is the name and nothing else", async () => {
  // A binding name is configuration the operator already has and is the one
  // thing that tells them where to look. A list of everything that failed, a
  // stack or a query would turn a public endpoint into an inventory.
  const response = await handleHealthRequest(GET(), {
    WAITLIST_DB: fakeD1("error"),
    ASSETS: fakeAssets(),
  });
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["failing", "ok"]);
  assert.equal(body.ok, false);
  assert.equal(typeof body.failing, "string");
});

// --- public allow-list ----------------------------------------------------

/**
 * The explicit public allow-list for this Worker's /api/* routes: the ones
 * that answer an anonymous request on purpose. It is a list, not a predicate,
 * so a route only becomes public by being written down here, and #73's
 * deny-by-default test can consume the same list when it lands. Anything not on
 * it must be gated on an account (or a deployment token, for the send route)
 * and must answer 401/403 to an anonymous caller, never 200.
 *
 * /api/health is public because the outside monitor (#36) holds no drive
 * account and an outage has to be observable to something that has none; the
 * route reads no account data, so being public exposes nothing.
 */
const PUBLIC_API_ROUTES = Object.freeze([
  "/api/waitlist",
  HEALTH_PATH,
]);

test("the endpoint needs no account, session or cookie", async () => {
  // Public by design and on the deny-by-default test's public allow-list
  // (#73): an outage monitor holds no drive account, and it must still get an
  // answer. It reads no account data to give it that.
  const response = await handleHealthRequest(
    new Request(`https://drive.test${HEALTH_PATH}`),
    HEALTHY_ENV(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("the health route is on the explicit public allow-list", async () => {
  // Issue #96 asks for the route to be on the deny-by-default test's public
  // allow-list (#73). That test is not on main yet and its branch is in
  // flight, so the list lives here until it lands; the assertion that matters
  // is checked either way: a route on the list answers an anonymous request,
  // and this one is on it.
  assert.ok(
    PUBLIC_API_ROUTES.includes(HEALTH_PATH),
    `${HEALTH_PATH} must be on the public allow-list`,
  );
  const response = await handleHealthRequest(
    new Request(`https://drive.test${HEALTH_PATH}`),
    HEALTHY_ENV(),
  );
  assert.equal(response.status, 200);
});

test("an account route is not on the public allow-list", () => {
  // The point of an explicit list: the account routes stay off it, so a
  // future deny-by-default test reading this list cannot accidentally treat
  // one of them as public.
  for (const accountRoute of [
    "/api/first-run-status",
    "/api/files",
    "/api/usage",
  ]) {
    assert.ok(
      !PUBLIC_API_ROUTES.includes(accountRoute),
      `${accountRoute} must not be public`,
    );
  }
});

test("the bound is a deadline shared by every dependency, not one per check", async () => {
  // The number the monitor's own timeout is set against is
  // HEALTH_TIMEOUT_MS, so three slow dependencies must not cost three times
  // it. Each hangs until its own signal aborts, and the whole check still
  // answers in one bound: the second and third never get their turn, and the
  // answer names the one that was still waiting.
  const hang = () => ({
    prepare: () => ({
      all: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    }),
  });
  const env = {
    FIRST_DB: hang(),
    SECOND_DB: hang(),
    THIRD_DB: hang(),
    ASSETS: fakeAssets(),
  };
  const started = Date.now();
  const result = await checkHealth(env, { timeoutMs: 60 });
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { ok: false, failing: "FIRST_DB" });
  assert.ok(elapsed < 600, `the check took ${elapsed}ms, more than the bound`);
});

test("a dependency that never got its turn is named, not reported as healthy", async () => {
  // The same case from the other end: when the deadline passes before a
  // dependency is reached, that dependency is the one that did not answer.
  // Answering 200 there would be a lie in the only direction that matters.
  let calls = 0;
  const env = {
    WAITLIST_DB: {
      prepare: () => ({
        all: () => {
          calls += 1;
          return new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("aborted")), 40);
          });
        },
      }),
    },
    LATER_DB: {
      prepare: () => {
        calls += 1;
        return { all: () => Promise.resolve({ results: [] }) };
      },
    },
    ASSETS: fakeAssets(),
  };
  const result = await checkHealth(env, { timeoutMs: 20 });
  assert.deepEqual(result, { ok: false, failing: "WAITLIST_DB" });
  assert.equal(calls, 1, "the second database was never reached");
});

test("only GET is answered, so a probe that posts learns it is wrong", async () => {
  for (const method of ["POST", "PUT", "DELETE", "HEAD", "PATCH"]) {
    const response = await handleHealthRequest(
      new Request(`https://drive.test${HEALTH_PATH}`, { method }),
      HEALTHY_ENV(),
    );
    assert.equal(response.status, 405, `${method} must not be answered`);
    assert.equal(response.headers.get("allow"), "GET");
  }
});

// --- the bound -----------------------------------------------------------

test("the check is bounded, so the probe cannot outlive its own timeout", () => {
  // A number, asserted rather than trusted: a bound that drifts to a minute
  // is a monitor that has already timed out by the time we hear about it.
  assert.ok(Number.isFinite(HEALTH_TIMEOUT_MS));
  assert.ok(
    HEALTH_TIMEOUT_MS > 0 && HEALTH_TIMEOUT_MS <= 5000,
    `HEALTH_TIMEOUT_MS is ${HEALTH_TIMEOUT_MS}, too long for a poll`,
  );
});

// --- routing -------------------------------------------------------------

test("the Worker routes the health path to the handler", async () => {
  // /api/* runs the Worker (runWorkerFirst in cloudflare.config.ts), so an
  // unrouted health path would fall through to the assets and answer 404 to
  // the monitor forever. Both spellings are checked, as the sibling routes do.
  const env = HEALTHY_ENV();
  for (const path of [HEALTH_PATH, `${HEALTH_PATH}/`]) {
    const response = await worker.fetch(new Request(`https://drive.test${path}`), env);
    assert.equal(response.status, 200, `${path} must reach the handler`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: true });
  }
  // A path that is not health is still the asset layer's, untouched.
  const asset = await worker.fetch(new Request("https://drive.test/get-started"), env);
  assert.equal(asset.status, 200);
});

test("the health check never spends a real caller's rate limit quota", async () => {
  // The limiter keys real callers on their client IP (src/waitlist.js). The
  // probe has to be checked somehow and `limit()` is the only call it has, so
  // the key is asserted to carry no IP: a health poll must not eat the quota
  // of the very sign-ups the limiter exists to protect.
  const keys = [];
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: {
      limit({ key }) {
        keys.push(key);
        return Promise.resolve({ success: true });
      },
    },
  };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 200);
  assert.equal(keys.length, 1, "the limiter is checked when it is bound");
  assert.match(keys[0], /^health-probe-/);
  assert.ok(!keys[0].includes("."), "the probe key must not be a client IP");
});

test("the probe key is not shared, so a hammered endpoint cannot force a false 503", async () => {
  // /api/health is public, so its limiter key has to change per call: a
  // stranger calling it in a loop must not exhaust one bucket and turn the
  // health answer red while everything else is fine.
  const keys = [];
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: {
      limit({ key }) {
        keys.push(key);
        return Promise.resolve({ success: true });
      },
    },
  };
  await handleHealthRequest(GET(), env);
  await handleHealthRequest(GET(), env);
  assert.notEqual(keys[0], keys[1], "each poll spends a bucket of its own");
});

test("a rate limiter that throws is a 503 naming it", async () => {
  // Without a limiter the waitlist endpoint fails closed (src/waitlist.js),
  // so this is a real outage the alert has to be able to report.
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: {
      limit: () => Promise.reject(new Error("limiter backend exploded: key=sk-secret")),
    },
  };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), {
    ok: false,
    failing: "WAITLIST_RATE_LIMITER",
  });
  assert.ok(!body.includes("exploded"), "the raw error text never reaches the body");
});

test("a limiter that denies the probe is still healthy", async () => {
  // The limiter answering "no" to the probe is the limiter working. Treating
  // it as unhealthy would be a false 503 on every poll that landed in an
  // exhausted bucket, which is exactly the alert noise this endpoint must not
  // produce.
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: {
      limit: () => Promise.resolve({ success: false }),
    },
  };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 200);
});
