// The api Worker's deploy config (drive issue #168).
//
// The api Worker reads two edge-limit bindings the device flow fails closed
// without (workers/api/src/device-routes.js: DEVICE_RATE_LIMITER and
// DEVICE_GLOBAL_RATE_LIMITER), and those names can only be declared in a
// config. This repo's deploy config for it is workers/api/cloudflare.config.ts,
// registered as an auxiliary Worker in vite.config.ts, which is the only way
// `cf build` writes the Worker into the Build Output at all — cf's autoconfig
// resolves its CONFIG_FILENAME against the Vite root, and the root's file is
// the site Worker's, so a second config file the build does not load is dead
// text.
//
// The checks below read the two configs the way the deploy does — the api one
// as the parsed object (Node strips the types, so this is the file cf reads,
// not a description of it) and the site one as text, because the root
// cloudflare.config.ts anchors its entrypoint through the `with { type:
// "cf-worker" }` attribute that only cf's own loader handles, so importing it
// here fails with ERR_IMPORT_ATTRIBUTE_UNSUPPORTED. The last two tests dispatch
// the api Worker's real router with an env built from the bindings the config
// declares, so a renamed binding in either file fails here rather than at a
// deploy.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { failureMessage } from "../src/messages.js";
import apiConfig from "../workers/api/cloudflare.config.ts";
import { DEVICE_GLOBAL_LIMIT, DEVICE_IP_LIMIT } from "../workers/api/src/device-routes.js";
import { DEVICE_CODE_INTERVAL_SECONDS } from "../workers/api/src/device-signin.js";
import { dispatch } from "../workers/api/src/index.js";
import { createMemoryStore } from "../workers/api/src/keystore.js";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The two limiter names device-routes.js reads off env, imported from that
// module rather than copied here or read back out of its text: a rename there
// changes this gate with it, so the config cannot declare a name the routes no
// longer read and the routes cannot read a name the config does not declare.
// Nothing here spells the names, because a second spelling is the drift this
// import exists to prevent.
const limiterNames = [DEVICE_IP_LIMIT, DEVICE_GLOBAL_LIMIT];

// The site Worker's rate-limit bindings, as its config spells them. The root
// config cannot be imported (see the header), so the namespaces and numbers
// are read from the same text the deploy uploads, which is the only other way
// to check the api Worker's pair against a namespace another binding on this
// account already holds: Cloudflare fails the deploy with 10021 on a duplicate.
/** @returns {Array<{binding: string, namespace: string, limit: number, period: number}>} */
function siteLimiters() {
  return [
    ...read("cloudflare.config.ts").matchAll(
      /(\w+): bindings\.rateLimit\(\{\s*namespace: "(\d+)",\s*simple: \{ limit: (\d+), period: (\d+) \},?\s*\}\)/g,
    ),
  ].map((m) => ({
    binding: m[1],
    namespace: m[2],
    limit: Number(m[3]),
    period: Number(m[4]),
  }));
}

test("the api Worker's config declares the two device limiters the routes read", () => {
  // Both directions, so the gate cannot pass with a name on only one side: the
  // config's rate-limit bindings are exactly the names device-routes.js reads
  // off env, no more and no fewer. A third limit added there, or one renamed on
  // either side, fails here and says which side drifted.
  assert.equal(new Set(limiterNames).size, 2, "the device flow runs behind two limits");
  const bindings = Object.entries(apiConfig.env);
  const declaredLimiters = bindings
    .filter(([, binding]) => binding.type === "rate-limit")
    .map(([name]) => name);
  assert.deepEqual(
    [...declaredLimiters].sort(),
    [...limiterNames].sort(),
    `workers/api/cloudflare.config.ts declares ${JSON.stringify(declaredLimiters)} as rate limits, and workers/api/src/device-routes.js reads ${JSON.stringify(limiterNames)} off env`,
  );
  // The stock rate-limit binding, not a stand-in with the same name: the routes
  // hand the name on env to enforceEdgeLimits, which counts on the binding's
  // own Cloudflare namespace, so a same-named non-binding would answer 200
  // while counting nothing.
  for (const name of limiterNames) {
    const entry = bindings.find(([declared]) => declared === name);
    assert.ok(entry?.[1].type === "rate-limit", `${name} must be the stock rate-limit binding`);
  }
});

test("the config binds the api Worker to the drive database, the device limits, and the founding offer switch", () => {
  // The declarations are the env this Worker has: the one database its stores
  // and Better Auth's user and session tables live on, the two limiters above,
  // and the founding-member offer switch (drive#386) the accounts store reads
  // when a row becomes paying. The accounts store the device approval reads is
  // the user table already on this database (#181), not a second one, and no
  // mailer is declared because no route this Worker mounts sends mail (the
  // site Worker's /api/signin owns the sign-in link).
  assert.deepEqual(Object.keys(apiConfig.env), [
    "DRIVE_DB",
    "DEVICE_RATE_LIMITER",
    "DEVICE_GLOBAL_RATE_LIMITER",
    "FOUNDING_OFFER_OPEN",
  ]);
  assert.equal(apiConfig.env.FOUNDING_OFFER_OPEN.type, "text");
  assert.equal(apiConfig.env.FOUNDING_OFFER_OPEN.value, "1");
  assert.equal(
    apiConfig.env.DRIVE_DB.name,
    "drive-data",
    "customer data lives in the drive database",
  );
  assert.ok(!("EMAIL" in apiConfig.env), "no api route mails, so no mailer is declared");
  assert.ok(
    !("ACCOUNTS_STORE" in apiConfig.env),
    "the account store is Better Auth's user table on DRIVE_DB (#181)",
  );
  // One host fronts both Workers (drive#156/#341), and a session cookie is one
  // account in both, so the api Worker binds the same database id the site
  // Worker binds — not a second copy of the same tables under a new name.
  const site = read("cloudflare.config.ts");
  const id = /DRIVE_DB: bindings\.d1\(\{\s*name: "drive-data",\s*id: "([^"]+)"/.exec(site)?.[1];
  assert.ok(id, "cloudflare.config.ts must declare DRIVE_DB on the drive database");
  assert.equal(
    apiConfig.env.DRIVE_DB.id,
    id,
    "the api Worker's DRIVE_DB must be the same drive-data database the site Worker binds",
  );
});

test("the per-IP ceiling sits above the CLI's own poll rate and the sign-in limit", () => {
  // A device code is polled every DEVICE_CODE_INTERVAL_SECONDS, from one
  // connection, for as long as the person takes to approve it. The ceiling
  // has to let a well-behaved CLI through: the sign-in binding's 10 a minute
  // would lock a CLI polling 12 times a minute out of the flow it is already
  // in (#168).
  const pollRate = Math.ceil(60 / DEVICE_CODE_INTERVAL_SECONDS);
  const perIp = apiConfig.env.DEVICE_RATE_LIMITER.simple;
  assert.ok(
    perIp.limit > pollRate,
    `DEVICE_RATE_LIMITER allows ${perIp.limit} a minute, which a CLI polling ${pollRate} times a minute does not fit under`,
  );
  const signin = siteLimiters().find((entry) => entry.binding === "SIGNIN_RATE_LIMITER");
  assert.ok(signin, "cloudflare.config.ts must declare SIGNIN_RATE_LIMITER to compare against");
  assert.ok(
    perIp.limit > signin.limit,
    `DEVICE_RATE_LIMITER allows ${perIp.limit} a minute, no more headroom than sign-in's ${signin.limit}`,
  );
  // The global one bounds the token factory: both a poll (which mints a device
  // token) and an approval (which attaches an account) are public, so it caps
  // the worst case whatever many IPs it comes from. It sits above the per-IP
  // world it caps, and both run one minute so one number describes every rate
  // limit on this account.
  const global = apiConfig.env.DEVICE_GLOBAL_RATE_LIMITER.simple;
  assert.ok(
    global.limit > perIp.limit,
    `DEVICE_GLOBAL_RATE_LIMITER allows ${global.limit} a minute, at or under the per-IP ${perIp.limit}`,
  );
  assert.equal(perIp.period, 60);
  assert.equal(global.period, 60);
});

test("every rate-limit namespace on the account is distinct", () => {
  // Cloudflare wants a positive integer string unique per account, and a
  // namespace another binding already uses fails the deploy with 10021. The
  // site Worker holds the first five; the api Worker's pair has to start after
  // them rather than reuse one.
  const api = Object.values(apiConfig.env)
    .filter((binding) => binding.type === "rate-limit")
    .map((binding) => ({ binding: "api", namespace: binding.namespace }));
  const all = [...siteLimiters(), ...api];
  const seen = new Map();
  for (const entry of all) {
    assert.ok(
      !seen.has(entry.namespace),
      `namespace ${entry.namespace} is declared twice (${seen.get(entry.namespace)} and ${entry.binding}); the deploy fails with 10021`,
    );
    seen.set(entry.namespace, entry.binding);
  }
});

test("the api Worker's config names the real entry and is wired into the build", () => {
  // The entrypoint is resolved against the Vite root by the plugin that builds
  // the auxiliary Worker, so the string is root-relative and must point at the
  // file the Worker's tests already drive.
  assert.equal(apiConfig.entrypoint, "workers/api/src/index.js");
  assert.ok(
    existsSync(new URL(`../${apiConfig.entrypoint}`, import.meta.url)),
    `the config names ${apiConfig.entrypoint}, which this tree does not have`,
  );
  assert.match(apiConfig.compatibilityDate, /^\d{4}-\d{2}-\d{2}$/);
  // A config no build loads is dead text, so the wiring is part of the gate:
  // vite.config.ts registers this file as an auxiliary Worker.
  const vite = read("vite.config.ts");
  assert.match(
    vite,
    /import apiWorker from "\.\/workers\/api\/cloudflare\.config\.ts"/,
    "vite.config.ts must import the api Worker's config, so there is one file both halves read",
  );
  assert.match(
    vite,
    /auxiliaryWorkers: \[[\s\S]*config: apiWorker/,
    "the api Worker's config must be registered as an auxiliaryWorker, which is how cf build emits it into the Build Output",
  );
});

/** The two limiters the config declares, bound the way a deployment binds
 * them: a stub answer object is all `enforceEdgeLimits` calls.
 * @returns {Record<string, {limit(options: {key: string}): Promise<{success: boolean}>}>}
 */
function declaredLimiters() {
  /** @type {Record<string, {limit(options: {key: string}): Promise<{success: boolean}>}>} */
  const env = {};
  for (const [name, binding] of Object.entries(apiConfig.env)) {
    if (binding.type === "rate-limit") {
      env[name] = { limit: async () => ({ success: true }) };
    }
  }
  return env;
}

test("a device-code request runs with the two limiters bound", async () => {
  // The behavioural half: a request through the api Worker's own dispatch,
  // with an env built from the bindings the config declares and the store it
  // stands up for a deployment with no database (the Worker's own fallback).
  // The names in the config are then load-bearing rather than spelled right:
  // a binding renamed on either side makes this request take the closed door.
  const ctx = {
    env: declaredLimiters(),
    db: null,
    store: createMemoryStore(),
    url: new URL("https://drive.test/v1/device/code"),
    now: () => Date.now(),
  };
  const request = () =>
    new Request("https://drive.test/v1/device/code", {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.7" },
    });
  const opened = await dispatch(request(), ctx);
  assert.equal(opened.status, 200, "with both declared limiters bound the device flow runs");
  const body = await opened.json();
  assert.ok(body.userCode.length > 0);
  assert.equal(
    body.interval,
    DEVICE_CODE_INTERVAL_SECONDS,
    "the CLI is told the rate it is polled at",
  );
  assert.match(String(body.verificationUri), /\/v1\/device\/approve$/);
});

test("a device-code request takes the closed door when a declared limiter is missing", async () => {
  // The same posture the sign-in route shows before its bindings land, and the
  // reason #168 exists at all: an unrate-limited public route that writes a
  // row is what the binding prevents, so a deployment that has not declared it
  // does not run the flow (device-routes.js).
  const env = declaredLimiters();
  delete env.DEVICE_RATE_LIMITER;
  const response = await dispatch(
    new Request("https://drive.test/v1/device/code", {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.7" },
    }),
    {
      env,
      db: null,
      store: createMemoryStore(),
      url: new URL("https://drive.test/v1/device/code"),
      now: () => Date.now(),
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: failureMessage("unexpected") });
});
