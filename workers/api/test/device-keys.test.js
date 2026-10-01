import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../src/index.js";
import { createMemoryStore } from "../src/keystore.js";

// The build step 4 acceptance walked over HTTP, through the real registry and
// the real dispatcher (not the handlers called directly): a device signs in,
// mints one key per agent tool, and the storage API answers per key.
//
//   - a revoked agent key is refused by the storage API (the #5 bullet), and
//   - each connected tool has its own key, and reading another user's prefix
//     fails.

function baseCtx(store, account) {
  return { env: {}, db: null, store, account, now: () => 0 };
}

/** Walk the device flow and return the signed-in account and its token. */
async function signIn(store, name) {
  const codeRes = await dispatch(
    new Request("https://api.test/v1/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
    baseCtx(store, null),
  );
  assert.equal(codeRes.status, 200);
  const code = await codeRes.json();
  assert.match(code.userCode, /^[A-Z]{4}-[A-Z]{4}$/);

  // The person opens the page, then approves.
  const page = await dispatch(
    new Request(`${code.verificationUriComplete}`),
    baseCtx(store, null),
  );
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(code.userCode));

  const approved = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    }),
    baseCtx(store, null),
  );
  assert.equal(approved.status, 200);

  const tokenRes = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: code.deviceCode }),
    }),
    baseCtx(store, null),
  );
  assert.equal(tokenRes.status, 200);
  const token = await tokenRes.json();
  assert.equal(token.status, "approved");
  assert.equal(token.account.name, name);
  return { account: token.account, deviceToken: token.deviceToken };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function basic(accessKeyId, secret) {
  return { authorization: `Basic ${btoa(`${accessKeyId}:${secret}`)}` };
}

test("the poll is pending before approval, and the token works after it", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const code = store.requestDeviceCode({ name: "Nish's MacBook" });

  const pending = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: code.deviceCode }),
    }),
    baseCtx(store, null),
  );
  assert.deepEqual(await pending.json(), { status: "pending" });

  store.approveDeviceCode(code.userCode);
  const resolved = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: code.deviceCode }),
    }),
    baseCtx(store, null),
  );
  const token = await resolved.json();
  assert.equal(token.status, "approved");

  // The token is what opens /v1/keys.
  const keys = await dispatch(
    new Request("https://api.test/v1/keys", { headers: bearer(token.deviceToken) }),
    baseCtx(store, null),
  );
  assert.equal(keys.status, 200);
  assert.deepEqual(await keys.json(), { keys: [] });
});

test("an anonymous /v1/keys is 401, and a made-up token stays 401", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const anonymous = await dispatch(new Request("https://api.test/v1/keys"), baseCtx(store, null));
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("www-authenticate"), 'Bearer realm="drive"');

  const forged = await dispatch(
    new Request("https://api.test/v1/keys", { headers: bearer("dtok_forged") }),
    baseCtx(store, null),
  );
  assert.equal(forged.status, 401);
});

test("each connected tool gets its own key: two mints are two different keys", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { account, deviceToken } = await signIn(store, "Nish's MacBook");

  const claude = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: { ...bearer(deviceToken), "content-type": "application/json" },
      body: JSON.stringify({ kind: "agent", name: "claude" }),
    }),
    baseCtx(store, null),
  );
  assert.equal(claude.status, 201);
  const claudeKey = await claude.json();

  const codex = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: { ...bearer(deviceToken), "content-type": "application/json" },
      body: JSON.stringify({ kind: "agent", name: "codex" }),
    }),
    baseCtx(store, null),
  );
  const codexKey = await codex.json();

  assert.notEqual(claudeKey.accessKeyId, codexKey.accessKeyId);
  assert.notEqual(claudeKey.secret, codexKey.secret);
  assert.equal(claudeKey.prefix, codexKey.prefix);
  for (const key of [claudeKey, codexKey]) {
    assert.ok(!key.capabilities.includes("delete"), "an agent key has no delete");
  }

  // Revoking one tool's key leaves the other tool working.
  const revoked = await dispatch(
    new Request(`https://api.test/v1/keys/${claudeKey.keyId}`, {
      method: "DELETE",
      headers: bearer(deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(revoked.status, 204);
  store.putObject(account.id, `${codexKey.prefix}notes.txt`, new Uint8Array([1]));
  const still = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${codexKey.prefix}`, {
      headers: basic(codexKey.accessKeyId, codexKey.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(still.status, 200, "the other tool's key still works");
  const gone = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${claudeKey.prefix}`, {
      headers: basic(claudeKey.accessKeyId, claudeKey.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(gone.status, 401, "the revoked key is refused");
});

test("a revoked agent key is refused by the storage API (the #5 bullet)", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { account, deviceToken } = await signIn(store, "Nish's MacBook");
  const minted = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: { ...bearer(deviceToken), "content-type": "application/json" },
      body: JSON.stringify({ kind: "agent", name: "claude" }),
    }),
    baseCtx(store, null),
  );
  const key = await minted.json();
  store.putObject(account.id, `${key.prefix}a.txt`, new Uint8Array([1]));

  const before = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${key.prefix}`, {
      headers: basic(key.accessKeyId, key.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(before.status, 200);
  assert.equal((await before.json()).objects.length, 1);

  const revoked = await dispatch(
    new Request(`https://api.test/v1/keys/${key.keyId}`, {
      method: "DELETE",
      headers: bearer(deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(revoked.status, 204);

  const after = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${key.prefix}`, {
      headers: basic(key.accessKeyId, key.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(after.status, 401);
  assert.equal((await after.text()).includes("a.txt"), false, "a refused key learns nothing");
});

test("reading another user's prefix fails with a 403, not an empty listing", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const first = await signIn(store, "Nish's MacBook");
  const second = await signIn(store, "Nish's other Mac");

  const firstKey = await (
    await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(first.deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "agent", name: "claude" }),
      }),
      baseCtx(store, null),
    )
  ).json();
  const secondKey = await (
    await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(second.deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "agent", name: "claude" }),
      }),
      baseCtx(store, null),
    )
  ).json();

  assert.notEqual(firstKey.prefix, secondKey.prefix);
  store.putObject(second.account.id, `${secondKey.prefix}secret.txt`, new Uint8Array([2]));

  // The first account's key, pointed at the second account's folder.
  const cross = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${secondKey.prefix}`, {
      headers: basic(firstKey.accessKeyId, firstKey.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(cross.status, 403);
  assert.equal(cross.headers.get("www-authenticate"), 'Basic realm="drive"');

  // A traversal out of its own folder is refused the same way.
  const traversal = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${firstKey.prefix}..%2F..%2F${secondKey.prefix}`, {
      headers: basic(firstKey.accessKeyId, firstKey.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(traversal.status, 403);

  // The listing it is allowed is only its own prefix.
  const own = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${firstKey.prefix}`, {
      headers: basic(firstKey.accessKeyId, firstKey.secret),
    }),
    baseCtx(store, null),
  );
  assert.deepEqual((await own.json()).objects, []);
});

test("a storage request with no or bad Basic auth is a 401 with a challenge", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const noHeader = await dispatch(
    new Request("https://api.test/v1/storage/list"),
    baseCtx(store, null),
  );
  assert.equal(noHeader.status, 401);
  assert.equal(noHeader.headers.get("www-authenticate"), 'Basic realm="drive"');

  const notBasic = await dispatch(
    new Request("https://api.test/v1/storage/list", { headers: { authorization: "Bearer x" } }),
    baseCtx(store, null),
  );
  assert.equal(notBasic.status, 401);
});
