import { replyToFor } from "../core/email-send.js";
import { storageVarsFromEnv } from "../core/files-memory.js";
import { meterFreshness } from "../core/meter-events.js";
import { clientIpKey, enforceEdgeLimits } from "../core/rate-limit.js";

export const HEALTH_PATH = "/api/health";

export const HEALTH_TIMEOUT_MS = 2000;

const LIVENESS_QUERY = "SELECT 1";

export const REQUIRED_BINDINGS = Object.freeze([
  "WAITLIST_DB",
  "METER_DB",
  "DRIVE_DB",
  "ASSETS",
  "WAITLIST_RATE_LIMITER",
  "SIGNIN_RATE_LIMITER",
  "SIGNIN_GLOBAL_RATE_LIMITER",
  "REQUEST_UPLOAD_RATE_LIMITER",
  "REQUEST_UPLOAD_LINK_RATE_LIMITER",
  "SHARE_DOWNLOAD_RATE_LIMITER",
  "SHARE_MINT_RATE_LIMITER",
  "REQUEST_MINT_RATE_LIMITER",
  "BRANCH_RATE_LIMITER",
  "BRANCH_SNAPSHOTS",
]);

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * Rejects with a named timeout if `work` has not settled within `ms`. The
 * work itself keeps a reference to its own signal so a D1 read can be
 * cancelled at the database rather than merely abandoned here.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} name
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, name) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new HealthCheckTimeout(name)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

class HealthCheckTimeout extends Error {
  /** @param {string} name */
  constructor(name) {
    super(`${name} did not answer in time`);
    this.name = "HealthCheckTimeout";
  }
}

/**
 * Whether a binding is a D1 database, which is a question about the kind of
 * binding and not about one method. drive#144: the live /api/health answered
 * 503 {"failing":"ASSETS"} on every poll, and the D1 read in checkD1 was the
 * code that threw `DataCloneError: AbortSignal serialization is not enabled`.
 *
 * The cause was that predicate asking only "is `prepare` a function". Every
 * binding that is not a database is a Fetcher (the static-assets binding, the
 * email binding, every service binding), and a Fetcher is an RPC stub: it
 * answers a function to every property name, `prepare` included, and to names
 * that do not exist at all. So ASSETS matched, was collected as a database,
 * and the check ran a D1 statement against the asset binding, which the
 * runtime refuses to carry across the stub.
 *
 * What separates the two is documented rather than guessed. A database is
 * `env.MY_DB.prepare(...)` with `batch`, `exec` and `withSession` beside it
 * and no `fetch` (https://developers.cloudflare.com/d1/worker-api/); a Fetcher
 * is `env.ASSETS.fetch(request)`
 * (https://developers.cloudflare.com/workers/static-assets/). A database
 * answers `undefined` to a name it does not have and a Fetcher answers a
 * function, so `prepare` here is "a database" and no `fetch` is "not a
 * Fetcher". Both halves are load-bearing: `prepare` alone matches a Fetcher,
 * and some other method would miss a database whose runtime moved that one.
 * @param {unknown} binding one value off `env`
 * @returns {binding is {prepare: (sql: string) => unknown}}
 */
function isDatabaseBinding(binding) {
  if (typeof binding !== "object" || binding === null) {
    return false;
  }
  const candidate = /** @type {{prepare?: unknown, fetch?: unknown}} */ (binding);
  return typeof candidate.prepare === "function" && typeof candidate.fetch !== "function";
}

/**
 * Every D1 database on this Worker, paired with the binding name that reached
 * it. Read from `env` by binding kind (isDatabaseBinding above) rather than from a
 * hand-kept list, so a binding added to cloudflare.config.ts is checked the
 * day it is added and cannot be forgotten here. A Fetcher is not a database
 * however it is spelled — the static-assets binding and the email binding
 * both answer `prepare` — so those are not discovered here, and the asset
 * layer is checked on its own terms instead (checkHealth fetches it; the email
 * binding deliberately is not, for the reason in this module's header).
 * @param {Record<string, unknown>} env
 * @returns {{name: string, db: {prepare: (sql: string) => {all: (options?: {signal?: AbortSignal}) => Promise<unknown>}}}[]}
 */
export function d1Bindings(env) {
  if (typeof env !== "object" || env === null) {
    return [];
  }
  return Object.entries(env)
    .filter(([, binding]) => isDatabaseBinding(binding))
    .map(([name, db]) => ({
      name,
      db: /** @type {{prepare: (sql: string) => {all: (options?: {signal?: AbortSignal}) => Promise<unknown>}}} */ (
        db
      ),
    }));
}

/**
 * One trivial read on a D1 database, bounded by the deadline's remaining
 * share. A rejected read is not swallowed: it becomes the failure this check
 * reports, with the binding's name and nothing else.
 * @param {string} name the binding name, safe to show an operator
 * @param {{prepare: (sql: string) => {all: (options?: {signal?: AbortSignal}) => Promise<unknown>}}} db
 *   the binding, once its `prepare` shape was checked. The `all` signature is
 *   spelled out rather than using the runtime's own `D1PreparedStatement`
 *   because that type's `all()` takes no options, while the platform and the
 *   test's fake both read the cancellation signal off this call: the type is
 *   narrower than the API, and saying what this call actually passes is
 *   truer than a cast around it.
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function checkD1(name, db, timeoutMs) {
  await withTimeout(
    db.prepare(LIVENESS_QUERY).all({ signal: AbortSignal.timeout(timeoutMs) }),
    timeoutMs,
    name,
  );
}

/**
 * The meter's watermark, read on the same share of the deadline the generic
 * database checks get (issue #520). A stale answer is a thrown error, not a
 * return value, so it lands in the same catch every other check reports
 * through: the log gets the reason, the response gets the name "meter" and
 * nothing else.
 * @param {{prepare: (sql: string) => {first: () => Promise<{rolled_through?: unknown, earliest?: unknown}>}}} db
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function checkMeterFreshness(db, timeoutMs) {
  const freshness = await withTimeout(meterFreshness(db), timeoutMs, "meter");
  if (freshness.stale) {
    throw new Error(`the meter is behind: ${freshness.detail}`);
  }
}

/**
 * The asset layer, fetched with a HEAD on a path the site does not serve.
 * HEAD is the cheap form: it proves the asset Worker answers without pulling
 * a document, and a 404 is the expected answer (nothing is served there), so
 * the check is "did we get a response at all", not "was it 200".
 * @param {{fetch: (request: Request) => Promise<Response>}} assets
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function checkAssets(assets, timeoutMs) {
  const response = await withTimeout(
    assets.fetch(
      new Request("https://drive-health.invalid/__health_probe__", {
        method: "HEAD",
      }),
    ),
    timeoutMs,
    "ASSETS",
  );
  if (!response) {
    throw new Error("ASSETS.fetch did not return a Response");
  }
  if (response.body) {
    await response.body.cancel();
  }
}

/**
 * A rate-limit binding, on a key of its own. The binding has no read,
 * so `limit()` is the only way to know it answers at all: without it the
 * endpoint behind it fails closed — sign-ups stop without the waitlist's
 * (src/waitlist.js), sign-in stops without sign-in's (src/signin.js) — and
 * that is an outage this endpoint must be able to report. The name is the
 * binding's, so a probe for one limiter never reports another's.
 *
 * The key changes every call and carries no client IP, for the reason above:
 * a health poll spends one unit of a bucket nobody else holds, so it cannot
 * eat a real client's quota, and a stranger hammering this public endpoint
 * cannot exhaust the probe's bucket and turn the health answer into a false
 * 503. Whether the limiter allows this call is not the question — the binding
 * answering at all is.
 *
 * @param {{limit: (options: {key: string}) => Promise<{success: boolean}>}} limiter
 * @param {number} timeoutMs
 * @param {string} name the binding's name, reported on failure
 * @returns {Promise<void>}
 */
async function checkRateLimiter(limiter, timeoutMs, name) {
  const result = await withTimeout(
    limiter.limit({ key: `health-probe-${crypto.randomUUID()}` }),
    timeoutMs,
    name,
  );
  if (!result || typeof result.success !== "boolean") {
    throw new Error("the rate limiter did not answer with a verdict");
  }
}

/**
 * The branch snapshot namespace (drive issue #252). The probe is one `get` on
 * a key nothing writes, so the check is a read: it cannot mutate the namespace,
 * it cannot spend a write quota, and it cannot disclose a customer's snapshot
 * because the key is not a customer key. A namespace that answers `null` has
 * proven it is reachable, which is the whole question.
 *
 * @param {{get: (key: string) => Promise<unknown>}} kv
 * @param {number} timeoutMs
 * @param {string} name the binding's name, reported on failure
 * @returns {Promise<void>}
 */
async function checkKv(kv, timeoutMs, name) {
  await withTimeout(kv.get("health-probe-branch-snapshots"), timeoutMs, name);
}

/**
 * Whether this deployment can send customer email at all (drive#522): a
 * MAIL_FROM that replyToFor, the reader every send goes through, accepts.
 * Unset, empty or malformed is "not-ready". The address never leaves here.
 * @param {Record<string, unknown>} env
 * @returns {"ready" | "not-ready"}
 */
export function emailReadiness(env) {
  const from = env?.MAIL_FROM;
  if (typeof from !== "string" || from.trim() === "") {
    return "not-ready";
  }
  try {
    replyToFor(from);
    return "ready";
  } catch {
    return "not-ready";
  }
}

/**
 * Runs every dependency check and reports the outcome as data, so a test can
 * read it and the fetch handler can render it without the two disagreeing.
 *
 * The result is `{ ok: true }` or `{ ok: false, failing: "<name>" }`: one
 * name, the first dependency that failed, whichever way it failed (a timeout
 * or a rejection). A single name is enough to act on and cannot enumerate the
 * deployment; a caller that wants the whole set reads the log, which gets the
 * real error.
 *
 * @param {Record<string, unknown>} env the Worker's bindings
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: true} | {ok: false, failing: string}>}
 */
export async function checkHealth(env, { timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (const name of REQUIRED_BINDINGS) {
    if (env === null || env === undefined || env[name] === undefined) {
      return { ok: false, failing: name };
    }
  }
  const storageEnv = /** @type {import("../core/files-memory.js").StorageEnv} */ (
    /** @type {unknown} */ (env)
  );
  if (storageVarsFromEnv(storageEnv).endpoint === undefined) {
    return { ok: false, failing: "storage" };
  }
  const checks = /** @type {{name: string, run: (left: number) => Promise<void>}[]} */ ([]);
  for (const { name, db } of d1Bindings(env)) {
    checks.push({ name, run: (left) => checkD1(name, db, left) });
  }
  const meterDb = env.METER_DB;
  if (isDatabaseBinding(meterDb)) {
    checks.push({
      name: "meter",
      run: (left) =>
        checkMeterFreshness(
          /** @type {{prepare: (sql: string) => {first: () => Promise<{rolled_through?: unknown, earliest?: unknown}>}}}} */ (
            meterDb
          ),
          left,
        ),
    });
  }
  const assets = env.ASSETS;
  if (
    typeof assets !== "object" ||
    assets === null ||
    !("fetch" in assets) ||
    typeof assets.fetch !== "function"
  ) {
    return { ok: false, failing: "ASSETS" };
  }
  checks.push({
    name: "ASSETS",
    run: (left) =>
      checkAssets(/** @type {{fetch: (request: Request) => Promise<Response>}} */ (assets), left),
  });
  const limiter = env.WAITLIST_RATE_LIMITER;
  if (
    typeof limiter !== "object" ||
    limiter === null ||
    !("limit" in limiter) ||
    typeof limiter.limit !== "function"
  ) {
    return { ok: false, failing: "WAITLIST_RATE_LIMITER" };
  }
  checks.push({
    name: "WAITLIST_RATE_LIMITER",
    run: (left) =>
      checkRateLimiter(
        /** @type {{limit: (options: {key: string}) => Promise<{success: boolean}>}} */ (limiter),
        left,
        "WAITLIST_RATE_LIMITER",
      ),
  });
  for (const name of [
    "SIGNIN_RATE_LIMITER",
    "SIGNIN_GLOBAL_RATE_LIMITER",
    "REQUEST_UPLOAD_RATE_LIMITER",
    "REQUEST_UPLOAD_LINK_RATE_LIMITER",
    "SHARE_DOWNLOAD_RATE_LIMITER",
    "SHARE_MINT_RATE_LIMITER",
    "REQUEST_MINT_RATE_LIMITER",
    "BRANCH_RATE_LIMITER",
  ]) {
    const bound = env[name];
    if (
      typeof bound !== "object" ||
      bound === null ||
      !("limit" in bound) ||
      typeof bound.limit !== "function"
    ) {
      return { ok: false, failing: name };
    }
    checks.push({
      name,
      run: (left) =>
        checkRateLimiter(
          /** @type {{limit: (options: {key: string}) => Promise<{success: boolean}>}} */ (bound),
          left,
          name,
        ),
    });
  }
  const snapshots = env.BRANCH_SNAPSHOTS;
  if (
    typeof snapshots !== "object" ||
    snapshots === null ||
    !("get" in snapshots) ||
    typeof snapshots.get !== "function"
  ) {
    return { ok: false, failing: "BRANCH_SNAPSHOTS" };
  }
  checks.push({
    name: "BRANCH_SNAPSHOTS",
    run: (left) =>
      checkKv(
        /** @type {{get: (key: string) => Promise<unknown>}} */ (snapshots),
        left,
        "BRANCH_SNAPSHOTS",
      ),
  });

  for (const check of checks) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.error("health: out of time before checking a dependency", check.name);
      return { ok: false, failing: check.name };
    }
    try {
      await check.run(remaining);
    } catch (error) {
      console.error("health: a dependency did not answer", check.name, error);
      return { ok: false, failing: check.name };
    }
  }
  return { ok: true };
}

/**
 * Handles every method on /api/health. Only GET answers; anything else is a
 * 405 naming the one method, like the waitlist and status endpoints, so a
 * probe that posts learns it is pointed at the wrong thing instead of
 * getting a 200 that means nothing.
 *
 * The body carries no secret, no query text, no stack and no account data:
 * `{"ok":true}` or `{"ok":false,"failing":"<binding name>"}`, plus
 * `"email":"not-ready"` when the deployment cannot send mail. A binding name
 * is configuration the operator already has, and it is the one thing that
 * tells them where to look.
 *
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @returns {Promise<Response>}
 */
export async function handleHealthRequest(request, env) {
  if (request.method !== "GET") {
    return new Response("Method not allowed. GET this endpoint for drive health.", {
      status: 405,
      headers: { allow: "GET", ...JSON_HEADERS },
    });
  }
  const limited = await enforceEdgeLimits(
    [
      {
        binding:
          /** @type {{limit(options: {key: string}): Promise<{success: boolean}>}|undefined} */ (
            env.HEALTH_RATE_LIMITER
          ),
        key: clientIpKey(request, "health"),
        name: "HEALTH_RATE_LIMITER",
      },
    ],
    "health",
  );
  if (limited) {
    return limited;
  }
  const result = await checkHealth(env);
  const email = emailReadiness(env) === "ready" ? {} : { email: "not-ready" };
  if (result.ok) {
    return new Response(JSON.stringify({ ok: true, ...email }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }
  return new Response(JSON.stringify({ ok: false, failing: result.failing, ...email }), {
    status: 503,
    headers: JSON_HEADERS,
  });
}
