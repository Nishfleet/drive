// The devices page (drive#525): list live keys with kind and last-used, and
// revoke one at the provider. The handler is proven against the real D1
// store; the Worker walk proves the account gate stands in front of it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createD1DeviceStore } from "../core/devices.js";
import { failureMessage } from "../core/messages.js";
import { DEVICES_ENDPOINT, devicesPath, handleDevicesRequest } from "../src/devices-page.js";
import worker from "../src/index.js";
import { createTestAuth, signIn, TEST_SECRET } from "./harness.mjs";

const page = readFileSync(new URL("../public/devices.html", import.meta.url), "utf8");
const SEEN_AT = 1_700_000_000;

/** @type {(request: Request, env?: unknown) => Promise<Response>} */
const workerFetch = /** @type {(request: Request, env?: unknown) => Promise<Response>} */ (
  /** @type {unknown} */ (worker.fetch)
);

/**
 * @param {string} id
 * @param {string} accountId
 * @param {{kind?: "device"|"agent"|"s3"|"branch", lastSeenAt?: number|null, revokedAt?: number|null, accessKeyId?: string}} [extra]
 */
function deviceRow(id, accountId, extra = {}) {
  return {
    id,
    accountId,
    name: id,
    kind: extra.kind ?? "device",
    accessKeyId: extra.accessKeyId ?? `ak_${id}`,
    secretHash: `hash_${id}`,
    prefix: `u/${accountId}/`,
    capabilities: [],
    createdAt: SEEN_AT,
    lastSeenAt: extra.lastSeenAt === undefined ? SEEN_AT : extra.lastSeenAt,
    revokedAt: extra.revokedAt ?? null,
  };
}

test("devicesPath reads the list and one key id, and refuses a nested path", () => {
  assert.deepEqual(devicesPath("/api/devices"), { keyId: "" });
  assert.deepEqual(devicesPath("/api/devices/"), { keyId: "" });
  assert.deepEqual(devicesPath("/api/devices/key_mac"), { keyId: "key_mac" });
  assert.deepEqual(devicesPath("/api/devices/key_mac/extra"), { error: "unknown" });
  assert.deepEqual(devicesPath("/api/devices/.."), { error: "unknown" });
});

test("GET lists live keys with kind and last-used, and hides revoked and other accounts", async () => {
  const made = createTestAuth();
  const { account } = await signIn(made, "owner@example.com");
  const other = await signIn(made, "other@example.com");
  /** @type {string[]} */
  const revokedIds = [];
  const store = createD1DeviceStore(made.db, {
    keyProvider: {
      async mint() {
        throw new Error("mint is unused on the devices page");
      },
      async revoke(accessKeyId) {
        revokedIds.push(accessKeyId);
      },
    },
  });
  await store.put(deviceRow("key_mac", account.id, { kind: "device" }));
  await store.put(deviceRow("key_claude", account.id, { kind: "agent", lastSeenAt: null }));
  await store.put(deviceRow("key_dead", account.id, { revokedAt: SEEN_AT }));
  await store.put(deviceRow("key_other", other.account.id));

  const response = await handleDevicesRequest(
    new Request(`https://drive.test${DEVICES_ENDPOINT}`),
    account,
    store,
  );
  assert.equal(response.status, 200);
  /** @type {{keys: Array<{keyId: string, kind: string, lastSeenAt: number|null}>}} */
  const body = await response.json();
  assert.deepEqual(body.keys.map((key) => key.keyId).sort(), ["key_claude", "key_mac"]);
  const mac = body.keys.find((key) => key.keyId === "key_mac");
  assert.ok(mac);
  assert.equal(mac.kind, "device");
  assert.equal(mac.lastSeenAt, SEEN_AT * 1000);
  const agent = body.keys.find((key) => key.keyId === "key_claude");
  assert.ok(agent);
  assert.equal(agent.kind, "agent");
  assert.equal(agent.lastSeenAt, null);
  assert.equal(revokedIds.length, 0);
});

test("DELETE revokes the named key at the provider and 404s another account's key", async () => {
  const made = createTestAuth();
  const { account } = await signIn(made, "owner@example.com");
  const other = await signIn(made, "other@example.com");
  /** @type {string[]} */
  const revokedIds = [];
  const store = createD1DeviceStore(made.db, {
    keyProvider: {
      async mint() {
        throw new Error("mint is unused on the devices page");
      },
      async revoke(accessKeyId) {
        revokedIds.push(accessKeyId);
      },
    },
  });
  await store.put(deviceRow("key_mac", account.id, { accessKeyId: "ak_mac" }));
  await store.put(deviceRow("key_other", other.account.id, { accessKeyId: "ak_other" }));

  const gone = await handleDevicesRequest(
    new Request(`https://drive.test${DEVICES_ENDPOINT}/key_mac`, { method: "DELETE" }),
    account,
    store,
  );
  assert.equal(gone.status, 204);
  assert.deepEqual(revokedIds, ["ak_mac"]);

  const listed = await handleDevicesRequest(
    new Request(`https://drive.test${DEVICES_ENDPOINT}`),
    account,
    store,
  );
  assert.deepEqual((await listed.json()).keys, []);

  const stolen = await handleDevicesRequest(
    new Request(`https://drive.test${DEVICES_ENDPOINT}/key_other`, { method: "DELETE" }),
    account,
    store,
  );
  assert.equal(stolen.status, 404);
  assert.deepEqual(await stolen.json(), { error: failureMessage("key-not-found") });
  assert.deepEqual(revokedIds, ["ak_mac"]);
});

test("the Worker lists and revokes through the account gate", async () => {
  const made = createTestAuth();
  const { cookie, account } = await signIn(made, "mac@example.com");
  const store = createD1DeviceStore(made.db);
  await store.put(deviceRow("key_mac", account.id));
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: "https://drive.test",
  };

  const denied = await workerFetch(new Request(`https://drive.test${DEVICES_ENDPOINT}`), env);
  assert.equal(denied.status, 401);

  const listed = await workerFetch(
    new Request(`https://drive.test${DEVICES_ENDPOINT}`, { headers: { cookie } }),
    env,
  );
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).keys[0].keyId, "key_mac");

  const forged = await workerFetch(
    new Request(`https://drive.test${DEVICES_ENDPOINT}/key_mac`, {
      method: "DELETE",
      headers: {
        cookie,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    }),
    env,
  );
  assert.equal(forged.status, 403);

  const revoked = await workerFetch(
    new Request(`https://drive.test${DEVICES_ENDPOINT}/key_mac`, {
      method: "DELETE",
      headers: { cookie },
    }),
    env,
  );
  assert.equal(revoked.status, 204);

  const empty = await workerFetch(
    new Request(`https://drive.test${DEVICES_ENDPOINT}`, { headers: { cookie } }),
    env,
  );
  assert.deepEqual((await empty.json()).keys, []);
});

test("the shipped page lists kind and last used, and posts revoke to the route", () => {
  assert.match(page, /const DEVICES_ENDPOINT = "\/api\/devices"/);
  assert.match(page, /<th scope="col">Kind<\/th>/);
  assert.match(page, /<th scope="col">Last used<\/th>/);
  assert.match(page, /method: "DELETE"/);
  assert.match(page, /REVOKE_CONFIRM/);
  assert.match(page, /href="\/devices" aria-current="page">Devices<\/a>/);
});
