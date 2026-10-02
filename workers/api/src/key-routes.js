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
import { errorResponse, json, readJsonObject } from "./http.js";
import { authorizePath } from "./keystore.js";

/** The stand-in store: what src/keystore.js `createMemoryStore` returns and
 * what D1's adapter will have to match (drive#2). */
/** @typedef {ReturnType<typeof import("./keystore.js").createMemoryStore>} KeyStore */

/**
 * GET /v1/keys — the account's keys, no secret (the store keeps only a hash).
 * @param {Request} request
 * @param {{store: KeyStore, account: {id: string, name: string}}} ctx
 */
export function listKeysRoute(request, ctx) {
  if (request.method !== "GET") {
    return errorResponse(405, "That method is not allowed here.", { allow: "GET" });
  }
  // `listKeys` already returns the public shape (publicDevice, one map in the
  // store); mapping here too would read `device.id` off a shape that no longer
  // has it and answer `keyId: undefined` for every key.
  return json({ keys: ctx.store.listKeys(ctx.account) });
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
  const kind = typeof read.body.kind === "string" ? read.body.kind : "agent";
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
  return json(minted, 201);
}

/**
 * DELETE /v1/keys/:keyId — revoke one of the account's own keys. A revoked
 * key is refused by the storage API from the next request on (keystore.js
 * `authenticate`), which is the acceptance bullet.
 * @param {Request} request
 * @param {{store: KeyStore, account: {id: string, name: string}, params: Record<string, string>}} ctx
 */
export function revokeKeyRoute(request, ctx) {
  if (request.method !== "DELETE") {
    return errorResponse(405, "That method is not allowed here.", { allow: "DELETE" });
  }
  const result = ctx.store.revokeKey(ctx.account, ctx.params.keyId);
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
  const body = new Uint8Array(await request.arrayBuffer());
  ctx.store.putObject(authorized.path, body);
  return json(
    { prefix: device.prefix, path: `/${authorized.path}`, sizeBytes: body.byteLength },
    201,
  );
}
