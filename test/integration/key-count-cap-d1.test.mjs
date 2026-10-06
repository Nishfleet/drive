// The per-account live-key cap on the key mint (drive issue #552).
//
// A mint is a vendor access key the storage server enforces, and the vendor
// sets no per-account limit of its own, so the count of an account's live
// keys is the bound: 20, and the 21st mint is refused before the vendor is
// called, with the message table's "key-count-cap" words.
//
// The proof is the composition the live Worker builds — `storeFor` in
// workers/api/src/index.js is
// `createMemoryStore({ deviceStore: createD1DeviceStore(...) })` — over the
// real schema, driven through the real route. The count is the D1 store's
// `countLiveKeys` (devices.js), so what it measures is what another isolate
// would see. The limiter the route runs ahead of the cap is proved in the
// same dispatch: a binding that says no answers 429, and a missing binding
// lets the mint through, because the account gate and this cap bind the route
// anyway (test/deploy-api-worker.test.mjs refuses a config that does not
// declare the binding).
//
// Every assertion about a row reads it back with plain node:sqlite off the
// same engine `devices.js` runs its statements on (test/d1-sqlite.mjs
// `makeMeteredDB`), so nothing here is checked against a store's own answer
// about itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createD1DeviceStore } from "../../core/devices.js";
import { KEY_COUNT_CAP } from "../../core/keyprovider.js";
import { createMemoryStore, KeyCountCapError } from "../../core/keystore.js";
import { failureMessage } from "../../core/messages.js";
import { dispatch } from "../../workers/api/src/index.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

const START = Math.floor(Date.parse("2026-10-06T12:00:00.000Z") / 1000);
const AGENT_TTL = 3600;

/**
 * A key provider that records every mint it is asked for and answers
 * stand-in credentials. The record is how a test proves the cap stopped a
 * vendor call: the refused mint must not appear in it.
 * @returns {{mints: string[], mint: (scope: unknown) => Promise<{accessKeyId: string, secret: string, sessionToken: null, expiresIn: null}>}}
 */
function recordingProvider() {
  /** @type {string[]} */
  const mints = [];
  return {
    mints,
    async mint() {
      const n = mints.push(`ak-${mints.length + 1}`);
      return { accessKeyId: `ak-${n}`, secret: `sk-${n}`, sessionToken: null, expiresIn: null };
    },
  };
}

/**
 * The live Worker's composition over the real schema, with a movable clock
 * and a recording vendor.
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @param {{second: number}} clock advanced by the tests
 * @param {ReturnType<typeof recordingProvider>} provider
 */
function storeOver(db, clock, provider) {
  const now = () => clock.second * 1000;
  return createMemoryStore({
    now,
    deviceStore: createD1DeviceStore(db, { now }),
    keyProvider: /** @type {import("../../core/keyprovider.js").KeyProvider} */ (
      /** @type {unknown} */ (provider)
    ),
  });
}

/**
 * Sign a device in and hand back its bearer token, the way the CLI does.
 * @param {ReturnType<typeof createMemoryStore>} store
 * @param {string} name
 */
async function signIn(store, name) {
  const code = await store.requestDeviceCode({ name });
  await store.approveDeviceCode(code.userCode);
  const poll = await store.pollDeviceCode(code.deviceCode);
  assert.equal(poll.status, "approved", "the device sign-in must be approved");
  const approved = /** @type {{account: {id: string}, deviceToken: string}} */ (
    /** @type {unknown} */ (poll)
  );
  return approved;
}

/**
 * Mint through the real route with the env a caller names.
 * @param {ReturnType<typeof createMemoryStore>} store
 * @param {string} deviceToken
 * @param {Record<string, unknown>} env
 * @param {{kind?: string, name?: string}} request
 */
async function mintThroughRoute(store, deviceToken, env, request = {}) {
  return dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify(request),
    }),
    { env, db: null, store, account: null, now: () => Date.now() },
  );
}

test("the 21st mint is refused with the message table's words, before the vendor is called", async () => {
  const { db } = makeMeteredDB();
  const clock = { second: START };
  const provider = recordingProvider();
  const store = storeOver(db, clock, provider);
  const { account, deviceToken } = await signIn(store, "minter");

  // The sign-in's device token is not a key row (the sign-in store holds it,
  // not the devices table), so a fresh account's live count starts at zero:
  // twenty mints reach the cap, and the twenty-first is the refusal.
  for (let i = 1; i <= KEY_COUNT_CAP; i++) {
    const minted = await mintThroughRoute(store, deviceToken, {}, { kind: "agent", name: `k${i}` });
    assert.equal(minted.status, 201, `mint ${i} is under the cap`);
  }
  assert.equal(provider.mints.length, KEY_COUNT_CAP, "every mint under the cap reached the vendor");

  const refused = await mintThroughRoute(store, deviceToken, {}, { kind: "agent", name: "k21" });
  assert.equal(refused.status, 409, "the mint past the cap is a 409, the agent cap's own shape");
  const body = await refused.json();
  assert.equal(
    body.error,
    failureMessage("key-count-cap"),
    "the refusal is the message table's sentence, not the error's own",
  );
  assert.equal(
    provider.mints.length,
    KEY_COUNT_CAP,
    "the refused mint made no vendor call: the count cap runs ahead of it",
  );

  // And the cap is in D1, so the next isolate measures the same account the
  // same way: a fresh store over the same database — which never minted any
  // of these rows — refuses at the store, not from its own memory.
  const fresh = storeOver(db, clock, recordingProvider());
  await assert.rejects(
    () => fresh.mintKey(account, { kind: "agent", name: "k22" }),
    KeyCountCapError,
    "the cap is the database's, not this isolate's",
  );
});

test("the number in the message is the constant the cap enforces", () => {
  // The message names 20 and the cap is 20; a test pins the two together, so
  // a cap raised in code without its sentence (or the other way) fails here.
  assert.equal(KEY_COUNT_CAP, 20);
  assert.match(failureMessage("key-count-cap"), new RegExp(`\\b${KEY_COUNT_CAP}\\b`));
});

test("an hourly key past its hour does not count, so the account can mint again", async () => {
  const { db } = makeMeteredDB();
  const clock = { second: START };
  const provider = recordingProvider();
  const store = storeOver(db, clock, provider);
  const { deviceToken } = await signIn(store, "clocked");

  // Fill to the cap: nineteen hourly agent keys, then one device key, which
  // is the one kind that never expires. Live: twenty.
  for (let i = 1; i < KEY_COUNT_CAP; i++) {
    const minted = await mintThroughRoute(store, deviceToken, {}, { kind: "agent", name: `k${i}` });
    assert.equal(minted.status, 201);
  }
  clock.second = START + 1;
  const device = await mintThroughRoute(store, deviceToken, {}, { kind: "device", name: "laptop" });
  assert.equal(device.status, 201);
  const refused = await mintThroughRoute(store, deviceToken, {}, { kind: "agent", name: "at-cap" });
  assert.equal(refused.status, 409, "the account is at the cap");

  // An hour passes. Every agent's row expires (its TTL is one hour); the
  // device key does not. The account holds one live key, so the mint that
  // was refused goes through — and nineteen mints later the cap refuses
  // again, so what freed was exactly the dead keys' slots.
  clock.second = START + AGENT_TTL + 2;
  const minted = await mintThroughRoute(
    store,
    deviceToken,
    {},
    { kind: "agent", name: "after-hour" },
  );
  assert.equal(minted.status, 201, "the expired keys freed their slots");
  // Live is now two (the device key and this mint), so eighteen refills
  // reach the cap and the next mint refuses again: what freed was exactly
  // the dead keys' slots, and the cap still counts the live ones.
  for (let i = 1; i <= KEY_COUNT_CAP - 2; i++) {
    const more = await mintThroughRoute(store, deviceToken, {}, { kind: "agent", name: `n${i}` });
    assert.equal(more.status, 201, `refill ${i} is under the cap`);
  }
  const capped = await mintThroughRoute(store, deviceToken, {}, { kind: "agent", name: "n19" });
  assert.equal(capped.status, 409, "the cap counts live keys only, and the device key is live");
});

test("a limiter that says no answers 429 with the rate-limit words; a missing binding lets the mint through", async () => {
  const { db } = makeMeteredDB();
  const clock = { second: START };
  const provider = recordingProvider();
  const store = storeOver(db, clock, provider);
  const { deviceToken } = await signIn(store, "limited");

  const slowed = await mintThroughRoute(
    store,
    deviceToken,
    { KEYS_RATE_LIMITER: { limit: async () => ({ success: false }) } },
    { kind: "agent", name: "too-fast" },
  );
  assert.equal(slowed.status, 429, "the limiter's no is a 429");
  assert.equal(String(slowed.headers.get("retry-after")), "60");
  const body = await slowed.json();
  assert.equal(body.error, failureMessage("rate-limited"), "the words are the table's, one source");
  assert.equal(provider.mints.length, 0, "a rate-limited mint makes no vendor call");

  // The missing-binding posture, on purpose unlike the public device routes:
  // this route is behind the account gate and the live-key cap binds it
  // anyway, so a deployment that has not declared the binding still runs —
  // loudly in the log — rather than 503ing a signed-in account's own route.
  const through = await mintThroughRoute(
    store,
    deviceToken,
    {},
    { kind: "agent", name: "unbound" },
  );
  assert.equal(through.status, 201, "no binding is not a closed door on an account-gated route");
});

test("s3 and branch keys count toward the same cap, and mintTeamKey cannot walk around it", async () => {
  const { db } = makeMeteredDB();
  const clock = { second: START };
  const provider = recordingProvider();
  const store = storeOver(db, clock, provider);
  const { account, deviceToken } = await signIn(store, "kinds");

  assert.equal((await mintThroughRoute(store, deviceToken, {}, { kind: "s3", name: "s3" })).status, 201);
  assert.equal(
    (await mintThroughRoute(store, deviceToken, {}, { kind: "branch", name: "b" })).status,
    201,
  );
  for (let i = 3; i <= KEY_COUNT_CAP; i++) {
    const minted = await mintThroughRoute(store, deviceToken, {}, { kind: "agent", name: `k${i}` });
    assert.equal(minted.status, 201, `mint ${i} is under the cap`);
  }
  const refused = await mintThroughRoute(store, deviceToken, {}, { kind: "agent", name: "k21" });
  assert.equal(refused.status, 409);
  await assert.rejects(
    () => store.mintTeamKey(account, "team_cap", "read_write", { name: "member" }),
    KeyCountCapError,
    "a team mint is the same vendor key and the same cap",
  );
  assert.equal(provider.mints.length, KEY_COUNT_CAP, "the refused team mint made no vendor call");
});
