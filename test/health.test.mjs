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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  checkHealth,
  d1Bindings,
  emailReadiness,
  HEALTH_PATH,
  HEALTH_TIMEOUT_MS,
  handleHealthRequest,
  REQUIRED_BINDINGS,
} from "../src/health.js";
import worker from "../src/index.js";
import { failureMessage } from "../src/messages.js";

/** The ExportedHandler type makes fetch optional and declares the runtime's
 * three arguments. Tests drive the Worker directly, so one wrapper supplies
 * the no-op execution context the platform would and keeps those facts out
 * of every call site; `worker.fetch` is optional and carries the runtime's
 * strict Request generic, which a `new Request(...)` literal cannot express.
 * @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>}
 */
const workerFetch =
  /** @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );

/** One hour, for watermark arithmetic in the fakes and tests below. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * The watermark an hourly rollup that just ran leaves behind: the hour before
 * the current one (the last closed hour), as epoch milliseconds. Fresh for
 * however long a test takes, because a run is overdue only hours later.
 */
const freshWatermark = () => Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS;

/** The storage endpoint a healthy deployment carries (issue #520). */
const STORAGE_ENDPOINT = "https://s3.eu-central-3.idrivee2.com";

/** The sender a deployment that can send mail carries (drive#522). */
const SENDER = "drive@example.com";

/**
 * A D1Database stub answering only what the check uses. `mode` decides how
 * the trivial read resolves, so one fake covers healthy, broken and hung.
 */
/** @param {"ok"|"error"|"hang"} [mode] */
function fakeD1(mode = "ok") {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    /** @param {string} sql */
    prepare(sql) {
      calls.push(sql);
      return {
        /** @param {{signal?: AbortSignal}} [options] */
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
            return new Promise((_resolve, reject) => {
              options.signal?.addEventListener("abort", () => {
                reject(new Error("The operation was aborted."));
              });
            });
          }
          return Promise.resolve({ results: [{ 1: 1 }] });
        },
        // The meter's freshness read (issue #520) goes through first(): one
        // row, or a rejection mirroring the mode. The healthy answer is a
        // fresh watermark and no earliest-version row, the shape a rolling
        // meter leaves behind.
        first() {
          if (mode === "error") {
            return Promise.reject(
              new Error(
                "D1_ERROR: connection to 93c9f523-159c-4261-8541-d4c059906df3 failed: token=sk-secret-value",
              ),
            );
          }
          if (mode === "hang") {
            return new Promise(() => {});
          }
          return Promise.resolve({ rolled_through: freshWatermark() });
        },
      };
    },
  };
}

/**
 * A D1 database that answers the trivial read and hands back one fixed row to
 * `first()` — the shape the meter's freshness read sees. Tests that pin the
 * staleness decision build their row here.
 * @param {{rolled_through?: unknown, earliest?: unknown}} row
 */
function d1Answering(row) {
  const db = fakeD1("ok");
  const base = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = base(sql);
    statement.first = () => Promise.resolve(row);
    return statement;
  };
  return db;
}

/**
 * A static-assets stub: a served path is a 200 and the path the probe asks
 * for is a 404, exactly as the runtime answers them. The check only needs a
 * response of any kind, so the 404 is the expected answer there.
 */
function fakeAssets() {
  /** @type {Request[]} */
  const requests = [];
  return {
    requests,
    /** @param {Request} request */
    async fetch(request) {
      requests.push(request);
      return request.url.includes("__health_probe__")
        ? new Response(null, { status: 404 })
        : new Response("asset", { status: 200 });
    },
  };
}

/**
 * A static-assets binding shaped the way the runtime actually shapes it.
 * drive#144: the live /api/health answered 503 {"failing":"ASSETS"} on every
 * poll, with `DataCloneError: AbortSignal serialization is not enabled` in the
 * tail, and the health check's own D1 read was the code that threw.
 *
 * The reason is the shape of a Fetcher, which is what every binding that is
 * not a database is (the static-assets binding, the email binding, every
 * service binding): it is an RPC stub, so it answers a function to *every*
 * property name. The static-assets binding answers a function to `prepare`
 * exactly as a database does, so a check that asks only "is prepare a
 * function" cannot tell ASSETS from WAITLIST_DB — and then runs a D1
 * statement against the asset binding, which the runtime refuses to carry
 * across the stub. What does work on a Fetcher is `fetch`, which is the only
 * real call on it.
 *
 * So this fake refuses every call that is not the assets fetch, the way the
 * real binding does, and a test that pins the health answer is pinned against
 * the real shape rather than against a plain object that happens to carry a
 * `prepare`.
 */
function fakeFetcher(assets = fakeAssets()) {
  return new Proxy(assets, {
    /**
     * @param {object} target
     * @param {string | symbol} property
     */
    get(target, property) {
      // `fetch` and the recorded requests are the real asset layer; anything
      // else is the stub answering a function, which is what caught the bug.
      if (property in target) {
        return Reflect.get(target, property);
      }
      // A thenable would be awaited by anything that wraps the binding, and
      // this stub is not one.
      if (property === "then") {
        return undefined;
      }
      return function rpcStub() {
        return Promise.reject(
          new DOMException("AbortSignal serialization is not enabled.", "DataCloneError"),
        );
      };
    },
  });
}

/** A rate limiter stub whose whole contract is limit({ key }) -> { success }. */
function fakeLimiter() {
  return {
    limit: () => Promise.resolve({ success: true }),
  };
}

/**
 * The branch snapshot namespace as a healthy deploy binds it (drive issue
 * #252): a `get` that answers null, which is what a read of a key nothing
 * writes answers.
 * @returns {{get: (key: string) => Promise<null>}}
 */
function fakeKv() {
  return {
    get: () => Promise.resolve(null),
  };
}

/**
 * The bindings a healthy deploy has, by the names cloudflare.config.ts
 * declares. A test that wants an unhealthy Worker drops or breaks one of
 * these, so every test starts from the real shape.
 * @returns {Record<string, unknown>}
 */
const HEALTHY_ENV = () => ({
  WAITLIST_DB: fakeD1("ok"),
  METER_DB: fakeD1("ok"),
  DRIVE_DB: fakeD1("ok"),
  ASSETS: fakeAssets(),
  WAITLIST_RATE_LIMITER: fakeLimiter(),
  // The sign-in endpoint's two edge limits (drive issue #147): the route fails
  // closed without either, so a healthy deploy is one with both bound.
  SIGNIN_RATE_LIMITER: fakeLimiter(),
  SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
  REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
  REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
  HEALTH_RATE_LIMITER: fakeLimiter(),
  SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
  SHARE_MINT_RATE_LIMITER: fakeLimiter(),
  REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
  BRANCH_SNAPSHOTS: fakeKv(),
  // The storage vars a healthy deployment carries (issue #520): without an
  // endpoint the Files handlers answer from the in-memory store, and the
  // health answer names that instead of saying ok.
  IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
  // A sender (drive#522): without one the answer carries "email":"not-ready".
  MAIL_FROM: SENDER,
});

const GET = (path = HEALTH_PATH) => new Request(`https://drive.test${path}`, { method: "GET" });

// --- the healthy answer ---------------------------------------------------

test('a healthy Worker answers 200 with {"ok":true}', async () => {
  const response = await handleHealthRequest(GET(), HEALTHY_ENV());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("the health answer is never cached", async () => {
  // A monitor that is handed a cached 200 during an outage is worse than no
  // monitor: it says all clear while the site is down.
  const response = await handleHealthRequest(GET(), HEALTHY_ENV());
  assert.equal(response.headers.get("cache-control"), "no-store");
  const type = response.headers.get("content-type");
  assert.ok(type);
  assert.match(type, /^application\/json/);
});

// --- the failing answer names the part -----------------------------------

test("a database that cannot answer is a 503 naming that binding", async () => {
  const env = {
    WAITLIST_DB: fakeD1("error"),
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
  };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, failing: "WAITLIST_DB" });
});

test("a database that never answers is a 503, not a hung probe", async () => {
  // The bound is what stops a monitor's poll from outliving its own timeout,
  // which would read as "no data" rather than "down".
  const env = {
    WAITLIST_DB: fakeD1("hang"),
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
  };
  const result = await checkHealth(env, { timeoutMs: 25 });
  assert.deepEqual(result, { ok: false, failing: "WAITLIST_DB" });
});

test("a missing asset layer is a 503 naming ASSETS", async () => {
  // The landing page is served by that binding on every non-API request, so
  // its absence is an outage and not a configuration nit.
  const response = await handleHealthRequest(GET(), {
    WAITLIST_DB: fakeD1("ok"),
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    MAIL_FROM: SENDER,
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, failing: "ASSETS" });
});

test("an asset layer that throws is a 503 naming ASSETS", async () => {
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: { fetch: () => Promise.reject(new Error("asset manifest missing")) },
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
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
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    BILLING_DB: second,
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
  };
  const result = await checkHealth(env);
  assert.deepEqual(result, { ok: false, failing: "BILLING_DB" });
  assert.ok(first.calls.length > 0, "the healthy database was still checked");
  assert.ok(second.calls.length > 0, "the failing database was the one named");
});

test("d1Bindings finds the databases and ignores everything else", () => {
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
    EMAIL_SEND_TOKEN: "a-secret-value",
    MAIL_FROM: "drive@example.com",
  };
  assert.deepEqual(
    d1Bindings(env).map((b) => b.name),
    ["WAITLIST_DB", "DRIVE_DB"],
  );
});

test("a binding that is not a database is never read as one", () => {
  // drive#144, the live failure: ASSETS and EMAIL are Fetchers, and a Fetcher
  // answers a function to every property name, so `prepare` alone mistook
  // both for databases. The health check then ran a D1 statement against the
  // asset binding, which the runtime refuses to carry, and /api/health
  // answered 503 {"failing":"ASSETS"} on every poll. A database is the one
  // binding kind with `prepare` and no `fetch`, so both tests are asked here.
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: fakeFetcher(),
    EMAIL: fakeFetcher(),
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
  };
  assert.deepEqual(
    d1Bindings(env).map((b) => b.name),
    ["WAITLIST_DB", "DRIVE_DB"],
  );
});

test("a health poll over the real binding shapes answers ok, not ASSETS", async () => {
  // The same case end to end, and the shape that actually failed in
  // production: the fetcher-shaped bindings answer every call the way the
  // runtime does, so a check that read one of them as a database fails here
  // exactly as it did live. The answer has to be the healthy one.
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: fakeFetcher(),
    EMAIL: fakeFetcher(),
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
  };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("the asset probe is a HEAD on a path the site does not serve", async () => {
  // The probe's own shape, pinned so a future edit cannot quietly turn it into
  // something the asset binding refuses to answer: one request, HEAD (the
  // cheap form), the probe path (nothing is served there, so the 404 the fake
  // answers is the expected one) and no body.
  const assets = fakeAssets();
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: assets,
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
  };
  assert.deepEqual(await checkHealth(env), { ok: true });
  assert.equal(assets.requests.length, 1, "the asset layer is checked once");
  const [probe] = assets.requests;
  assert.equal(probe.method, "HEAD");
  assert.match(probe.url, /^https:\/\/drive-health\.invalid\/__health_probe__$/);
  assert.equal(probe.body, null, "the probe carries no body");
});
// --- no secret or internal in the body -----------------------------------

test("no body carries a secret or an internal, healthy or not", async () => {
  const broken = {
    WAITLIST_DB: fakeD1("error"),
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
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
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    MAIL_FROM: SENDER,
  });
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["failing", "ok"]);
  assert.equal(body.ok, false);
  assert.equal(typeof body.failing, "string");
});

// --- public by design -----------------------------------------------------

test("the endpoint needs no account, session or cookie", async () => {
  // /api/health is public because the outside monitor (#36) holds no drive
  // account and an outage has to be observable to something that has none; the
  // route reads no account data, so being public exposes nothing. The single
  // public allow-list lives in test/account-gate.test.mjs (#73), which walks
  // this route as public and is the one place a route becomes an exemption.
  const response = await handleHealthRequest(
    new Request(`https://drive.test${HEALTH_PATH}`),
    HEALTHY_ENV(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("the bound is a deadline shared by every dependency, not one per check", async () => {
  // The number the monitor's own timeout is set against is
  // HEALTH_TIMEOUT_MS, so three slow dependencies must not cost three times
  // it. Each hangs until its own signal aborts, and the whole check still
  // answers in one bound: the second and third never get their turn, and the
  // answer names the one that was still waiting.
  const hang = () => ({
    prepare: () => ({
      /** @param {{signal?: AbortSignal}} [options] */
      all({ signal } = {}) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    }),
  });
  const env = {
    WAITLIST_DB: hang(),
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    SECOND_DB: hang(),
    THIRD_DB: hang(),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
  };
  const started = Date.now();
  const result = await checkHealth(env, { timeoutMs: 60 });
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { ok: false, failing: "WAITLIST_DB" });
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
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    LATER_DB: {
      prepare: () => {
        calls += 1;
        return { all: () => Promise.resolve({ results: [] }) };
      },
    },
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
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
    const response = await workerFetch(new Request(`https://drive.test${path}`), env);
    assert.equal(response.status, 200, `${path} must reach the handler`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: true });
  }
  // A path that is not health is still the asset layer's, untouched.
  const asset = await workerFetch(new Request("https://drive.test/get-started"), env);
  assert.equal(asset.status, 200);
});

test("health answers 429 past its limit without probing bindings", async () => {
  const env = HEALTHY_ENV();
  env.HEALTH_RATE_LIMITER = { limit: () => Promise.resolve({ success: false }) };
  const db = /** @type {{calls: string[]}} */ (env.WAITLIST_DB);
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: failureMessage("rate-limited") });
  assert.equal(db.calls.length, 0, "a refused poll must not run the liveness query");
});

test("health fails closed, not open, when its limiter is missing", async () => {
  // The limiter is an operator binding like every other one. If it is absent
  // the probe refuses with the generic 503 rather than answering a live check
  // to an unrate-limited endpoint, and it does not run the liveness query
  // either (drive#539).
  const env = HEALTHY_ENV();
  env.HEALTH_RATE_LIMITER = undefined;
  const db = /** @type {{calls: string[]}} */ (env.WAITLIST_DB);
  const original = console.error;
  console.error = () => {};
  let response;
  try {
    response = await handleHealthRequest(GET(), env);
  } finally {
    console.error = original;
  }
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: failureMessage("unexpected") });
  assert.equal(db.calls.length, 0, "a refused poll must not run the liveness query");
});

test("the health check never spends a real caller's rate limit quota", async () => {
  // The limiter keys real callers on their client IP (src/waitlist.js). The
  // probe has to be checked somehow and `limit()` is the only call it has, so
  // the key is asserted to carry no IP: a health poll must not eat the quota
  // of the very sign-ups the limiter exists to protect.
  /** @type {string[]} */
  const keys = [];
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: {
      /** @param {{key: string}} options */
      limit({ key }) {
        keys.push(key);
        return Promise.resolve({ success: true });
      },
    },
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
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
  /** @type {string[]} */
  const keys = [];
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: {
      /** @param {{key: string}} options */
      limit({ key }) {
        keys.push(key);
        return Promise.resolve({ success: true });
      },
    },
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
  };
  await handleHealthRequest(GET(), env);
  await handleHealthRequest(GET(), env);
  assert.notEqual(keys[0], keys[1], "each poll spends a bucket of its own");
});

test("a binding that is not bound at all is a 503 naming it", async () => {
  // Auto-discovery reads what is on env, so it cannot see a binding the
  // deployment lost. A deploy without WAITLIST_DB answers 503 on every
  // sign-up, so the health answer has to be 503 too, not the `ok` a
  // discovery-only check would report.
  for (const missing of REQUIRED_BINDINGS) {
    const env = HEALTHY_ENV();
    delete env[missing];
    const response = await handleHealthRequest(GET(), env);
    assert.equal(response.status, 503, `${missing} missing must be a 503`);
    assert.deepEqual(await response.json(), { ok: false, failing: missing });
  }
});

test("the required bindings are the ones cloudflare.config.ts declares", () => {
  // A renamed or deleted binding in the config would leave this list pointing
  // at nothing, and the check would report a name no operator can act on. The
  // config is the source of truth, so the test reads its binding keys.
  const config = readFileSync(new URL("../cloudflare.config.ts", import.meta.url), "utf8");
  const declared = [...config.matchAll(/(\w+): bindings\./g)].map((m) => m[1]);
  for (const name of REQUIRED_BINDINGS) {
    assert.ok(
      declared.includes(name),
      `REQUIRED_BINDINGS names ${name}, which cloudflare.config.ts does not declare`,
    );
  }
  // The other direction: a binding in the config that the health check does
  // not know about is a gap the alert would not cover. Documented exceptions
  // (src/health.js), and the count is derived from them rather than written
  // down, so adding one needs a reason in that module and nothing else: the
  // email binding can only be exercised by really sending mail (only the
  // token-gated internal send route uses it), the meter's event token is a
  // secret no probe can exercise without a storage event to feed it, whose
  // absence fails closed at the intake (src/meter.js) instead of at the probe.
  const NOT_CHECKED = new Set(["EMAIL", "METER_EVENT_TOKEN", "HEALTH_RATE_LIMITER"]);
  const exceptions = declared.filter((name) => NOT_CHECKED.has(name));
  assert.equal(
    declared.length,
    REQUIRED_BINDINGS.length + exceptions.length,
    `expected ${REQUIRED_BINDINGS.length + exceptions.length} bindings, found ${declared.join(", ")}`,
  );
  for (const name of declared) {
    if (NOT_CHECKED.has(name)) {
      assert.ok(
        !REQUIRED_BINDINGS.includes(name),
        `${name} must stay off the required list, with its reason in src/health.js`,
      );
      continue;
    }
    assert.ok(
      REQUIRED_BINDINGS.includes(name),
      `cloudflare.config.ts declares ${name} and the health check does not check it`,
    );
  }
});

test("a rate limiter that throws is a 503 naming it", async () => {
  // Without a limiter the waitlist endpoint fails closed (src/waitlist.js),
  // so this is a real outage the alert has to be able to report.
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: {
      limit: () => Promise.reject(new Error("limiter backend exploded: key=sk-secret")),
    },
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
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
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: {
      limit: () => Promise.resolve({ success: false }),
    },
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
  };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 200);
});

// --- the branch snapshot namespace (drive issue #252) ---------------------

test("a branch snapshot namespace that cannot be read is a 503 naming it", async () => {
  // Every branch diff and every approve reads the namespace (src/branches.js
  // readSnapshot), so a namespace that throws stops branches while every other
  // route keeps answering 200. That is exactly the silent outage this
  // endpoint exists to name, so the probe is a read and a read that throws
  // must be the reported failure.
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: {
      get: () => Promise.reject(new Error("kv backend exploded: token=sk-secret")),
    },
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
  };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { ok: false, failing: "BRANCH_SNAPSHOTS" });
  assert.ok(!body.includes("exploded"), "the raw error text never reaches the body");
  assert.ok(!body.includes("sk-secret"), "no secret from the error reaches the body");
});

test("a namespace that answers null for the probe key is healthy", async () => {
  // The probe reads a key nothing writes, so `null` is the healthy answer and
  // the only thing it proves is that the namespace answers. Treating a null as
  // unhealthy would be a false 503 on every poll, forever, because that is
  // what an empty namespace reads back.
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: fakeKv(),
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
  };
  assert.equal((await handleHealthRequest(GET(), env)).status, 200);
});

test("the probe never reads a customer snapshot key", async () => {
  // The probe key is not account-scoped, so it cannot collide with a branch's
  // own key (snapshotKey in src/branches.js prefixes every real key with the
  // account) and cannot read a customer's bytes. This pins the key the probe
  // uses, because that is the whole privacy argument for probing a store that
  // holds customer data.
  /** @type {string[]} */
  const reads = [];
  const env = {
    WAITLIST_DB: fakeD1("ok"),
    METER_DB: fakeD1("ok"),
    DRIVE_DB: fakeD1("ok"),
    ASSETS: fakeAssets(),
    WAITLIST_RATE_LIMITER: fakeLimiter(),
    SIGNIN_RATE_LIMITER: fakeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: fakeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: fakeLimiter(),
    HEALTH_RATE_LIMITER: fakeLimiter(),
    SHARE_DOWNLOAD_RATE_LIMITER: fakeLimiter(),
    SHARE_MINT_RATE_LIMITER: fakeLimiter(),
    REQUEST_MINT_RATE_LIMITER: fakeLimiter(),
    BRANCH_SNAPSHOTS: {
      /** @param {string} key */
      get: (key) => {
        reads.push(key);
        return Promise.resolve(null);
      },
    },
    IDRIVE_S3_ENDPOINT: STORAGE_ENDPOINT,
    MAIL_FROM: SENDER,
  };
  await handleHealthRequest(GET(), env);
  assert.deepEqual(reads, ["health-probe-branch-snapshots"], "one read, of the probe key only");
});

// --- the sign-in endpoint's two edge limits (drive issue #147) -------------

test("the sign-in edge limits are required bindings, so a deploy that lost one is named", async () => {
  // src/signin.js answers 503 without either binding rather than mail an
  // unbounded number of links, so a deploy that lost one is an outage this
  // endpoint must report by name — the same rule the waitlist's limiter has.
  for (const name of ["SIGNIN_RATE_LIMITER", "SIGNIN_GLOBAL_RATE_LIMITER"]) {
    assert.ok(REQUIRED_BINDINGS.includes(name), `${name} must be a required binding`);
    const env = HEALTHY_ENV();
    delete env[name];
    const response = await handleHealthRequest(GET(), env);
    assert.equal(response.status, 503, `${name} missing must be a 503`);
    assert.deepEqual(await response.json(), { ok: false, failing: name });
  }
});

test("either sign-in limiter that throws is a 503 naming that one, not the other", async () => {
  // The probe carries the binding's own name, so the alert says which of the
  // two to look at rather than a shared label.
  for (const name of ["SIGNIN_RATE_LIMITER", "SIGNIN_GLOBAL_RATE_LIMITER"]) {
    const env = HEALTHY_ENV();
    env[name] = {
      limit: () => Promise.reject(new Error("limiter backend exploded: key=sk-secret")),
    };
    const response = await handleHealthRequest(GET(), env);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { ok: false, failing: name });
    assert.ok(!body.includes("exploded"), "the raw error text never reaches the body");
  }
});

test("each sign-in limiter is probed on a key of its own, never a client IP", async () => {
  // The probe must not spend a real caller's quota (the same rule the
  // waitlist's limiter probe follows), and each binding's key changes per call.
  /** @type {{SIGNIN_RATE_LIMITER: string[], SIGNIN_GLOBAL_RATE_LIMITER: string[]}} */
  const keys = { SIGNIN_RATE_LIMITER: [], SIGNIN_GLOBAL_RATE_LIMITER: [] };
  /**
   * @param {keyof typeof keys} name
   */
  const make = (name) => ({
    /** @param {{key: string}} options */
    limit({ key }) {
      keys[name].push(key);
      return Promise.resolve({ success: true });
    },
  });
  const env = HEALTHY_ENV();
  env.SIGNIN_RATE_LIMITER = make("SIGNIN_RATE_LIMITER");
  env.SIGNIN_GLOBAL_RATE_LIMITER = make("SIGNIN_GLOBAL_RATE_LIMITER");
  const first = await handleHealthRequest(GET(), env);
  const second = await handleHealthRequest(GET(), env);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  /** @type {Array<keyof typeof keys>} */
  const names = ["SIGNIN_RATE_LIMITER", "SIGNIN_GLOBAL_RATE_LIMITER"];
  for (const name of names) {
    assert.equal(keys[name].length, 2, `${name} is probed once per poll`);
    assert.match(keys[name][0], /^health-probe-/);
    assert.ok(!keys[name][0].includes("."), `${name}'s probe key must not be a client IP`);
    assert.notEqual(keys[name][0], keys[name][1], "each poll spends a bucket of its own");
  }
});

// --- the meter's watermark (drive issue #520) -----------------------------

test("a meter hours behind is a 503 naming meter", async () => {
  // The meter's cron can die while every request path stays green — billing
  // is a cron's job, not a request's — so the health answer carries the one
  // read that notices: the watermark. Nine hours behind the last closed hour
  // is far past METER_STALE_AFTER_HOURS (3), and no single missed run gets
  // there.
  const env = {
    ...HEALTHY_ENV(),
    METER_DB: d1Answering({ rolled_through: Date.now() - 9 * HOUR_MS }),
  };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, failing: "meter" });
});

test("versions with no watermark is a 503 naming meter", async () => {
  // A lost mark is worse than a late one: without it no one can say what the
  // meter billed, so the next run's floor read would silently re-bill from
  // the very first version. Red, by name.
  const env = {
    ...HEALTHY_ENV(),
    METER_DB: d1Answering({ earliest: Date.now() - 5 * HOUR_MS }),
  };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, failing: "meter" });
});

test("a fresh install answers ok even though nothing has ever rolled", async () => {
  // No watermark and no versions is the state of every new deployment, not a
  // failure: there is nothing to bill and no mark to be behind. This pins the
  // distinction against the deployment that has versions but lost the mark.
  const env = {
    ...HEALTHY_ENV(),
    METER_DB: d1Answering({ rolled_through: null, earliest: null }),
  };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("a watermark a little behind is healthy, because one missed run is made up", async () => {
  // Two hours behind the last closed hour is the worst a single missed
  // trigger leaves behind (the next run drains it); paging a human for that
  // would make the alarm noise, not signal.
  const env = {
    ...HEALTHY_ENV(),
    METER_DB: d1Answering({ rolled_through: Date.now() - 2 * HOUR_MS }),
  };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("a meter read that throws keeps the binding's name, METER_DB", async () => {
  // The freshness read rides the same binding the generic database check
  // liveness-tests. A binding that cannot answer at all is reported by the
  // generic check's name — "meter" is reserved for an answer that says the
  // job itself is behind.
  const env = {
    ...HEALTHY_ENV(),
    METER_DB: {
      prepare: () => ({
        all: () => Promise.reject(new Error("D1_ERROR: no such table: meter_rollup_state")),
        first: () => Promise.reject(new Error("D1_ERROR: no such table: meter_rollup_state")),
      }),
    },
  };
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, failing: "METER_DB" });
});

test("the freshness read is one D1 round trip on the meter binding", async () => {
  // One statement, two subqueries: the watermark beside the oldest version.
  // The check runs on every poll (the outside monitor's budget), so it stays
  // a single read.
  const meterDb = fakeD1("ok");
  const env = { ...HEALTHY_ENV(), METER_DB: meterDb };
  await handleHealthRequest(GET(), env);
  const fresh = meterDb.calls.filter((sql) => sql.includes("rolled_through"));
  assert.equal(fresh.length, 1, `one freshness read, got ${fresh.length}`);
  assert.match(fresh[0] ?? "", /meter_rollup_state/);
  assert.match(fresh[0] ?? "", /file_versions/);
});

// --- the storage endpoint (drive issue #520) ------------------------------

test("no storage endpoint is a 503 naming storage", async () => {
  // With no S3 endpoint among the per-deployment vars, the Files handlers
  // answer from the in-memory store: a drive that forgets everything on
  // redeploy, behind pages that all render. The health answer must name it,
  // not say ok.
  const env = HEALTHY_ENV();
  delete env.IDRIVE_S3_ENDPOINT;
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, failing: "storage" });
});

test("the storage check answers without a network call", async () => {
  // The endpoint's presence is a question about configuration, not about
  // reachability — the S3 store's own request path is what surfaces an
  // unreachable endpoint on every file read. So the check is synchronous and
  // costs no probe on the shared deadline.
  const env = HEALTHY_ENV();
  delete env.IDRIVE_S3_ENDPOINT;
  const start = Date.now();
  const response = await handleHealthRequest(GET(), env);
  assert.ok(Date.now() - start < 500, "the answer is immediate");
  assert.deepEqual(await response.json(), { ok: false, failing: "storage" });
});

// --- the email part (drive#522) --------------------------------------------
//
// Until launch a missing sender only warns on the deploy (drive#752), so the
// health answer is where it stays visible. It rides beside the verdict and
// never turns it: the deploy smoke rolls back on any answer that is not ok.

test("no sender is ok, with the email part reported not-ready", async () => {
  for (const sender of [undefined, "", "   ", "drive", "drive@localhost", "@example.com"]) {
    const env = HEALTHY_ENV();
    if (sender === undefined) {
      delete env.MAIL_FROM;
    } else {
      env.MAIL_FROM = sender;
    }
    const response = await handleHealthRequest(GET(), env);
    assert.equal(response.status, 200, `sender ${JSON.stringify(sender)} is not an outage`);
    assert.deepEqual(await response.json(), { ok: true, email: "not-ready" });
  }
});

test("a usable sender adds nothing to the answer", async () => {
  const response = await handleHealthRequest(GET(), HEALTHY_ENV());
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(emailReadiness({ MAIL_FROM: SENDER }), "ready");
});

test("a failing answer still reports the email part, and never the address", async () => {
  const env = HEALTHY_ENV();
  env.MAIL_FROM = "not-an-address";
  delete env.WAITLIST_DB;
  const response = await handleHealthRequest(GET(), env);
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { ok: false, failing: "WAITLIST_DB", email: "not-ready" });
  assert.ok(!body.includes("not-an-address"), "the address never leaves the Worker");
});
