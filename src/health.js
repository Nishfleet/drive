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
//   - Every D1 database the Worker binds. The trivial read is the one
//     statement D1 always answers even on an empty table, so a broken or
//     missing migration and an unreachable database both fail it. The
//     waitlist is the site's only store today; when the meter's tables land
//     the same rule picks them up with no change here, because the checks are
//     derived from the bindings on `env` rather than from a hand-kept list.
//
//   - The asset layer. A landing page that 500s while the API is fine is an
//     outage, and the asset binding is what serves it, so the check is a
//     fetch of the 404 path: it proves the asset Worker is reachable without
//     charging a Worker invocation for a page load and without asserting on
//     the content of a page that will change.
//
//   - The waitlist's rate limiter. Missing, the waitlist endpoint fails closed
//     (src/waitlist.js answers 503 rather than accept unbounded sign-ups), so
//     it is a binding the Worker needs to serve one of its requests. It has no
//     read, so the check is the one callable operation, `limit()`, on a key
//     nothing else uses and that changes every call. Two things follow: a real
//     client key (a client IP) can never collide with the probe, and a
//     stranger hammering this public endpoint cannot exhaust a shared probe
//     key and push the endpoint into a false 503. The one name the result
//     reports is the binding, never the key.
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
// The check is bounded twice so a hung dependency cannot make the monitor's
// own poll hang, which would read as "no data" rather than "down":
// AbortSignal.timeout on each database read (the runtime stops the query) and
// a wall-clock race over the whole check (a dependency that ignores its
// signal cannot outlive the answer). Either path reports the part that did not
// answer, so the alert says which dependency rather than "unhealthy".

/** The path the outside monitor (#36) polls, and this Worker's only route. */
export const HEALTH_PATH = "/api/health";

/**
 * How long one dependency gets to answer, and how long the whole check gets.
 * The per-read bound is the D1 query's own AbortSignal; the overall bound is
 * the race. A monitor that polls every few minutes needs an answer well inside
 * its own timeout, and a Worker that answers nothing is worse than one that
 * answers "down": the first loses the alert, the second raises it.
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
 */
function withTimeout(promise, ms, name) {
  let timer;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new HealthCheckTimeout(name)),
      ms,
    );
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

class HealthCheckTimeout extends Error {
  constructor(name) {
    super(`${name} did not answer in time`);
    this.name = "HealthCheckTimeout";
  }
}

/**
 * Every D1 database on this Worker, paired with the binding name that reached
 * it. Read from `env` by shape (a `prepare` function) rather than from a
 * hand-kept list, so a binding added to cloudflare.config.ts is checked the
 * day it is added and cannot be forgotten here.
 * @param {Record<string, unknown>} env
 * @returns {{name: string, db: {prepare: (sql: string) => unknown}}[]}
 */
export function d1Bindings(env) {
  if (typeof env !== "object" || env === null) {
    return [];
  }
  return Object.entries(env)
    .filter(
      ([, binding]) =>
        typeof binding === "object" &&
        binding !== null &&
        typeof binding.prepare === "function",
    )
    .map(([name, db]) => ({ name, db }));
}

/**
 * One trivial read on a D1 database, with the query itself bounded by
 * `HEALTH_TIMEOUT_MS`. A rejected read is not swallowed: it becomes the
 * failure this check reports, with the binding's name and nothing else.
 * @param {string} name the binding name, safe to show an operator
 * @param {{prepare: (sql: string) => unknown}} db
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
 * The waitlist's rate limiter, on a key of its own. The binding has no read,
 * so `limit()` is the only way to know it answers at all: without it the
 * waitlist endpoint fails closed and sign-ups stop (src/waitlist.js), which is
 * an outage this endpoint must be able to report.
 *
 * The key changes every call and carries no client IP, for the reason above:
 * a health poll spends one unit of a bucket nobody else holds, so it cannot
 * eat a real client's quota, and a stranger hammering this public endpoint
 * cannot exhaust the probe's bucket and turn the health answer into a false
 * 503. Whether the limiter allows this call is not the question — the binding
 * answering at all is.
 *
 * @param {{limit: (options: {key: string}) => Promise<{success: boolean}>}} limiter
 */
async function checkRateLimiter(limiter, timeoutMs) {
  const result = await withTimeout(
    limiter.limit({ key: `health-probe-${crypto.randomUUID()}` }),
    timeoutMs,
    "WAITLIST_RATE_LIMITER",
  );
  if (!result || typeof result.success !== "boolean") {
    throw new Error("the rate limiter did not answer with a verdict");
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
  const checks = [];
  for (const { name, db } of d1Bindings(env)) {
    checks.push({ name, run: () => checkD1(name, db, timeoutMs) });
  }
  const assets = env === null || env === undefined ? undefined : env.ASSETS;
  if (!assets || typeof assets.fetch !== "function") {
    // The landing page is served by this binding on every request that is
    // not /api/*, so its absence is an outage, not a configuration nit: a
    // Worker that cannot serve the page cannot say the site is up.
    return { ok: false, failing: "ASSETS" };
  }
  checks.push({ name: "ASSETS", run: () => checkAssets(assets, timeoutMs) });
  // Only when this Worker has the waitlist bound: the limiter is a dependency
  // of the waitlist route, so on a deployment without one there is nothing to
  // reach.
  const limiter = env === null || env === undefined ? undefined : env.WAITLIST_RATE_LIMITER;
  if (limiter !== undefined) {
    if (typeof limiter.limit !== "function") {
      return { ok: false, failing: "WAITLIST_RATE_LIMITER" };
    }
    checks.push({
      name: "WAITLIST_RATE_LIMITER",
      run: () => checkRateLimiter(limiter, timeoutMs),
    });
  }

  for (const check of checks) {
    try {
      await check.run();
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
