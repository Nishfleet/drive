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

// --- public, and shaped for a monitor -------------------------------------

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

test("the health route does not consume rate limiter quota", async () => {
  // The limiter is a real binding on this Worker and the waitlist needs it.
  // Its only operation spends quota, so a check that called it would use the
  // budget it exists to protect; the check is a read, not a spend.
  const calls = [];
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: {
      limit(options) {
        calls.push(options);
        return Promise.resolve({ success: true });
      },
    },
  };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [], "the health check must not spend limiter quota");
});
