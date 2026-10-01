// The key store: the per-kind storage keys and the stand-in object bytes the
// storage API lists. The device sign-in half (codes, the signed-in approval,
// and the minted device token) lives in device-signin.js, which is the store
// that can be backed by D1.
//
// Build step 4 (drive#55) needs three things the api Worker did not have yet:
// a device sign-in flow, one storage key per account and kind (a device key
// for the mount, an agent key per tool), and an authentication check that
// refuses a revoked key and a path outside the key's own prefix. The device
// sign-in flow is delegated; the other two are here.
//
// The real store is D1 plus the storage provider's key API (build step 1,
// drive#2, still parked on the credential decision), so this module is the
// stand-in the routes and the tests run against: the shapes here are the
// shapes the D1 tables in docs/build-spec.md already name (`devices`), and
// swapping it for D1 is a new factory with the same methods, not a route
// change. Secrets are SHA-256 hashed on the way in and never stored or
// returned again (docs/build-spec.md, "The B2 secret is shown once to the
// device, never stored").
//
// Nothing here reads a request or a clock of its own: the clock is injected
// (now) so a device code can be tested as expired without sleeping, and the
// routes below own the HTTP shape.
import { CAPABILITIES_BY_KIND, KEY_KINDS, scopeFor } from "./keyprovider.js";
import { createMemoryDeviceSigninStore, DEVICE_CODE_TTL_SECONDS, DEVICE_CODE_INTERVAL_SECONDS } from "./device-signin.js";
import { newId, nowSeconds, sha256Hex } from "./db.js";

// Kept as keystore re-exports so the one place that named the device-code TTL
// keeps naming it; the values live with the store that enforces them
// (device-signin.js), which is the store the D1 deployment uses.
export { DEVICE_CODE_TTL_SECONDS, DEVICE_CODE_INTERVAL_SECONDS };

/**
 * Constant-time string comparison for two equal-length hex digests. A plain
 * `===` on a secret hash leaks, through timing, how many leading characters
 * were right; the lengths here are fixed by SHA-256, so the loop is a full
 * comparison either way.
 * @param {string} left
 * @param {string} right
 */
function digestsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The stand-in key and object store. One instance per Worker isolate
 * (src/index.js), the same choice the Web Files page made for its bytes
 * (src/files.js) until the real store lands.
 *
 * The device sign-in half is delegated to `options.signin`, so the deployment
 * chooses the D1 store (device-signin.js `createD1DeviceSigninStore`) and the
 * tests and a database-less deployment keep the in-memory one. The delegation
 * is the one call site the two implementations plug into; nothing else in this
 * module knows which backend is underneath.
 * @param {{now?: () => number, randomBytes?: () => Uint8Array, signin?: object}} [options]
 */
export function createMemoryStore(options = {}) {
  const now = options.now ?? (() => Date.now());
  const randomBytes =
    options.randomBytes ?? (() => crypto.getRandomValues(new Uint8Array(16)));
  const signin = options.signin ?? createMemoryDeviceSigninStore({ now, randomBytes });

  /** @type {Map<string, Device>} */
  const devices = new Map();
  /** @type {Map<string, string>} accessKeyId -> device id */
  const byAccessKeyId = new Map();
  /** @type {Map<string, Map<string, Uint8Array>>} account id -> full path -> bytes */
  const objects = new Map();

  /** @param {string} accountId */
  function objectTable(accountId) {
    let table = objects.get(accountId);
    if (table === undefined) {
      table = new Map();
      objects.set(accountId, table);
    }
    return table;
  }

  return {
    /**
     * Start a device sign-in: a code the CLI polls with and a short code the
     * person types on the approval page. The CLI's `deviceCode` is a secret;
     * the `userCode` is the thing shown to the person.
     * @param {{name?: string}} [request]
     */
    requestDeviceCode(request = {}) {
      return signin.requestDeviceCode(request);
    },

    /**
     * A signed-in person approved the code on the web page: attach their
     * account and mark the code ready. Approving twice is a no-op once the
     * account is attached.
     * @param {string} userCode
     * @param {{id: string, name?: string, email?: string}} account
     */
    approveDeviceCode(userCode, account) {
      return signin.approveDeviceCode(userCode, account);
    },

    /**
     * The CLI's poll. `pending` until the page approves, then the device token
     * (shown once) and the account. A code is consumed by the poll that
     * returns the token, so a stolen device code cannot mint a second token.
     * @param {string} deviceCode
     */
    pollDeviceCode(deviceCode) {
      return signin.pollDeviceCode(deviceCode);
    },

    /**
     * The account a device token belongs to, or null. The token is hashed
     * before lookup, so the store never holds the value the CLI holds.
     * @param {string} token
     */
    accountForDeviceToken(token) {
      return signin.accountForDeviceToken(token);
    },

    /**
     * Mint a key for an account and kind. The secret is returned exactly once;
     * only its hash is kept. `kind` chooses the capabilities from the one
     * table (keyprovider.js), so an agent key can never carry `delete`.
     * @param {{id: string}} account
     * @param {{kind?: string, name?: string}} [request]
     */
    async mintKey(account, request = {}) {
      const kind = (request.kind ?? "agent");
      if (!KEY_KINDS.includes(/** @type {any} */ (kind))) {
        throw new Error(`Unknown key kind: ${kind}. Known kinds: ${KEY_KINDS.join(", ")}.`);
      }
      const scope =
        kind === "branch"
          ? scopeFor(/** @type {any} */ (kind), account.id, { name: request.name })
          : scopeFor(/** @type {any} */ (kind), account.id);
      const keyId = newId("key");
      const accessKeyId = newId("ak");
      const secret = newId("sk");
      /** @type {Device} */
      const device = {
        id: keyId,
        accountId: account.id,
        name: request.name ?? kind,
        kind: /** @type {any} */ (kind),
        accessKeyId,
        secretHash: await sha256Hex(secret),
        prefix: scope.prefix,
        capabilities: [...scope.capabilities],
        createdAt: nowSeconds(now()),
        lastSeenAt: null,
        revokedAt: null,
      };
      devices.set(device.id, device);
      byAccessKeyId.set(accessKeyId, device.id);
      return { keyId, accessKeyId, secret, prefix: device.prefix, capabilities: device.capabilities };
    },

    /**
     * The account's keys, newest last, with no secret (there is no copy).
     * @param {{id: string}} account
     */
    listKeys(account) {
      return [...devices.values()]
        .filter((device) => device.accountId === account.id)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(publicDevice);
    },

    /**
     * Revoke one of the account's own keys. An id from another account is
     * "not found", not a revoke.
     * @param {{id: string}} account
     * @param {string} keyId
     */
    revokeKey(account, keyId) {
      const device = devices.get(keyId);
      if (device === undefined || device.accountId !== account.id) {
        return { error: "not-found" };
      }
      if (device.revokedAt === null) {
        device.revokedAt = nowSeconds(now());
      }
      return { revoked: true };
    },

    /**
     * The device a storage key authenticates, or a named refusal. A revoked
     * key and a wrong secret are both `null`: the caller learns only that the
     * key does not work, never which half was wrong.
     * @param {string} accessKeyId
     * @param {string} secret
     */
    async authenticate(accessKeyId, secret) {
      const deviceId = byAccessKeyId.get(accessKeyId);
      const device = deviceId === undefined ? undefined : devices.get(deviceId);
      if (device === undefined) {
        return null;
      }
      if (device.revokedAt !== null) {
        return null;
      }
      if (!digestsEqual(device.secretHash, await sha256Hex(secret))) {
        return null;
      }
      device.lastSeenAt = nowSeconds(now());
      return device;
    },

    /**
     * Stand-in storage: write bytes at a key's own full path.
     * @param {string} accountId
     * @param {string} path
     * @param {Uint8Array} bytes
     */
    putObject(accountId, path, bytes) {
      objectTable(accountId).set(path, bytes);
    },

    /**
     * Stand-in storage: the paths under `prefix` for an account. The real
     * adapter talks to iDrive e2 / B2 (build step 1); the shape the storage
     * API returns is the same.
     * @param {string} accountId
     * @param {string} prefix
     * @returns {string[]}
     */
    listObjects(accountId, prefix) {
      const table = objectTable(accountId);
      return [...table.keys()].filter((path) => path.startsWith(prefix)).sort();
    },
  };
}

/**
 * A device row as it is stored. The secret is a hash; the device row never
 * carries a value a caller could present.
 * @typedef {object} Device
 * @property {string} id
 * @property {string} accountId
 * @property {string} name
 * @property {"device"|"agent"|"s3"|"branch"} kind
 * @property {string} accessKeyId
 * @property {string} secretHash
 * @property {string} prefix
 * @property {string[]} capabilities
 * @property {number} createdAt
 * @property {number|null} lastSeenAt
 * @property {number|null} revokedAt
 */

/**
 * A device row with nothing secret in it: what /v1/keys returns.
 * @param {Device} device
 */
export function publicDevice(device) {
  return {
    keyId: device.id,
    name: device.name,
    kind: device.kind,
    prefix: device.prefix,
    capabilities: device.capabilities,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
  };
}

/**
 * Whether a path is inside the key's own prefix. The prefix is the safety
 * boundary (keyprovider.js `scopeFor`): a key may only ever name a path under
 * its own account folder, so a path that escapes it is a refusal, and `..`
 * or a leading slash are the shapes that would escape it. The path is
 * returned normalized (no leading slash) so callers compare one form.
 * @param {{prefix: string}} device
 * @param {unknown} rawPath
 * @returns {{path: string}|{error: string}}
 */
export function authorizePath(device, rawPath) {
  const path = typeof rawPath === "string" ? rawPath.replace(/^\/+/, "") : "";
  if (path.split("/").includes("..")) {
    return { error: "outside-prefix" };
  }
  if (!path.startsWith(device.prefix)) {
    return { error: "outside-prefix" };
  }
  return { path };
}

/**
 * Whether a key may delete. An agent, s3 or branch key may not
 * (docs/build-spec.md, "Keys and safety"); the one table is the source, so a
 * corrupted row cannot grant it.
 * @param {{kind: string}} device
 */
export function canDelete(device) {
  const kind = /** @type {import("./keyprovider.js").KeyKind} */ (device.kind);
  return CAPABILITIES_BY_KIND[kind].includes("delete");
}
