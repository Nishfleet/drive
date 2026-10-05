// The health endpoint the outage alert watches (drive issue #96, north star
// "Reliable": we hear about an outage before customers do). `GET /api/health`
// answers one question honestly — can this Worker reach the things a request
// needs? — and nothing else: no account data, no configuration, no stack, no
// query text. The outside monitor (#36) polls it and alerts when the answer
// stops being yes, so a green here has to mean the drive can actually serve
// traffic, not that the isolate is merely alive.
//
// What "what it depends on" means here, and why the list is not the whole env:
//
//   - Every D1 database the Worker binds, found by reading the bindings on
//     `env` and asking which kind of binding each one is, so a database added
//     to cloudflare.config.ts is checked the day it is added. The trivial read
//     is the one statement D1 answers whatever the schema is, so a database
//     whose migrations are ahead of the Worker (still healthy) passes and an
//     unreachable one fails. Two databases today: the waitlist's, holding
//     only the sign-up table, and the customer drive's, holding the file
//     index, branches and agent caps (drive issue #170).
//     Asking which kind it is, rather than looking for one method, is what
//     makes that discovery safe (drive#144): every binding that is not a
//     database is a Fetcher, and a Fetcher answers a function to every
//     property name, so looking only for `prepare` collected the asset binding
//     as a database and every poll answered 503 {"failing":"ASSETS"} with a
//     DataCloneError in the log.
//
//   - The bindings named in REQUIRED_BINDINGS below, which discovery cannot
//     do: a binding the deploy lost is not on `env` at all, and a check that
//     only saw what was there would answer `ok` for a Worker that cannot
//     serve a page or accept a sign-up.
//
//   - The asset layer. A landing page that 500s while the API is fine is an
//     outage, and the asset binding is what serves it, so the check is a
//     fetch of the 404 path: it proves the asset Worker is reachable without
//     charging a Worker invocation for a page load and without asserting on
//     the content of a page that will change.
//
//   - The waitlist's rate limiter. Missing, the waitlist endpoint fails closed
//     (src/waitlist.js answers 503 rather than accept unbounded sign-ups), so
//     it is a binding the Worker needs to serve one of its requests. The
//     sign-in endpoint's two edge limits (drive issue #147) are the same
//     argument for the same reason: src/signin.js answers 503 without them
//     rather than mail an unbounded number of sign-in links, so a deploy that
//     lost either is an outage this endpoint names. It has no
//     read, so the check is the one callable operation, `limit()`, on a key
//     nothing else uses and that changes every call. Two things follow: a real
//     client key (a client IP) can never collide with the probe, and a
//     stranger hammering this public endpoint cannot exhaust a shared probe
//     key and push the endpoint into a false 503. The one name the result
//     reports is the binding, never the key. GET /s/<token> is the same
//     argument for the same reason (drive issue #506): src/share.js answers
//     503 without SHARE_DOWNLOAD_RATE_LIMITER rather than serve an unbounded
//     public download, so a deploy that lost it is an outage this endpoint
//     names.
//
//   - The branch snapshot namespace. A branch's snapshot moved out of the D1
//     row into KV (drive issue #252), so every diff and every approve reads this
//     namespace, and a namespace that cannot be read stops branches without any
//     other endpoint failing. The probe is a `get` on a key nothing writes —
//     branch snapshot keys are account-scoped (`snapshotKey` in
//     src/branches.js), so no customer key can collide with the probe and the
//     probe reveals nothing, because a missing key reads back null. The
//     question the check asks is only whether the binding answers, not whether
//     it holds anything.
//
// Deliberately NOT checked, because a false 503 pages a human for nothing:
//   - Secrets. Their presence is a deployment shape, not a reachability
//     question, and a value cannot be probed without risking disclosure.
//     A missing secret makes the one route that needs it answer 403/503 by
//     name already (src/email-send.js, src/waitlist.js).
//   - The email binding. Only the token-gated internal send route uses it
//     (src/email-send.js); no customer request needs it, and its only
//     operation would really send mail.
//
// The check is bounded once, with one deadline shared by every dependency, so
// a hung dependency cannot make the monitor's own poll hang (which would read
// as "no data" rather than "down") and cannot make it late: three slow
// dependencies still answer inside HEALTH_TIMEOUT_MS, not three times it.
// A dependency that does not answer in its share reports itself by name, so
// the alert says which dependency rather than "unhealthy".

/** The path the outside monitor (#36) polls. Public, and reads no account. */
export const HEALTH_PATH = "/api/health";

/**
 * How long the whole check gets, and so how much of that each dependency
 * gets: the checks share one deadline, so three slow dependencies still
 * answer in 2s, not 6s. A monitor that polls every few minutes needs an
 * answer well inside its own timeout, and a Worker that answers nothing is
 * worse than one that answers "down": the first loses the alert, the second
 * raises it.
 */
export const HEALTH_TIMEOUT_MS = 2000;

/**
 * The statement every check runs. D1 answers it whatever the schema is: it
 * reads no table, so it passes on a database whose migrations are ahead of
 * the Worker (still healthy) and fails on one that is unreachable or has no
 * database behind the binding. `SELECT 1` is the stock liveness probe; there
 * is nothing product-specific to ask.
 */
const LIVENESS_QUERY = "SELECT 1";

/**
 * The bindings this Worker needs to answer a customer request, by the names
 * cloudflare.config.ts declares. Auto-discovery (d1Bindings below) covers
 * "every bound database", but it cannot see a database that is not bound: a
 * deploy that lost WAITLIST_DB would otherwise answer `{"ok":true}` while
 * every sign-up 503s. This list is what makes that a 503 naming the binding.
 *
 * test/health.test.mjs reads cloudflare.config.ts and fails if a name here is
 * not declared there, so a rename in the config cannot silently leave this
 * list pointing at a binding that no longer exists.
 *
 * ASSETS is on the list because every page load goes through it. The rate
 * limiters are on it because the waitlist, the sign-in endpoint and the
 * public upload-request route fail closed without them (src/waitlist.js,
 * src/signin.js, src/share.js). METER_DB is on it because the
 * meter's event intake and the hourly rollup both fail closed without it
 * (src/meter.js), and a deploy that lost it would silently stop billing.
 * DRIVE_DB is on it because a deploy that lost it
 * would serve every page and sign-up while every file, search and branch
 * request failed, which is exactly the outage this endpoint exists to catch
 * (drive issue #170). The email binding is not: only the token-gated internal
 * send route uses it, no customer request needs it, and its one operation
 * would really send mail.
 */
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
  "BRANCH_RATE_LIMITER",
  "BRANCH_SNAPSHOTS",
]);

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  // The monitor must never be answered from a cache: a cached 200 during an
  // outage is exactly the false all-clear this endpoint exists to prevent.
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
    db
      .prepare(LIVENESS_QUERY)
      // AbortSignal.timeout is the runtime's own cancellation, so a query
      // that never returns is stopped at D1 rather than left running.
      .all({ signal: AbortSignal.timeout(timeoutMs) }),
    timeoutMs,
    name,
  );
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
    // A binding that resolves without a Response is not an asset layer.
    throw new Error("ASSETS.fetch did not return a Response");
  }
  // Drain the body so the runtime is not holding a connection open for a
  // probe nothing reads. A HEAD has none; a real asset layer may answer with
  // one, and cancelling it is a no-op when there is nothing to cancel.
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
  // A required binding that is not bound is the first thing named: the whole
  // point of the endpoint is that a deploy which cannot serve says so.
  for (const name of REQUIRED_BINDINGS) {
    if (env === null || env === undefined || env[name] === undefined) {
      return { ok: false, failing: name };
    }
  }
  const checks = /** @type {{name: string, run: (left: number) => Promise<void>}[]} */ ([]);
  for (const { name, db } of d1Bindings(env)) {
    checks.push({ name, run: (left) => checkD1(name, db, left) });
  }
  // The binding is read off the untyped env and checked by shape, exactly as
  // d1Bindings does: the cast is the check that was just made, not a default.
  const assets = env.ASSETS;
  if (
    typeof assets !== "object" ||
    assets === null ||
    !("fetch" in assets) ||
    typeof assets.fetch !== "function"
  ) {
    // The landing page is served by this binding on every request that is
    // not /api/*, so its absence is an outage, not a configuration nit: a
    // Worker that cannot serve the page cannot say the site is up.
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
    // The waitlist fails closed without this binding (src/waitlist.js), so a
    // binding that is present but has no `limit` is as broken as a missing
    // one and gets the same name.
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
  // The sign-in endpoint's two edge limits (drive issue #147) and the public
  // upload-request pair (drive issue #208), probed the same way: each route
  // fails closed without its bindings, so a deploy that lost one is an
  // outage, and a binding that is present but has no `limit` is as broken as a
  // missing one and gets the same name. The guard is written out rather than
  // trusting the REQUIRED_BINDINGS pass above, so a future edit that reorders
  // these checks cannot turn a missing binding into a TypeError.
  for (const name of [
    "SIGNIN_RATE_LIMITER",
    "SIGNIN_GLOBAL_RATE_LIMITER",
    "REQUEST_UPLOAD_RATE_LIMITER",
    "REQUEST_UPLOAD_LINK_RATE_LIMITER",
    "SHARE_DOWNLOAD_RATE_LIMITER",
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
  // The branch snapshot namespace (drive issue #252), guarded by shape for the
  // same reason as the limiters above: a binding that is present but is not a
  // namespace is as broken as a missing one, and both get the same name.
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
    // One deadline for the whole check, not one per dependency: a Worker
    // holding three slow dependencies still answers inside HEALTH_TIMEOUT_MS,
    // which is the number the monitor's own timeout is set against.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // The check that never got its turn is the one that did not answer.
      console.error("health: out of time before checking a dependency", check.name);
      return { ok: false, failing: check.name };
    }
    try {
      await check.run(remaining);
    } catch (error) {
      // The raw error is the operator's, and it goes to the log with the
      // binding's name attached; the response gets the name alone. Never the
      // message: a D1 error string can carry the query, an account id or a
      // host. Reporting the name the caller was running, not the error's own
      // text, is what makes the name trustworthy.
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
 * `{"ok":true}` or `{"ok":false,"failing":"<binding name>"}`. A binding name
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
  const result = await checkHealth(env);
  if (result.ok) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }
  return new Response(JSON.stringify({ ok: false, failing: result.failing }), {
    status: 503,
    headers: JSON_HEADERS,
  });
}
