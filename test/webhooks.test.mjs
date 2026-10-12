// Outbound webhooks (drive#901): endpoints, signed deliveries, the log, and
// the one event the billing webhook emits.

import assert from "node:assert/strict";
import { test } from "node:test";
import { handleWebhookRequest } from "../core/webhook-routes.js";
import {
  createEndpoint,
  deleteEndpoint,
  emitEvent,
  endpointUrlProblem,
  listDeliveries,
  listEndpoints,
  MAX_ENDPOINTS,
  signDelivery,
} from "../core/webhooks.js";
import { createTestD1 } from "./harness.mjs";

const URL_OK = "https://hooks.example.com/storagebun";

/** A fetch double that records the calls and answers with `status`. */
function recorder(status = 200) {
  /** @type {Array<{url: string, init: any}>} */
  const calls = [];
  const fetchDouble = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      async (/** @type {string} */ url, /** @type {any} */ init) => {
        calls.push({ url, init });
        return new Response(null, { status });
      }
    )
  );
  return { calls, fetch: fetchDouble };
}

test("only a public https address can be an endpoint", () => {
  assert.equal(endpointUrlProblem(URL_OK), null);
  assert.equal(endpointUrlProblem("https://hooks.example.com:8443/x"), null);
  assert.equal(endpointUrlProblem("https://api2.example.co.uk/x"), null);
  for (const bad of [
    "http://hooks.example.com/x",
    "https://user:pw@hooks.example.com/x",
    "https://127.0.0.1/x",
    "https://0x7f.1/x",
    "https://0x7f000001/x",
    "https://2130706433/x",
    "https://017700000001/x",
    "https://10.0.0.1./x",
    "https://hooks.0x7f/x",
    "https://[::1]/x",
    "https://localhost/x",
    "https://printer.local/x",
    "https://intranet/x",
    "not a url",
    "",
    42,
  ]) {
    assert.notEqual(endpointUrlProblem(bad), null, String(bad));
  }
});

test("an endpoint is made with a whsec_ secret shown once, and listed without it", async () => {
  const db = createTestD1();
  const made = await createEndpoint(db, "a1", { url: URL_OK, events: ["balance.topped_up"] });
  assert.ok("endpoint" in made);
  assert.match(made.endpoint.secret, /^whsec_[A-Za-z0-9+/]{43}=$/);
  const listed = await listEndpoints(db, "a1");
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].events, ["balance.topped_up"]);
  assert.equal("secret" in listed[0], false);
  assert.deepEqual(await listEndpoints(db, "someone-else"), []);
});

test("unknown events are refused and the account holds a bounded number", async () => {
  const db = createTestD1();
  const bad = await createEndpoint(db, "a1", { url: URL_OK, events: ["nope"] });
  assert.ok("error" in bad && bad.status === 400);
  for (let i = 0; i < MAX_ENDPOINTS; i += 1) {
    assert.ok("endpoint" in (await createEndpoint(db, "a1", { url: `${URL_OK}/${i}` })));
  }
  const over = await createEndpoint(db, "a1", { url: `${URL_OK}/over` });
  assert.ok("error" in over && over.status === 409);
});

test("an event is signed the way Standard Webhooks signs it, and logged", async () => {
  const db = createTestD1();
  const made = await createEndpoint(db, "a1", { url: URL_OK });
  assert.ok("endpoint" in made);
  const { calls, fetch } = recorder(200);
  await emitEvent(
    db,
    "a1",
    "balance.topped_up",
    { amount_cents: 1500 },
    { fetch, now: 1_800_000_000_000 },
  );
  assert.equal(calls.length, 1);
  const { init } = calls[0];
  assert.equal(init.redirect, "manual");
  const body = String(init.body);
  assert.deepEqual(JSON.parse(body).data, { amount_cents: 1500 });
  assert.equal(JSON.parse(body).type, "balance.topped_up");
  const expected = await signDelivery({
    secret: made.endpoint.secret,
    id: init.headers["webhook-id"],
    timestamp: init.headers["webhook-timestamp"],
    body,
  });
  assert.equal(init.headers["webhook-signature"], expected);
  const log = await listDeliveries(db, "a1", made.endpoint.id);
  assert.equal(log?.length, 1);
  assert.equal(log?.[0].ok, true);
  assert.equal(log?.[0].statusCode, 200);
});

test("an endpoint that listens for other events is skipped, and a failing one is a log row", async () => {
  const db = createTestD1();
  const quiet = await createEndpoint(db, "a1", { url: `${URL_OK}/quiet`, events: ["balance.low"] });
  const loud = await createEndpoint(db, "a1", { url: `${URL_OK}/loud` });
  assert.ok("endpoint" in quiet && "endpoint" in loud);
  const { calls, fetch } = recorder(500);
  await emitEvent(db, "a1", "balance.topped_up", {}, { fetch });
  assert.deepEqual(
    calls.map((c) => c.url),
    [`${URL_OK}/loud`],
  );
  const log = await listDeliveries(db, "a1", loud.endpoint.id);
  assert.equal(log?.[0].ok, false);
  assert.equal(log?.[0].statusCode, 500);
  assert.equal((await listDeliveries(db, "a1", quiet.endpoint.id))?.length, 0);
});

test("a server that cannot be reached never throws out of emitEvent", async () => {
  const db = createTestD1();
  const made = await createEndpoint(db, "a1", { url: URL_OK });
  assert.ok("endpoint" in made);
  const refuse = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      async () => {
        throw new TypeError("refused");
      }
    )
  );
  await emitEvent(db, "a1", "balance.low", {}, { fetch: refuse });
  const log = await listDeliveries(db, "a1", made.endpoint.id);
  assert.equal(log?.[0].ok, false);
  assert.equal(log?.[0].statusCode, null);
  assert.match(log?.[0].error ?? "", /could not be reached/);
});

test("another account's endpoint is a 404 on every route, and a stranger is a 401", async () => {
  const db = createTestD1();
  const made = await createEndpoint(db, "a1", { url: URL_OK });
  assert.ok("endpoint" in made);
  const mine = { id: "a1" };
  const theirs = { id: "a2" };
  const id = made.endpoint.id;
  const req = (/** @type {string} */ method) =>
    new Request("https://storagebun.com/api/webhooks", { method });
  assert.equal((await handleWebhookRequest(req("GET"), null, db)).status, 401);
  assert.equal((await handleWebhookRequest(req("DELETE"), theirs, db, { id })).status, 404);
  assert.equal(
    (await handleWebhookRequest(req("POST"), theirs, db, { id, action: "test" })).status,
    404,
  );
  assert.equal(
    (await handleWebhookRequest(req("GET"), theirs, db, { id, action: "deliveries" })).status,
    404,
  );
  const { fetch } = recorder(204);
  const tested = await handleWebhookRequest(req("POST"), mine, db, { id, action: "test", fetch });
  assert.equal(tested.status, 200);
  assert.equal((await tested.json()).ok, true);
  const gone = await handleWebhookRequest(req("DELETE"), mine, db, { id });
  assert.equal(gone.status, 204);
  assert.equal(await deleteEndpoint(db, "a1", id), false);
});
