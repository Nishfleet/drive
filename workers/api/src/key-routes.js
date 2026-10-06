// The key routes (build step 4, drive#55): mint one storage key per account
// and kind, list them, revoke them, and serve the stand-in storage API the
// keys are scoped for.
//
// A key is minted through the account's signed-in device token (`auth:
// "account"`, the same gate every account route uses); the storage API is a
// different credential on purpose: an agent tool holds an access key id and a
// secret, exactly like the S3 key it will be when the real adapter lands
// (build step 1, drive#2), and presents them with HTTP Basic. That route is
// `auth: "public"` because the key itself is the whole credential; there is
// no signed-in account to gate on.

import { errorResponse, json, readJsonObject } from "../../../core/http.js";
import { authorizePath } from "../../../core/keystore.js";
import { failureMessage } from "../../../core/messages.js";
import { mailFromEnv, notifySecurityEvent } from "../../../core/security-event.js";

/** Kinds drive#551 mails on: an agent, team or branch key, not a device key. */
const KEY_SECURITY_EVENTS = Object.freeze({
  agent: "agent-key-minted",
  team: "team-key-minted",
  branch: "branch-key-minted",
});

/**
 * @param {{env?: unknown, account?: unknown, now?: () => number}} ctx
 * @param {string} event
 * @param {string} [deviceName]
 */
async function notifyFromCtx(ctx, event, deviceName) {
  const mail = mailFromEnv(ctx.env);
  const at = typeof ctx.now === "function" ? ctx.now() : Date.now();
  const account =
    typeof ctx.account === "object" && ctx.account !== null
      ? /** @type {{email?: unknown}} */ (ctx.account)
      : null;
  await notifySecurityEvent({
    email: mail.email,
    mailFrom: mail.mailFrom,
    to: account !== null && typeof account.email === "string" ? account.email : "",
    event,
    deviceName,
    happenedAt: new Date(at).toISOString(),
  });
}

/** The stand-in store: what core/keystore.js `createMemoryStore` returns and
 * what D1's adapter will have to match (drive#2). */
/** @typedef {ReturnType<typeof import("../../../core/keystore.js").createMemoryStore>} KeyStore */

/**
 * GET /v1/keys — the account's keys, no secret (the store keeps only a hash).
 * @param {Request} request
 * @param {{store: KeyStore, account: {id: string, name: string}}} ctx
 */
export async function listKeysRoute(request, ctx) {
  if (request.method !== "GET") {
    return errorResponse(405, "That method is not allowed here.", { allow: "GET" });
  }
  // `listKeys` already returns the public shape (publicDevice, one map in the
  // store); mapping here too would read `device.id` off a shape that no longer
  // has it and answer `keyId: undefined` for every key. The D1 store answers
  // a Promise, the in-memory one a list; Promise.resolve is both.
  return json({ keys: await Promise.resolve(ctx.store.listKeys(ctx.account)) });
}

/**
 * POST /v1/keys — mint a key. The secret is in this response and nowhere
 * else: the store keeps a hash, so it cannot be re-read later.
 * @param {Request} request
 * @param {{store: KeyStore, account: {id: string, name: string}}} ctx
 */
export async function mintKeyRoute(request, ctx) {
  if (request.method !== "POST") {
    return errorResponse(405, "That method is not allowed here.", { allow: "POST" });
  }
  const read = await readJsonObject(request);
  if ("error" in read) {
    return errorResponse(400, read.error);
  }
  // A closed account is refused a new storage key. The account gate already
  // refuses a closed account's bearer token, so the only way here is a browser
  // session cookie, which outlives the close: without this check the closed
  // account could mint a key a moment after close revoked them all (drive#497).
  const closeState = ctx.store?.getCloseState
    ? await ctx.store.getCloseState(ctx.account.id)
    : null;
  if (closeState?.state === "closed") {
    return errorResponse(403, failureMessage("account-closed"));
  }
  // A kind off the wire is not trusted to be one of the four: the store
  // refuses an unknown kind by name (keyprovider.js `keyTtlSeconds`), which is
  // the refusal the 400 below carries. The cast only says to the checker that
  // the string has been read; it does not make it valid.
  const kind =
    typeof read.body.kind === "string"
      ? /** @type {import("../../../core/keyprovider.js").KeyKind} */ (read.body.kind)
      : "agent";
  const name =
    typeof read.body.name === "string" && read.body.name.length > 0 ? read.body.name : undefined;
  let minted;
  try {
    minted = await ctx.store.mintKey(ctx.account, { kind, name });
  } catch (error) {
    // An unknown kind is the caller's mistake, not a server fault, and the
    // message is the keyprovider table's own (it names the known kinds).
    if (error instanceof TypeError || error instanceof Error) {
      return errorResponse(400, error.message);
    }
    throw error;
  }
  const event = Object.hasOwn(KEY_SECURITY_EVENTS, kind)
    ? KEY_SECURITY_EVENTS[/** @type {keyof typeof KEY_SECURITY_EVENTS} */ (kind)]
    : undefined;
  if (event !== undefined) {
    await notifyFromCtx(ctx, event, typeof name === "string" ? name : "a signed-in device");
  }
  return json(minted, 201);
}

/**
 * DELETE /v1/keys/:keyId — revoke one of the account's own keys. A revoked
 * key is refused by the storage API from the next request on (keystore.js
 * `authenticate`), which is the acceptance bullet.
 * @param {Request} request
 * @param {{store: KeyStore, account: {id: string, name: string}, params: Record<string, string>}} ctx
 */
export async function revokeKeyRoute(request, ctx) {
  if (request.method !== "DELETE") {
    return errorResponse(405, "That method is not allowed here.", { allow: "DELETE" });
  }
  const result = await ctx.store.revokeKey(ctx.account, ctx.params.keyId);
  if ("error" in result) {
    return errorResponse(404, "No such key on this account.");
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/**
 * DELETE /v1/keys — sign the account out of every device at once (drive#34,
 * slice drive#236, the decision `nish3451` resolved in the issue on 2026-10-03:
 * a standalone "sign out every device" action, separate from account closing).
 *
 * What it revokes, and why both halves: every live key in `devices` for the
 * resolved account and every live device token in `device_tokens` for it. The
 * key is what opens the storage API and the token is what opens the account
 * gate, so a device that lost only one of the two would still hold half a
 * way in — a tool whose key is dead but whose token still answers 200 on
 * `/v1/keys` can mint itself a new key. One call, one account, both halves.
 *
 * The account comes from the gate, never from the request: the route takes no
 * body and no path parameter, so there is no id a caller could substitute and
 * another account's rows are not reachable from here at all — the same rule
 * `GET /v1/export` follows for the same reason. The counts the stores return
 * are read back off the row change, so what a caller is told is what actually
 * went dead.
 *
 * The answer is 204 with no body, the same answer every other revoke on this
 * registry gives: the caller asked for a state and got it, and the state is
 * the same whatever the counts were. Nothing about the account is echoed back.
 * @param {Request} request
 * @param {{store: KeyStore, account: {id: string, name: string}}} ctx
 */
export async function revokeAllKeysRoute(request, ctx) {
  if (request.method !== "DELETE") {
    return errorResponse(405, "That method is not allowed here.", { allow: "DELETE" });
  }
  // The account id is the one filter on both statements below. A request that
  // reached a handler with no account id is the gate's 401, already answered;
  // the check is written rather than assumed so a direct handler call cannot
  // revoke every row in the table.
  if (typeof ctx.account?.id !== "string" || ctx.account.id === "") {
    return errorResponse(401, "Sign in to sign out of every device.");
  }
  // One call, one account, both halves: the bound D1 device store revokes
  // the account's keys, device tokens, share links and upload requests in the
  // same statement set (devices.js revokeAccountCredentials), and the
  // in-memory stand-in's `revokeAllKeys` calls its own sign-in store for the
  // token half (keystore.js). Keys first, tokens second: a key is the
  // credential that opens the storage API, so if the call fails only partway
  // the keys are already dead and nothing is left holding a way in.
  await ctx.store.revokeAllKeys(ctx.account);
  await notifyFromCtx(ctx, "signed-out-everywhere", "this device");
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/**
 * POST /v1/keys/:keyId/renew — restart the hour on one of the account's own
 * keys (drive issue #106).
 *
 * This is the renewal a caller makes on purpose, and the gate is what makes it
 * safe: the route is behind the account gate, so the credential presented is
 * the signed-in device's token, never the storage key. A leaked agent key
 * therefore cannot renew itself — it holds no device token — which is the whole
 * reason the short-lived credential is worth anything. Revoking the agent stops
 * renewal at once, because the store refuses a revoked row before it moves any
 * window.
 *
 * The answer is the public key row, never a secret: renewing does not change
 * the credential, only the server-side window, so the tool's own MCP entry
 * keeps working untouched and there is nothing new to hand out.
 *
 * The one exception is a device key on a provider that names a session (the
 * STS path, drive#749): there the renewal IS a new credential — the vendor
 * ends the old one when its session ends — so the answer carries the fresh
 * credential to the signed-in device that asked, the same trust the mint
 * answer itself has (the account gate decided this caller may speak for the
 * account). Every other kind's answer is unchanged.
 * @param {Request} request
 * @param {{store: KeyStore, account: {id: string, name: string}, params: Record<string, string>}} ctx
 */
export async function renewKeyRoute(request, ctx) {
  if (request.method !== "POST") {
    return errorResponse(405, "That method is not allowed here.", { allow: "POST" });
  }
  const result = await Promise.resolve(ctx.store.renewKey(ctx.account, ctx.params.keyId));
  if ("error" in result) {
    // A revoked key and another account's key are both refusals, said in the
    // words the revoke route already uses: an id this account does not hold is
    // "no such key", and a revoked one is named, because that is the
    // difference the caller can act on.
    if (result.error === "revoked") {
      return errorResponse(409, "That key is revoked, so its hour cannot be restarted.");
    }
    // The key is at its own agent cap (drive issue #171), so the store took its
    // write powers away in the same call and will not restart an hour on a
    // credential it has withdrawn. The next step is a new key from `drive
    // init`, and nothing about the key is lost: it is still listed, read-only.
    if (result.error === "capped") {
      return errorResponse(409, failureMessage("agent-cap-reached"));
    }
    return errorResponse(404, "No such key on this account.");
  }
  return json(
    result.credential === undefined
      ? result.device
      : { ...result.device, credential: result.credential },
  );
}

/**
 * POST /api/keys/revoke — revoke the key that presents itself. A storage key is
 * the whole credential (Basic auth, the pair an S3 client presents), so the key
 * that can list and write can also turn itself off: that is what `drive logout`
 * calls when the person signs out, and it needs no second credential. The
 * question this route answers is always "is this key off?", never "whose is
 * it?", so it never tells a caller whose key it holds. Answers 204 like
 * DELETE /v1/keys/:keyId; every other answer is a named refusal.
 * @param {Request} request
 * @param {{store: KeyStore}} ctx
 */
export async function revokePresentedKeyRoute(request, ctx) {
  if (request.method !== "POST") {
    return errorResponse(405, "That method is not allowed here.", { allow: "POST" });
  }
  const creds = basicCredentials(request);
  if (creds === null) {
    return errorResponse(401, "Provide the storage key to revoke as HTTP Basic credentials.");
  }
  // authenticate refuses a revoked key and a wrong secret alike, so the only
  // thing this handler can revoke is the key it was handed. The account is
  // read off the device the key belongs to, not off the request.
  const device = await ctx.store.authenticate(creds.accessKeyId, creds.secret);
  if (device === null) {
    return errorResponse(401, "This key was revoked or is not valid.");
  }
  // `revokeKey` is a promise in both of its arms (drive#402), so this awaits
  // rather than reading `"error" in` off a Promise object.
  const result = await ctx.store.revokeKey({ id: device.accountId }, device.id);
  if ("error" in result) {
    return errorResponse(404, "No such key on this account.");
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/**
 * The credentials a storage request presents, or null. Basic auth, the shape
 * an S3 client already uses: the access key id as the user and the secret as
 * the password.
 * @param {Request} request
 * @returns {{accessKeyId: string, secret: string}|null}
 */
export function basicCredentials(request) {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === undefined || encoded === undefined || scheme.toLowerCase() !== "basic") {
    return null;
  }
  let decoded;
  try {
    decoded = atob(encoded.trim());
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return null;
  }
  return { accessKeyId: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
}

/**
 * GET /v1/storage/list?path=… — the stand-in storage API. The key's own
 * prefix decides what exists: a revoked key is 401, and a path outside the
 * key's own folder is 403, never an empty listing that would read like "your
 * folder is empty".
 * @param {Request} request
 * @param {{store: KeyStore, url: URL}} ctx
 */
export async function storageListRoute(request, ctx) {
  if (request.method !== "GET") {
    return errorResponse(405, "That method is not allowed here.", { allow: "GET" });
  }
  const credentials = basicCredentials(request);
  if (credentials === null) {
    return errorResponse(401, "Provide the key's access key id and secret.", {
      "www-authenticate": 'Basic realm="drive"',
    });
  }
  const device = await ctx.store.authenticate(credentials.accessKeyId, credentials.secret);
  if (device === null) {
    return errorResponse(401, "This key was revoked or is not valid.", {
      "www-authenticate": 'Basic realm="drive"',
    });
  }
  const requested = ctx.url.searchParams.get("path") ?? device.prefix;
  const authorized = authorizePath(device, requested);
  if ("error" in authorized) {
    return errorResponse(403, "That path is outside this key's folder.", {
      "www-authenticate": 'Basic realm="drive"',
    });
  }
  const path = authorized.path.endsWith("/") ? authorized.path : `${authorized.path}/`;
  const objects = ctx.store.listObjects(path).map((/** @type {string} */ fullPath) => ({
    path: `/${fullPath}`,
    // The object's key in the stand-in is its account-relative path, so the
    // listing tells a caller only about files under its own prefix.
    url: `${ctx.url.origin}/${fullPath}`,
  }));
  return json({ prefix: device.prefix, path: `/${path}`, objects });
}

/**
 * PUT /v1/storage/object?path=… — the stand-in storage API's write half
 * (drive#20). The key is the whole credential (HTTP Basic, as the listing
 * route takes it), so the write is checked in the same three steps the listing
 * is: the credential, the path's place inside the key's own prefix, and the
 * key's own capabilities. A read-only key is refused here with `403` — that
 * refusal is the issue's "read-only member's write is refused" acceptance, and
 * it is the same boundary `authorizePath` draws for prefixes.
 *
 * The capability gate reads the authenticated device row, not a second copy of
 * the rule, so a role cannot grant two different powers in two places.
 * @param {Request} request
 * @param {{store: any, url: URL}} ctx
 */
export async function storageWriteRoute(request, ctx) {
  if (request.method !== "PUT") {
    return errorResponse(405, "That method is not allowed here.", { allow: "PUT" });
  }
  const credentials = basicCredentials(request);
  if (credentials === null) {
    return errorResponse(401, "Provide the key's access key id and secret.", {
      "www-authenticate": 'Basic realm="drive"',
    });
  }
  const device = await ctx.store.authenticate(credentials.accessKeyId, credentials.secret);
  if (device === null) {
    return errorResponse(401, "This key was revoked or is not valid.", {
      "www-authenticate": 'Basic realm="drive"',
    });
  }
  const requested = ctx.url.searchParams.get("path");
  if (requested === null || requested === "") {
    return errorResponse(400, "Name the path to write with the path query value.");
  }
  const authorized = authorizePath(device, requested);
  if ("error" in authorized) {
    return errorResponse(403, "That path is outside this key's folder.", {
      "www-authenticate": 'Basic realm="drive"',
    });
  }
  // The capability gate, after the prefix gate: a path outside the key's own
  // folder is refused whatever the key may do, and a key without `write` may
  // not write any path inside it.
  if (!ctx.store.canWrite(device)) {
    return errorResponse(403, "This key cannot write to the drive.");
  }
  // The prepaid pause (drive#586): at a $0 balance new writes stop, in the
  // same words the web and `drive status` use. 402, because paying is what
  // starts writes again. Reads on the same key are never asked.
  if (await ctx.store.balancePaused(device)) {
    return errorResponse(402, failureMessage("balance-empty"));
  }
  const body = new Uint8Array(await request.arrayBuffer());
  ctx.store.putObject(authorized.path, body);
  return json(
    { prefix: device.prefix, path: `/${authorized.path}`, sizeBytes: body.byteLength },
    201,
  );
}
