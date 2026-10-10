// The sign-in ceilings, measured (drive issue #202, the tuning pass #147 left).
//
// #147 shipped the edge limits as "a pre-production guard with unmeasured
// numbers", and this file is the measurement it said had to happen before
// sign-in opens. The route was not reachable when the numbers were last
// checked: every path on the live Worker answered 302 to Cloudflare Access,
// and the tables the route writes were empty (session 0, user 0, rateLimit
// 0), so the real sign-in rate was 0 and could not have been anything else.
// So the numbers are measured here instead, on stand-in traffic through the
// real route, and the orchestrator's instruction on this issue was to tune
// from the stand-in traffic now and re-measure on real traffic after launch.
//
// What is real in this file and what is not, stated plainly:
//
//   Real: handleSigninRequest's own order of work, through the Worker's own
//   dispatch (src/index.js), with the real Better Auth stack on the real
//   migrations over a real SQLite database (test/harness.mjs). The limits read
//   are the ones cloudflare.config.ts ships, parsed out of that file, so this
//   measures the deployed numbers and cannot drift from them.
//   Stand-in: the rate-limit binding and the traffic shapes. Cloudflare's
//   binding is a counter this host cannot reach, so the stand-in reproduces the
//   contract its own documentation states — "the number of allowed requests
//   ... within the given period", counted per key, over a fixed period — and
//   the traffic is a described population, not a captured one.
//
// What this proves that a unit test does not: that the ceiling a real shared
// egress meets is a number with margin above it, and that the constant-key
// ceiling is sized above the per-IP world inside one location. The second is a
// per-location bound, not an account-wide one, because Cloudflare counts a key
// separately in each location (issue #878). Those facts are what the numbers in
// cloudflare.config.ts are for, and they were true of the old ones only by
// assertion.
//
// The population below is the one the config's own comment names: an office
// downlink, a carrier's CGNAT pool, a university, a family behind one router.
// Cloudflare's documentation agrees this is the hazard — it says keying a rate
// limit on an IP address is "not recommended", because "many users may share a
// single IP, especially on mobile networks or when using privacy-enabling
// proxies". That sentence is why this issue exists, and it is why the per-IP
// ceiling is tuned against a shared population rather than against one person.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import worker from "../src/index.js";
import { SIGNIN_ACCOUNT_SEND_MAX } from "../src/signin-send-limit.js";
import { createTestAuth, TEST_BASE_URL, TEST_SECRET } from "./harness.mjs";

/** The ExportedHandler type makes fetch optional and declares the runtime's
 * three arguments. One wrapper supplies the execution context the platform
 * would, so the calls below read as routes to the Worker.
 * @type {(request: Request, env?: unknown, ctx?: unknown) => Promise<Response>}
 */
const workerFetch =
  /** @type {(request: Request, env?: unknown, ctx?: unknown) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );

/**
 * Reads one rate-limit binding's shipped numbers out of cloudflare.config.ts,
 * which is where a deploy takes them from. Parsed rather than imported because
 * the file is the deployment config, not a module a test runs: the measurement
 * has to answer about the numbers a Cloudflare deploy would use, not about a
 * re-declaration of them that could drift.
 * @param {string} binding
 * @returns {{namespace: string, limit: number, period: number}}
 */
function shippedLimit(binding) {
  const config = readFileSync(new URL("../cloudflare.config.ts", import.meta.url), "utf8");
  const declared = config.match(
    new RegExp(`${binding}: bindings\\.rateLimit\\(\\{([\\s\\S]*?)\\}\\)`),
  );
  assert.ok(declared, `${binding} must be declared in cloudflare.config.ts`);
  const body = declared[1];
  const namespace = body.match(/namespace:\s*"(\d+)"/);
  const limit = body.match(/limit:\s*(\d+)/);
  const period = body.match(/period:\s*(\d+)/);
  assert.ok(
    namespace && limit && period,
    `${binding} must carry a namespace, a limit and a period`,
  );
  return { namespace: namespace[1], limit: Number(limit[1]), period: Number(period[1]) };
}

/**
 * The stand-in binding, reproducing Cloudflare's documented semantics: a
 * counter per key over a fixed `period`, `limit` allowed calls in it, and
 * `{ success }` back. Fixed windows rather than a sliding one, because that is
 * what "the number of allowed requests within the given period" describes.
 *
 * It tracks the peak each key reached in any one window, because that peak is
 * the measurement: it is the worst realistic case the shipped ceiling has to
 * survive, read off the run rather than assumed from the population's size.
 *
 * Two facts the real binding has and this one reproduces deliberately, because
 * both change what a ceiling means:
 *
 * One fact of the real binding this one does not reproduce, because reproducing
 * it would hide the finding below: Cloudflare's counters are per Cloudflare
 * location, so a key's real allowance is `limit` in each of them. The stand-in
 * counts one location, which is the conservative reading, and the global test
 * says so rather than implying the world is one machine's counter.
 *
 * The real binding is also eventually consistent and therefore permissive; a
 * stand-in is exact, so a real deployment refuses slightly later than a
 * stand-in says, never earlier.
 *
 * @param {{limit: number, period: number}} config
 * @param {() => number} [clock] the window clock, in seconds
 */
function makeWindowLimiter(config, clock = () => 0) {
  /** @type {Map<string, {count: number, window: number}>} */
  const buckets = new Map();
  /** @type {Map<string, number>} each key's peak count in one window */
  const peaks = new Map();
  /** @type {Array<{key: string, success: boolean}>} */
  const calls = [];
  return {
    calls,
    /** @param {string} key @returns {number} */
    peakForKey(key) {
      return peaks.get(key) ?? 0;
    },
    /** @param {{key: string}} options */
    async limit(options) {
      const window = Math.floor(clock() / config.period);
      const held = buckets.get(options.key);
      const bucket = held && held.window === window ? held : { count: 0, window };
      bucket.count += 1;
      buckets.set(options.key, bucket);
      peaks.set(options.key, Math.max(peaks.get(options.key) ?? 0, bucket.count));
      const success = bucket.count <= config.limit;
      calls.push({ key: options.key, success });
      return { success };
    },
  };
}

/**
 * One shared-egress population as a list of requests: `people` sign-in
 * attempts arriving over `minutes` minutes, all behind one client IP, each
 * person pressing at most `pressesPerPerson` times because the page sends one
 * link per press.
 * @param {{ip: string, people: number, minutes: number, pressesPerPerson: number}} shape
 * @returns {Array<{ip: string, minute: number}>}
 */
function sharedEgressTraffic(shape) {
  /** @type {Array<{ip: string, minute: number}>} */
  const requests = [];
  for (let person = 0; person < shape.people; person += 1) {
    // People do not all arrive on the same second of the same minute: a shape
    // with more than one minute spreads them over that many windows, while a
    // one-minute shape is a burst that all lands in the same window.
    for (let press = 0; press < shape.pressesPerPerson; press += 1) {
      requests.push({ ip: shape.ip, minute: person % shape.minutes });
    }
  }
  return requests;
}

/**
 * One request a person makes, carrying the client IP Cloudflare sets on every
 * request it serves. The address is the person's own, so a stand-in never
 * measures Better Auth's per-address rule (core/auth.js) instead of the edge
 * ceiling this file is about.
 * @param {{ip: string}} traffic
 * @param {number} person
 * @returns {Request}
 */
function signinRequest(traffic, person) {
  return new Request(`${TEST_BASE_URL}/api/signin`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": traffic.ip },
    body: JSON.stringify({
      step: "start",
      method: "email",
      email: `person-${person}@example.com`,
    }),
  });
}

/**
 * Drives the real route over a population's traffic and reports two verdicts,
 * kept apart because they answer different questions and belong to different
 * layers:
 *
 *   The edge verdict (allowed/refused/peak) is what the two rate-limit
 *     bindings decided. That is the layer this file tunes, so the NAT tests
 *     assert on it: whether the shipped per-IP ceiling let this population
 *     through.
 *   The route's own 202/429 answers what the person actually experienced, and
 *     it also carries the library's per-IP rule that runs after the edge
 *     (core/auth.js). The test below uses it to show that verdict is not the
 *     edge's to give.
 *
 * The clock advances one 60-second window with each minute of traffic (the
 * clock is in seconds, like the periods), so the stand-in bindings open each
 * next window the way a real one does, and the two are driven as two
 * independent bindings, as they are deployed.
 *
 * @param {{perIp: {limit: number, period: number}, global: {limit: number, period: number}}} limits
 * @param {Array<{ip: string, minute: number}>} requests
 * @returns {Promise<Map<string, {edgeAllowed: number, edgeRefused: number, peak: number, served: number, refused: number}>>}
 */
async function measure(limits, requests) {
  const made = createTestAuth();
  let minute = 0;
  // The clock is in seconds, so `minute * 60` opens a fresh 60-second window per
  // traffic minute. The earlier `() => minute` fed minutes into a seconds clock
  // and counted the whole population into window 0, which is the units bug the
  // review caught.
  const perIpLimiter = makeWindowLimiter(limits.perIp, () => minute * 60);
  const globalLimiter = makeWindowLimiter(limits.global, () => minute * 60);
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
    SIGNIN_MAIL: () => {},
    SIGNIN_RATE_LIMITER: perIpLimiter,
    SIGNIN_GLOBAL_RATE_LIMITER: globalLimiter,
  };
  /** @type {Map<string, {edgeAllowed: number, edgeRefused: number, peak: number, served: number, refused: number}>} */
  const report = new Map();
  let person = 0;
  for (const traffic of requests) {
    minute = traffic.minute;
    const before = perIpLimiter.calls.length;
    const response = await workerFetch(signinRequest(traffic, person), env);
    person += 1;
    // The per-IP binding spent this request's verdict on its own call, so the
    // layer's decision is read from the call rather than from the route's
    // status, which the library's own rule can also produce.
    const call = perIpLimiter.calls[before];
    assert.ok(call, "the per-IP binding is consulted for every sign-in start");
    const shape = report.get(traffic.ip) ?? {
      edgeAllowed: 0,
      edgeRefused: 0,
      peak: 0,
      served: 0,
      refused: 0,
    };
    if (call.success) {
      shape.edgeAllowed += 1;
    } else {
      shape.edgeRefused += 1;
    }
    if (response.status === 429) {
      shape.refused += 1;
    } else {
      shape.served += 1;
    }
    shape.peak = Math.max(shape.peak, perIpLimiter.peakForKey(traffic.ip));
    report.set(traffic.ip, shape);
  }
  return report;
}

// ---------------------------------------------------------------- the measurement

const PER_IP = shippedLimit("SIGNIN_RATE_LIMITER");
const GLOBAL = shippedLimit("SIGNIN_GLOBAL_RATE_LIMITER");

/**
 * The shared-egress populations the ceiling is measured against. Each is a
 * named real-world shape rather than a round number, so a reader can see which
 * case a ceiling protects and does not have to imagine "many users":
 *
 *   A small office          25 people behind one router, each signing in once
 *                           on a morning everyone arrived at once.
 *   A university lab        200 people behind one campus NAT, all arriving in
 *                           the busiest minute. This is the worst realistic
 *                           case: the largest population one institution puts
 *                           behind a single address while still being one
 *                           workplace, and the burst assumes they arrive
 *                           together, the conservative reading.
 *   An office in a login    25 people behind one router, each pressing three
 *   morning                 times because they mistyped. Three is Better
 *                           Auth's own per-IP rule on the magic-link route
 *                           (core/auth.js), so this is the largest an ordinary
 *                           person reaches without meeting a rule written for
 *                           one person.
 *   A carrier CGNAT pool    2,000 subscribers behind one address, arriving in
 *                           one minute: deliberately past the point where any
 *                           per-IP ceiling can fit everyone, measured for what
 *                           it shows about a ceiling's refusal, and the test
 *                           below says so.
 */
const OFFICE = { ip: "203.0.113.10", people: 25, minutes: 1, pressesPerPerson: 1 };
const LAB = { ip: "203.0.113.20", people: 200, minutes: 1, pressesPerPerson: 1 };
const OFFICE_RETRYING = { ip: "203.0.113.30", people: 25, minutes: 1, pressesPerPerson: 3 };
const CGNAT = { ip: "198.51.100.40", people: 2000, minutes: 1, pressesPerPerson: 1 };

test("the two sign-in bindings are distinct namespaces, as a deploy needs", () => {
  // Two bindings on one namespace share their counters, so the per-IP and the
  // global limit would be one limit counted twice and the global would stop
  // being a backstop. This is the one invariant about these two numbers that
  // is not about their size.
  assert.notEqual(PER_IP.namespace, GLOBAL.namespace);
});

test("a whole small office signing in at once clears the edge per-IP ceiling", async () => {
  // The case the issue names first: an office downlink concentrates people onto
  // one client IP, so the old ceiling of 10 a minute shaped that whole office to
  // 10 sign-in starts. A morning where everyone arrives at once is ordinary, so
  // the edge must let all of them through.
  //
  // This asserts the edge layer's own verdict, read from the per-IP binding's
  // call, because that is the layer this file tunes. What the person then
  // experiences also carries the library's per-IP rule that runs after it, which
  // the last test in this file measures.
  const report = await measure({ perIp: PER_IP, global: GLOBAL }, sharedEgressTraffic(OFFICE));
  const measured = report.get(OFFICE.ip);
  assert.ok(measured);
  assert.equal(
    measured.edgeRefused,
    0,
    `the edge per-IP ceiling refused ${measured.edgeRefused} of ${OFFICE.people} in an office arriving together, peaking at ${measured.peak} against a ${PER_IP.limit}-a-minute ceiling`,
  );
  assert.equal(measured.edgeAllowed, OFFICE.people, "the edge serves every person in the office");
  // The peak the config comment records for this row, pinned so a traffic or
  // clock regression fails here rather than silently shrinking the measurement.
  assert.equal(
    measured.peak,
    OFFICE.people,
    `the office peaked at ${measured.peak}/min, not the measured ${OFFICE.people}`,
  );
});

test("an office retrying a mistyped link three times each clears the edge ceiling", async () => {
  // The person's own pace, which is what the ceiling is really about: the page
  // sends one link per press, so a person who mistypes retries a few times and
  // is then told to wait a minute.
  const report = await measure(
    { perIp: PER_IP, global: GLOBAL },
    sharedEgressTraffic(OFFICE_RETRYING),
  );
  const measured = report.get(OFFICE_RETRYING.ip);
  assert.ok(measured);
  assert.equal(
    measured.edgeRefused,
    0,
    `the edge per-IP ceiling refused ${measured.edgeRefused} of an office retrying, peaking at ${measured.peak} against a ${PER_IP.limit}-a-minute ceiling`,
  );
  assert.equal(
    measured.peak,
    OFFICE_RETRYING.people * OFFICE_RETRYING.pressesPerPerson,
    `the retrying office peaked at ${measured.peak}/min, not the measured ${OFFICE_RETRYING.people * OFFICE_RETRYING.pressesPerPerson}`,
  );
});

test("a university lab's worst minute is under the per-IP ceiling", async () => {
  // The worst realistic NAT case the ceiling has to clear, measured through the
  // real route, so the peak it reports is what this address reached at the edge.
  const report = await measure({ perIp: PER_IP, global: GLOBAL }, sharedEgressTraffic(LAB));
  const measured = report.get(LAB.ip);
  assert.ok(measured);
  // Pinned so the 2x margin below is not satisfied by a peak that never
  // happened: 200 people in one minute peak at 200, not at the 40 a five-minute
  // spread would give (the units bug the review caught).
  assert.equal(
    measured.peak,
    LAB.people,
    `the lab peaked at ${measured.peak}/min, not the measured ${LAB.people}`,
  );
  assert.ok(
    measured.peak < PER_IP.limit,
    `a ${LAB.people}-person lab peaked at ${measured.peak} on one IP a minute, which does not clear the ${PER_IP.limit}-a-minute ceiling`,
  );
  // And the margin is deliberate rather than exact: sitting on the measured
  // case would refuse the next office one person larger.
  assert.ok(
    PER_IP.limit >= measured.peak * 2,
    `the per-IP ceiling (${PER_IP.limit}/min) must be at least double the measured lab peak (${measured.peak}/min), so an office twice the size is still served`,
  );
});

test("a CGNAT pool is refused by the edge per-IP ceiling", async () => {
  // This population cannot be served by any per-IP number, and the test says so
  // rather than pretending otherwise: 2,000 subscribers share one address, so
  // per-IP means the least-connected of them waits while the busiest gets
  // through. What must hold is that the ceiling is still doing its job at that
  // size, which is what keeps one shared address from being a mailbomb.
  const report = await measure({ perIp: PER_IP, global: GLOBAL }, sharedEgressTraffic(CGNAT));
  const measured = report.get(CGNAT.ip);
  assert.ok(measured);
  assert.ok(
    measured.edgeRefused > 0,
    "a CGNAT pool over the per-IP ceiling must be refused somewhere, or the ceiling is not doing its job",
  );
});

test("the constant-key ceiling stays above the per-IP addresses in one location", () => {
  // NOT an account-wide check, and it must not read like one. Cloudflare counts
  // a rate-limit key separately in each location, so this binding bounds one
  // location and a walk spread over many locations is not bounded by it at all
  // (that gap is issue #878). What it must do inside one location is not bind
  // before the per-IP ceilings it sits above, so a location's shared addresses
  // are shaped by their own per-IP limits first. The shipped 5000 is 10x the
  // per-IP 500; assert at least a few maxed addresses so the relationship
  // cannot silently invert.
  const MAXED_ADDRESSES = 2;
  assert.ok(
    GLOBAL.limit >= PER_IP.limit * MAXED_ADDRESSES,
    `the constant-key ceiling (${GLOBAL.limit}/min) must stay above ${MAXED_ADDRESSES} maxed per-IP addresses (${PER_IP.limit}/min each) in one location`,
  );
});

test("the account-wide counter's ceiling is the location binding's own figure", () => {
  // drive#878: the D1 counter (src/signin-send-limit.js) bounds the account's
  // total across every location — the bound this file's stand-in cannot
  // measure, because its counter is one location's. Its ceiling is this
  // binding's own figure on purpose: inside any one location the binding
  // refuses first and the counter only records what it let through, so a
  // lower figure would bind before the binding inside a location, and a
  // higher one would leave the account bound wider than one location
  // already is.
  assert.equal(
    GLOBAL.limit,
    SIGNIN_ACCOUNT_SEND_MAX,
    `the account-wide ceiling must stay equal to the location binding's figure (${GLOBAL.limit}/min), so the binding refuses first inside a location`,
  );
});

test("both ceilings are whole numbers the binding can take", () => {
  // The binding takes a whole number of requests, so a ceiling that is not one
  // is not a ceiling a deploy can be given.
  assert.ok(Number.isInteger(PER_IP.limit), `per-IP ${PER_IP.limit} is a whole number`);
  assert.ok(Number.isInteger(GLOBAL.limit), `global ${GLOBAL.limit} is a whole number`);
  assert.equal(PER_IP.period, GLOBAL.period, "both windows are the same length");
  assert.ok(PER_IP.period === 10 || PER_IP.period === 60, "the period is 10 or 60 seconds");
});

// ---------------------------------------------------------- what a customer meets

test("the per-IP send bound a customer meets is the library's, not this edge's", async () => {
  // The finding of drive issue #202, measured here so the next reader sees the
  // number instead of re-deriving it: raising the two edge ceilings does NOT by
  // itself free a shared office. Better Auth keys its own `/sign-in/magic-link`
  // rule on the same client IP (core/auth.js: max 3 per 60s, D1-backed, so the
  // counter is one per IP across every isolate), and that rule runs AFTER both
  // edge bindings, so it refuses first.
  //
  // This test drives the real route twice with the edge layer held wide open —
  // so the only thing that can refuse is the library's rule — and answers how
  // many emails one shared office address actually causes.
  const servedWithEdgeHeldOpen = await servedBehindOneNat();
  assert.ok(
    servedWithEdgeHeldOpen < OFFICE.people,
    `an office behind one NAT is refused by the library's own per-IP rule: ${servedWithEdgeHeldOpen} of ${OFFICE.people} served with the edge layer held open, so raising the edge ceilings alone cannot reach the people behind a shared address`,
  );
});

/**
 * How many sign-in links one shared office address actually gets, with the
 * edge layer held wide open so the library's own per-IP rule is the only thing
 * that can refuse. This is the measurement behind the test above and the
 * comment beside the bindings in cloudflare.config.ts.
 * @returns {Promise<number>}
 */
async function servedBehindOneNat() {
  const made = createTestAuth();
  const open = { limit: async () => ({ success: true }) };
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
    SIGNIN_MAIL: (/** @type {{to: string, url: string}} */ link) => {
      made.sent.push(link);
    },
    SIGNIN_RATE_LIMITER: open,
    SIGNIN_GLOBAL_RATE_LIMITER: open,
  };
  for (let person = 0; person < OFFICE.people; person += 1) {
    await workerFetch(
      new Request(`${TEST_BASE_URL}/api/signin`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": OFFICE.ip },
        body: JSON.stringify({
          step: "start",
          method: "email",
          email: `nat-office-${person}@example.com`,
        }),
      }),
      env,
    );
  }
  return made.sent.length;
}
