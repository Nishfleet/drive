import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_KEY_TTL_SECONDS, createMemoryStore } from "../../../core/keystore.js";
import { dispatch } from "../src/index.js";
import {
  baseCtx,
  basic,
  bearer,
  fixedClock,
  makeAccounts,
  makeRateLimiter,
  SESSION_COOKIE,
  signIn,
} from "./device-keys-helpers.js";

// another site rendered on the person's behalf must be refused before it can
// spend the rate-limit quota. The page that served the form is same-origin, so
// that one still works.
test("an approval from another site is 403 and a same-origin one is approved", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({ id: "acct_csrf", name: "Csrf", email: "c@example.com" });
  const code = await store.requestDeviceCode({ name: "laptop" });
  const post = (/** @type {string|null} */ origin) =>
    dispatch(
      new Request("https://api.test/v1/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${SESSION_COOKIE}=${sessionToken}`,
          ...(origin === null ? {} : { origin }),
        },
        body: `user_code=${encodeURIComponent(code.userCode)}`,
      }),
      baseCtx(store, null, { accounts }),
    );

  const crossSite = await post("https://attacker.test");
  assert.equal(crossSite.status, 403);
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "pending" });

  const sameSite = await post("https://api.test");
  assert.equal(sameSite.status, 200);
  const connected = await sameSite.text();
  assert.match(connected, /This Mac is connected\. You can close this tab\./);
  assert.doesNotMatch(connected, /<form/);
  assert.equal((await store.pollDeviceCode(code.deviceCode)).status, "approved");
});

test("a signed-out approve link goes to sign-in, never raw JSON (drive#459)", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const accounts = makeAccounts();
  const code = await store.requestDeviceCode({ name: "laptop" });
  const page = await dispatch(
    new Request(
      `https://api.test/v1/device/approve?user_code=${encodeURIComponent(code.userCode)}`,
    ),
    baseCtx(store, null, { accounts }),
  );
  assert.equal(page.status, 302, "signed out must redirect, not 401 JSON");
  const location = page.headers.get("location");
  assert.match(String(location), /\/signin\?/);
  const next = new URL(String(location), "https://api.test").searchParams.get("next");
  assert.equal(next, `/v1/device/approve?user_code=${code.userCode}`);
  const cookie = page.headers.get("set-cookie") ?? "";
  assert.match(cookie, /drive_after_signin=/);
  const body = await page.text();
  assert.doesNotMatch(body, /"error"/);
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "pending" });
});

test("the approve page shows the device name and time and never pre-fills the code", async () => {
  const store = createMemoryStore({ now: () => Date.parse("2026-10-05T12:00:00.000Z") });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({
    id: "acct_page",
    name: "Page",
    email: "page@example.com",
  });
  const code = await store.requestDeviceCode({ name: "office laptop" });
  const page = await dispatch(
    new Request(
      `https://api.test/v1/device/approve?user_code=${encodeURIComponent(code.userCode)}`,
      { headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` } },
    ),
    baseCtx(store, null, { accounts }),
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /office laptop/);
  assert.match(html, /2026-10-05T12:00:00.000Z/);
  assert.match(html, /value=""/);
  assert.doesNotMatch(html, new RegExp(`value="${code.userCode}"`));

  // The name is store data rendered into HTML text, so a script tag arrives
  // escaped and nothing else on the page changes (drive#558).
  const quoted = await store.requestDeviceCode({ name: "<script>alert(1)</script>" });
  const hostile = await dispatch(
    new Request(
      `https://api.test/v1/device/approve?user_code=${encodeURIComponent(quoted.userCode)}`,
      { headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` } },
    ),
    baseCtx(store, null, { accounts }),
  );
  assert.equal(hostile.status, 200);
  const hostileBody = await hostile.text();
  assert.match(hostileBody, /&lt;script&gt;/);
  assert.doesNotMatch(hostileBody, /<script>alert/);
});

test("a code is still pending and approvable at minute 12 (drive#558)", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({ id: "acct_12m", name: "Twelve", email: "12@example.com" });
  const code = await store.requestDeviceCode({ name: "laptop" });

  // The mail round trip fits inside the code's life now: at minute 12 the CLI
  // is still waiting, and the page can still approve.
  clock.advance(12 * 60);
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "pending" });
  const approved = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
        origin: "https://api.test",
      },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    }),
    baseCtx(store, null, { accounts }),
  );
  assert.equal(approved.status, 200);
  const minted = await store.pollDeviceCode(code.deviceCode);
  assert.equal(minted.status, "approved", "the minute-12 approval minted a sign-in");
});

test("approving a device mails the owner a notice", async () => {
  const store = createMemoryStore({ now: () => Date.parse("2026-10-05T12:00:00.000Z") });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({
    id: "acct_mail",
    name: "Mail",
    email: "mail@example.com",
  });
  const code = await store.requestDeviceCode({ name: "office laptop" });
  /** @type {Array<Record<string, unknown>>} */
  const sent = [];
  const mailed = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
        origin: "https://api.test",
      },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    }),
    baseCtx(store, null, {
      accounts,
      env: {
        EMAIL: {
          send: async (/** @type {Record<string, unknown>} */ message) => {
            sent.push(message);
            return { messageId: "mid_notice" };
          },
        },
        MAIL_FROM: "drive@example.com",
      },
    }),
  );
  assert.equal(mailed.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "mail@example.com");
  assert.equal(/** @type {{email: string}} */ (sent[0].from).email, "drive@example.com");
  assert.match(String(sent[0].subject), /device asked to connect/i);
  assert.match(String(sent[0].text), /office laptop/);
});

test("a mailer that refuses is visible, and the approval stays committed", async () => {
  // The deliberate shape, pinned so it cannot drift (drive#518 review): the
  // mailer's refusal is not swallowed into a success page, and it does not
  // un-approve the device either — the approval committed first, so the
  // owner's retry says already-approved instead of minting a second
  // credential, and the failed notice is a log line, not a lost signal.
  const store = createMemoryStore({ now: () => Date.parse("2026-10-05T12:00:00.000Z") });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({
    id: "acct_mailfail",
    name: "Mail",
    email: "mailfail@example.com",
  });
  const code = await store.requestDeviceCode({ name: "office laptop" });
  const refused = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
        origin: "https://api.test",
      },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    }),
    baseCtx(store, null, {
      accounts,
      env: {
        EMAIL: {
          send: async () => {
            throw new Error("vendor down");
          },
        },
        MAIL_FROM: "drive@example.com",
      },
    }),
  );
  assert.equal(refused.status, 500, "a refusing mailer is not read as success");
  const polled = await store.pollDeviceCode(code.deviceCode);
  assert.equal(polled.status, "approved", "the approval itself is not undone");
});

test("the approve page GET is rate limited before the store is read", async () => {
  // The page names a pending code's device and time, so an unlimited version
  // is an existence oracle for codes a phishing page is cycling. The GET
  // runs its own bucket of the same edge limiter the POSTs run.
  const store = createMemoryStore({ now: () => Date.parse("2026-10-05T12:00:00.000Z") });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({
    id: "acct_pagelimit",
    name: "Page",
    email: "pagelimit@example.com",
  });
  const code = await store.requestDeviceCode({ name: "office laptop" });
  /** @param {ReturnType<typeof makeRateLimiter>} limiter */
  const get = (limiter) =>
    dispatch(
      new Request(
        `https://api.test/v1/device/approve?user_code=${encodeURIComponent(code.userCode)}`,
        { headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` } },
      ),
      baseCtx(store, null, {
        accounts,
        env: {
          DEVICE_RATE_LIMITER: limiter,
          DEVICE_GLOBAL_RATE_LIMITER: makeRateLimiter(),
        },
      }),
    );
  const denied = await get(makeRateLimiter({ success: false }));
  assert.equal(denied.status, 429);
  const allowed = await get(makeRateLimiter());
  assert.equal(allowed.status, 200);
});

test("a branch named '.' or '..' is refused with 400", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  for (const name of [".", ".."]) {
    const answer = await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "branch", name }),
      }),
      baseCtx(store, null),
    );
    assert.equal(answer.status, 400, `branch name ${JSON.stringify(name)} must be 400`);
  }
});

// ---- the one-hour agent credential (drive issue #106) ----
//
// The issue's finish line, through the routes a real request takes: an expired
// credential is refused, a renewed one works, a revoked agent cannot renew, and
// a short-lived key can never delete. The store's own unit proof is in
// workers/api/test/keystore.test.js; this file is the proof that the routes
// enforce it rather than trusting a caller to.

test("an expired agent credential is refused, and a used one is renewed", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  const mint = async () =>
    (
      await dispatch(
        new Request("https://api.test/v1/keys", {
          method: "POST",
          headers: { ...bearer(deviceToken), "content-type": "application/json" },
          body: JSON.stringify({ kind: "agent", name: "claude" }),
        }),
        baseCtx(store, null),
      )
    ).json();
  const mintedAt = clock.now() / 1000;
  const unused = await mint();
  // The mint answer carries the hour, and the key is as weak as it always was:
  // renewing a credential is about time, never about powers.
  assert.equal(unused.expiresAt, mintedAt + AGENT_KEY_TTL_SECONDS);
  assert.ok(!unused.capabilities.includes("delete"), "the short-lived key cannot delete");

  store.putObject(`${unused.prefix}a.txt`, new Uint8Array([1]));
  clock.advance(AGENT_KEY_TTL_SECONDS + 1);
  const expired = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${unused.prefix}`, {
      headers: basic(unused.accessKeyId, unused.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(expired.status, 401, "a credential past its hour is refused");
  assert.equal((await expired.text()).includes("a.txt"), false, "and learns nothing");

  // A key something is using is renewed on the request that proves it: half an
  // hour in it works, and it still works an hour and a minute after the mint.
  const used = await mint();
  clock.advance(-(AGENT_KEY_TTL_SECONDS + 1));
  assert.equal(clock.now() / 1000, mintedAt);
  clock.advance(AGENT_KEY_TTL_SECONDS / 2);
  const live = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${used.prefix}`, {
      headers: basic(used.accessKeyId, used.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(live.status, 200, "the connected tool's key still works");
  clock.advance(AGENT_KEY_TTL_SECONDS / 2 + 1);
  const stillLive = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${used.prefix}`, {
      headers: basic(used.accessKeyId, used.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(stillLive.status, 200, "and it was renewed past the same instant");
});

test("a revoked agent cannot renew: the hour is not restarted after the revoke", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  const minted = await (
    await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "agent", name: "claude" }),
      }),
      baseCtx(store, null),
    )
  ).json();
  const revoked = await dispatch(
    new Request(`https://api.test/v1/keys/${minted.keyId}`, {
      method: "DELETE",
      headers: bearer(deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(revoked.status, 204);
  // A request that arrives after the revoke is refused, so it cannot restart
  // the hour the credential had left.
  clock.advance(AGENT_KEY_TTL_SECONDS * 3);
  const after = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${minted.prefix}`, {
      headers: basic(minted.accessKeyId, minted.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(after.status, 401);
  const listed = /** @type {{keys: Array<{keyId: string, expiresAt: number|null}>}} */ (
    await (
      await dispatch(
        new Request("https://api.test/v1/keys", { headers: bearer(deviceToken) }),
        baseCtx(store, null),
      )
    ).json()
  );
  const found = listed.keys.find((key) => key.keyId === minted.keyId);
  assert.ok(found, "the minted key is listed");
  assert.equal(
    found.expiresAt,
    minted.expiresAt,
    "the refused requests left the expiry exactly as the mint wrote it",
  );
});

test("a person's own device key is listed with no expiry, so sign-in is unchanged", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: { ...bearer(deviceToken), "content-type": "application/json" },
      body: JSON.stringify({ kind: "device", name: "laptop" }),
    }),
    baseCtx(store, null),
  );
  clock.advance(AGENT_KEY_TTL_SECONDS * 24);
  const listed = await (
    await dispatch(
      new Request("https://api.test/v1/keys", { headers: bearer(deviceToken) }),
      baseCtx(store, null),
    )
  ).json();
  assert.equal(listed.keys.length, 1);
  assert.equal(listed.keys[0].expiresAt, null, "a device key never expires");
});

test("a signed-in device restarts an idle tool's hour, and the key works again", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  const minted = await (
    await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "agent", name: "claude" }),
      }),
      baseCtx(store, null),
    )
  ).json();
  store.putObject(`${minted.prefix}a.txt`, new Uint8Array([1]));
  // The tool sat idle for longer than its hour, so its credential died unused.
  clock.advance(AGENT_KEY_TTL_SECONDS + 60);
  const dead = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${minted.prefix}`, {
      headers: basic(minted.accessKeyId, minted.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(dead.status, 401, "an idle tool's credential expired");

  const renewed = await dispatch(
    new Request(`https://api.test/v1/keys/${minted.keyId}/renew`, {
      method: "POST",
      headers: bearer(deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(renewed.status, 200);
  const row = await renewed.json();
  assert.equal(row.expiresAt, clock.now() / 1000 + AGENT_KEY_TTL_SECONDS);
  // The answer is the public row: renewing hands out no secret, so the tool's
  // own MCP entry still holds the credential that now works again.
  assert.ok(!("secret" in row), "a renewal returns no secret");

  const alive = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${minted.prefix}`, {
      headers: basic(minted.accessKeyId, minted.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(alive.status, 200, "the same credential works again");
  assert.equal((await alive.json()).objects.length, 1);
});

test("a revoked key cannot be renewed, and a leaked storage key cannot renew itself", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const first = await signIn(store, "Nish's MacBook");
  const second = await signIn(store, "Nish's other Mac");
  const minted = await (
    await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(first.deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "agent", name: "claude" }),
      }),
      baseCtx(store, null),
    )
  ).json();
  const revoked = await dispatch(
    new Request(`https://api.test/v1/keys/${minted.keyId}`, {
      method: "DELETE",
      headers: bearer(first.deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(revoked.status, 204);
  clock.advance(AGENT_KEY_TTL_SECONDS * 3);

  const renewRevoked = await dispatch(
    new Request(`https://api.test/v1/keys/${minted.keyId}/renew`, {
      method: "POST",
      headers: bearer(first.deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(renewRevoked.status, 409, "a revoked key is refused, not renewed");
  const listed = /** @type {{keys: Array<{keyId: string, expiresAt: number|null}>}} */ (
    await (
      await dispatch(
        new Request("https://api.test/v1/keys", { headers: bearer(first.deviceToken) }),
        baseCtx(store, null),
      )
    ).json()
  );
  const foundRevoked = listed.keys.find((key) => key.keyId === minted.keyId);
  assert.ok(foundRevoked, "the revoked key is still listed");
  assert.equal(foundRevoked.expiresAt, minted.expiresAt, "the refused renew moved no window");

  // Another account's key is not this account's to renew.
  const cross = await dispatch(
    new Request(`https://api.test/v1/keys/${minted.keyId}/renew`, {
      method: "POST",
      headers: bearer(second.deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(cross.status, 404);

  // And the leaked storage key on its own: the gate is the device token, so a
  // credential that is only a storage key is a 401 here. That is what stops a
  // leaked agent key from restarting its own hour.
  const leaked = await dispatch(
    new Request(`https://api.test/v1/keys/${minted.keyId}/renew`, {
      method: "POST",
      headers: basic(minted.accessKeyId, minted.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(leaked.status, 401);
});

test("renewing a person's own device key changes nothing: it never expires", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  const minted = await (
    await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "device", name: "laptop" }),
      }),
      baseCtx(store, null),
    )
  ).json();
  const renewed = await dispatch(
    new Request(`https://api.test/v1/keys/${minted.keyId}/renew`, {
      method: "POST",
      headers: bearer(deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(renewed.status, 200);
  const row = await renewed.json();
  assert.equal(row.expiresAt, null, "a device key is handed no expiry by a renew either");
});
