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

import { newId, nowSeconds, sha256Hex } from "./db.js";
import {
  createMemoryDeviceSigninStore,
  DEVICE_CODE_INTERVAL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_TOKEN_TTL_SECONDS,
} from "./device-signin.js";
import {
  AGENT_KEY_TTL_SECONDS,
  CAPABILITIES_BY_KIND,
  KEY_KINDS,
  keyTtlSeconds,
  mintTtlSeconds,
  renewTtlSeconds,
  scopeFor,
  teamScopeFor,
} from "./keyprovider.js";
import { createTeamStore } from "./teams.js";

// Kept as keystore re-exports so the one place that named a device-code,
// device-token or agent-credential window keeps naming it; the values live with
// the store that enforces them (device-signin.js and keyprovider.js), which
// are the stores the D1 deployment uses and the only ones left — the
// per-isolate Maps #122 built them over are gone.
export {
  AGENT_KEY_TTL_SECONDS,
  DEVICE_CODE_INTERVAL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_TOKEN_TTL_SECONDS,
};

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
 *
 * `keyProvider` is where a minted key's credential comes from (build step 1,
 * drive#2). With one, the credential is the storage endpoint's own, scoped by
 * the policy it was minted with, so the endpoint refuses what the key may not
 * do; without one (no storage configured) the credential is the stand-in the
 * api's own storage API verifies. The choice is made once, by the factory.
 * @param {{now?: () => number, randomBytes?: () => Uint8Array, signin?: import("./device-signin.js").DeviceSigninStore, keyProvider?: import("./keyprovider.js").KeyProvider, teams?: import("./teams.js").TeamStore, deviceStore?: {put: (device: Device) => Promise<unknown>, listPublic?: (account: {id: string}) => Promise<ReturnType<typeof publicDevice>[]>, revokeKey?: (account: {id: string}, keyId: string) => Promise<{revoked: true}|{error: string}>, authenticate?: (accessKeyId: string, secret: string) => Promise<Device|null>, renewKey?: (account: {id: string}, keyId: string) => Promise<{renewed: boolean, device: ReturnType<typeof publicDevice>}|{error: string}>}}} [options]
 */
export function createMemoryStore(options = {}) {
  const now = options.now ?? (() => Date.now());
  const keyProvider = options.keyProvider;
  const deviceStore = options.deviceStore;
  const randomBytes = options.randomBytes ?? (() => crypto.getRandomValues(new Uint8Array(16)));
  const signin = options.signin ?? createMemoryDeviceSigninStore({ now, randomBytes });

  /** @type {Map<string, Device>} */
  const devices = new Map();
  /** @type {Map<string, string>} accessKeyId -> device id */
  const byAccessKeyId = new Map();
  /** @type {Map<string, Uint8Array>} full path -> bytes (one global namespace; the prefix scopes what each key sees) */
  const objects = new Map();

  /**
   * The one mint: a scope, an account, a name and a kind become a device row
   * and a credential. Both `mintKey` (a kind's own scope) and `mintTeamKey` (a
   * role's team scope) call it, so there is one place a key row is built and a
   * second way to mint one cannot drift.
   * @param {{id: string}} account
   * @param {import("./keyprovider.js").KeyScope} scope
   * @param {import("./keyprovider.js").KeyKind} kind the kind the capabilities came from, for the row
   * @param {string} name
   */
  async function mintScopedKey(account, scope, kind, name) {
    const keyId = newId("key");
    /** @type {{accessKeyId: string, secret: string, sessionToken: string|null, expiresIn: number|null}} */
    let credential;
    if (keyProvider === undefined) {
      // No storage configured: the stand-in credential the api's own storage
      // API knows, and nothing outside the Worker has ever seen.
      credential = {
        accessKeyId: newId("ak"),
        secret: newId("sk"),
        sessionToken: null,
        expiresIn: null,
      };
    } else {
      const minted = await keyProvider.mint(scope);
      credential = {
        accessKeyId: minted.accessKeyId,
        secret: minted.secret,
        sessionToken: minted.sessionToken ?? null,
        expiresIn: minted.expiresIn ?? null,
      };
    }
    // The hour. The kind's own lifetime is the ceiling, and a provider session
    // that names a shorter one wins: a session that dies in 15 minutes must
    // not be stretched by bookkeeping that outlives it. `null` is a key that
    // never expires, and only a person's own device is one
    // (keyprovider.js KEY_TTL_SECONDS).
    const ttl = mintTtlSeconds(kind, credential.expiresIn);
    /** @type {Device} */
    const device = {
      id: keyId,
      accountId: account.id,
      name,
      kind,
      accessKeyId: credential.accessKeyId,
      secretHash: await sha256Hex(credential.secret),
      prefix: scope.prefix,
      capabilities: [...scope.capabilities],
      createdAt: nowSeconds(now()),
      expiresAt: ttl === null ? null : nowSeconds(now()) + ttl,
      // The lifetime the mint actually gave, so every renewal of this row is
      // measured from the same number and a provider session shorter than the
      // hour cannot be renewed into an hour.
      ttlSeconds: ttl,
      lastSeenAt: null,
      revokedAt: null,
    };
    devices.set(device.id, device);
    byAccessKeyId.set(credential.accessKeyId, device.id);
    if (deviceStore !== undefined) {
      await deviceStore.put(device);
    }
    return {
      keyId,
      accessKeyId: credential.accessKeyId,
      secret: credential.secret,
      sessionToken: credential.sessionToken,
      expiresIn: credential.expiresIn,
      expiresAt: device.expiresAt,
      prefix: device.prefix,
      capabilities: device.capabilities,
    };
  }

  return {
    /** The stand-in's accounts, for the tests and the stand-in's one query.
     * The D1 sign-in store has no accounts of its own (the sign-in flow owns
     * them, src/auth.js), so the map is the in-memory one's only. */
    accounts: signin.accounts ?? new Map(),

    /**
     * Start a device sign-in: a code the CLI polls with and a short code the
     * person types on the approval page. The CLI's `deviceCode` is a secret;
     * the `userCode` is the thing shown to the person.
     * @param {{name?: string}} [request]
     * @returns {Promise<import("./device-signin.js").DeviceCodeResult>}
     */
    async requestDeviceCode(request = {}) {
      return signin.requestDeviceCode(request);
    },

    /**
     * A signed-in person approved the code on the web page: attach their
     * account and mark the code ready. Approving twice is a no-op once the
     * account is attached.
     * @param {string} userCode
     * @param {{id: string, name?: string, email?: string}} [account]
     * @returns {Promise<import("./device-signin.js").ApproveResult>}
     */
    async approveDeviceCode(userCode, account) {
      return signin.approveDeviceCode(userCode, account);
    },

    /**
     * The CLI's poll. `pending` until the page approves, then the device token
     * (shown once) and the account. A code is consumed by the poll that
     * returns the token, so a stolen device code cannot mint a second token.
     * An approved code whose account row is gone (a store restored from a
     * backup, say) answers `expired` rather than a token that names no
     * account: there is nothing for that token to be.
     * @param {string} deviceCode
     * @returns {Promise<import("./device-signin.js").PollResult>}
     */
    pollDeviceCode(deviceCode) {
      return signin.pollDeviceCode(deviceCode);
    },

    /**
     * The account a device token belongs to, or null. The token is hashed
     * before lookup, so the store never holds the value the CLI holds.
     *
     * This is the one place a bearer token becomes an account, so it is where
     * a token past its expiry or one that has been revoked stops being one:
     * both answer `null`, the same answer a token that was never minted gets,
     * so the account gate cannot tell a dead credential from a made-up one.
     * Checking here rather than in each route is the point — there is one
     * lookup, so there is one place to be wrong.
     * @param {string} token
     */
    accountForDeviceToken(token) {
      return signin.accountForDeviceToken(token);
    },

    /**
     * Revoke one device token: `drive logout`'s server-side half, and the way a
     * token that leaked is killed without deleting the account's keys. The raw
     * token is hashed before lookup, exactly as `accountForDeviceToken` hashes
     * it, so the store never holds the value the CLI holds.
     *
     * Revoking is idempotent: a second revoke reports what the first did,
     * because from here on the token is dead either way. A token the store
     * never held answers `not-found` rather than claiming a revoke that
     * changed nothing — that difference is what a caller can promise a person.
     * @param {string} token
     * @returns {Promise<import("./device-signin.js").RevokeResult>}
     */
    revokeDeviceToken(token) {
      return signin.revokeDeviceToken(token);
    },

    /**
     * The token rows that can no longer authenticate: expired or revoked. The
     * bearer lookup already refuses both, so dropping them is housekeeping and
     * never the security boundary — a store that never swept would refuse the
     * same tokens and only hold more rows. Minting calls this on every new
     * token; it is exposed for the tests, and for a deployment that wants to
     * run it on a timer.
     * @param {number} [at] epoch seconds to judge the rows at; injected so a
     *   test can sweep a row it cannot otherwise wait for.
     * @returns {Promise<number>} how many rows went
     */
    async sweepDeviceTokens(at) {
      return signin.sweepDeviceTokens(at);
    },

    /**
     * Mint a key for an account and kind. The secret is returned exactly once;
     * only its hash is kept. `kind` chooses the capabilities from the one
     * table (keyprovider.js), so an agent key can never carry `delete`. An
     * explicit `scope` overrides the kind's default (used for team keys).
     * @param {{id: string}} account
     * @param {{kind?: import("./keyprovider.js").KeyKind, name?: string, scope?: import("./keyprovider.js").KeyScope}} [request]
     */
    async mintKey(account, request = {}) {
      const kind = request.kind ?? "agent";
      if (!KEY_KINDS.includes(/** @type {any} */ (kind))) {
        throw new Error(`Unknown key kind: ${kind}. Known kinds: ${KEY_KINDS.join(", ")}.`);
      }
      const scope =
        request.scope ??
        (kind === "branch"
          ? scopeFor(kind, account.id, { name: request.name })
          : scopeFor(kind, account.id));
      return mintScopedKey(account, scope, kind, request.name ?? kind);
    },

    /**
     * The account's keys, newest last, with no secret (there is no copy).
     * @param {{id: string}} account
     */
    listKeys(account) {
      if (deviceStore?.listPublic) {
        return deviceStore.listPublic(account);
      }
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
      if (deviceStore?.revokeKey) {
        return deviceStore.revokeKey(account, keyId);
      }
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
     * Restart the hour on one of the account's own keys (drive issue #106).
     *
     * This is the renewal a caller makes on purpose: the signed-in device
     * (the account gate) asks for a key's hour to be restarted, which is how
     * a tool that has been idle for an hour — and whose credential therefore
     * died unused — comes back without a person minting a new key. The
     * credential itself does not change, so the tool's own MCP entry keeps
     * working; only the server-side window moves.
     *
     * What it will not do is as fixed as what it will: a key that is not this
     * account's is "not found", a revoked key is refused and its expiry is
     * left exactly as it was (a cancelled agent can never be renewed by
     * anything), and a kind that never expires is handed back untouched. The
     * new window comes from the row's own kind through the one renewal rule
     * (`renewKeyWindow`), so a renewal cannot lengthen a key's life beyond
     * what its mint was given, and it reads no request field at all — the
     * powers on the row are not something a renew can touch.
     * @param {{id: string}} account
     * @param {string} keyId
     * @returns {Promise<{renewed: boolean, device: ReturnType<typeof publicDevice>}|{error: string}>}
     */
    async renewKey(account, keyId) {
      if (deviceStore?.renewKey) {
        return deviceStore.renewKey(account, keyId);
      }
      const device = devices.get(keyId);
      if (device === undefined || device.accountId !== account.id) {
        return { error: "not-found" };
      }
      if (device.revokedAt !== null) {
        return { error: "revoked" };
      }
      const at = nowSeconds(now());
      device.lastSeenAt = at;
      const before = device.expiresAt ?? null;
      device.expiresAt = renewKeyWindow(device, at).expiresAt;
      return { renewed: device.expiresAt !== before, device: publicDevice(device) };
    },

    /**
     * The device a storage key authenticates, or a named refusal. A revoked
     * key, a wrong secret and a credential past its hour are all `null`: the
     * caller learns only that the key does not work, never which half was
     * wrong. That is the same answer a made-up key gets, so a dead credential
     * cannot be told apart from a guess.
     *
     * A credential that works is renewed here, on the one request that proves
     * the key is still held by something using it: the hour restarts, so a
     * tool that is connected keeps working without a person re-running
     * anything. A key whose row is revoked never reaches the renewal — the
     * revocation is checked first, so revoking an agent stops renewal at once
     * and the credential it held dies inside the hour it had left.
     * @param {string} accessKeyId
     * @param {string} secret
     */
    async authenticate(accessKeyId, secret) {
      const deviceId = byAccessKeyId.get(accessKeyId);
      const device = deviceId === undefined ? undefined : devices.get(deviceId);
      if (device !== undefined && device.revokedAt === null) {
        if (!digestsEqual(device.secretHash, await sha256Hex(secret))) {
          return null;
        }
        const at = nowSeconds(now());
        // Absent and null both mean "this kind never expires" (a person's own
        // device key), so both are checked rather than one being assumed.
        if (device.expiresAt !== undefined && device.expiresAt !== null && at >= device.expiresAt) {
          return null;
        }
        device.lastSeenAt = at;
        device.expiresAt = renewKeyWindow(device, at).expiresAt;
        return device;
      }
      if (deviceStore?.authenticate) {
        return deviceStore.authenticate(accessKeyId, secret);
      }
      return null;
    },

    /**
     * Stand-in storage: write bytes at a key's own full path.
     * @param {string} accountId
     * @param {string} path
     * @param {Uint8Array} bytes
     */
    /**
     * Revoke every key one account holds scoped to `teamId`. This is the
     * removal half of drive#20's acceptance: the owner removes a member and
     * their team key stops working from the next request. The device rows are
     * marked revoked here, and the storage list/write routes refuse a revoked
     * key through the same `authenticate` the account's own revoke uses, so
     * there is no separate path where a removed member's key still works.
     * @param {string} accountId
     * @param {string} teamId
     * @returns {Promise<number>} how many keys were revoked
     */
    async revokeTeamKeys(accountId, teamId) {
      // The team prefix is the one every member key carries whatever the role:
      // `teamScopeFor` builds it from the team id, and the role only chooses
      // the capabilities, so one call names the prefix and the capability set
      // is irrelevant to the match.
      const prefix = teamScopeFor("read_only", teamId).prefix;
      let revoked = 0;
      for (const device of devices.values()) {
        if (
          device.accountId === accountId &&
          device.prefix === prefix &&
          device.revokedAt === null
        ) {
          device.revokedAt = nowSeconds(now());
          revoked++;
        }
      }
      return revoked;
    },

    /**
     * Mint a key for a team member's role on the team, scoped to the team
     * prefix with the role's capabilities (keyprovider.js `teamScopeFor`).
     * @param {{id: string}} account
     * @param {string} teamId
     * @param {import("./keyprovider.js").TeamRole} role
     * @param {{name?: string}} [request]
     */
    async mintTeamKey(account, teamId, role, request = {}) {
      const scope = teamScopeFor(role, teamId);
      return mintScopedKey(account, scope, "device", request.name ?? role);
    },

    /**
     * Stand-in storage: write bytes at a full path. One global namespace, the
     * one the bucket has; what a key may touch is its own prefix, which
     * `authorizePath` and the storage routes enforce.
     * @param {string} path
     * @param {Uint8Array} bytes
     */
    putObject(path, bytes) {
      objects.set(path, bytes);
    },

    /**
     * Stand-in storage: the bytes at `path`, or null.
     * @param {string} path
     * @returns {Uint8Array|null}
     */
    getObject(path) {
      const bytes = objects.get(path);
      return bytes ?? null;
    },

    /**
     * Stand-in storage: the paths under `prefix`. The real
     * adapter talks to iDrive e2 / B2 (build step 1); the shape the storage
     * API returns is the same.
     * @param {string} prefix
     * @returns {string[]}
     */
    listObjects(prefix) {
      return [...objects.keys()].filter((path) => path.startsWith(prefix)).sort();
    },

    /**
     * Whether the key may write: its own row's capabilities are the
     * authority, so the storage write route checks the same row
     * the bearer gate used — no second copy of the rule exists.
     * @param {{capabilities: string[]}} device
     */
    canWrite(device) {
      return device.capabilities.includes("write");
    },

    /**
     * The team store: teams, members, and the invite-by-email lookup. The D1
     * store when the deployment binds a database (workers/api/src/teams.js
     * `createD1TeamStore`), and the in-memory stand-in when it does not, so a
     * route reads `store.teams` either way and neither path is special-cased.
     */
    teams: options.teams ?? createTeamStore({ now, accounts: signin.accounts ?? new Map() }),
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
 * @property {number|null} [expiresAt] the epoch second this credential stops
 *   working at, or null when the kind never expires (a person's own device
 *   key). Absent and null are the same claim.
 * @property {number|null} [ttlSeconds] the lifetime the mint actually gave
 *   this credential, which a provider session shorter than the kind's hour
 *   decides. Absent or null means the row predates the column, and the kind's
 *   own hour is then the ceiling. A renewal is measured from here, so a
 *   provider's shorter session is never renewed past its own end.
 * @property {string[]|null} [cappedFrom] the capabilities the cap took, when it did
 */

/**
 * The hour, restarted: the expiry a live credential carries after a request at
 * `at`. This is the one renewal rule, written once so the in-memory stand-in
 * (keystore.js `authenticate`) and the D1 store (devices.js `authenticate`)
 * cannot renew by two different amounts, and a test can name it.
 *
 * Two cases do not renew, and both are deliberate:
 *
 *   - A kind with no lifetime (`KEY_TTL_SECONDS[kind] === null`) has nothing
 *     to renew, so the row is handed back untouched. A person's own device
 *     key must not grow an expiry because a request came in.
 *   - A revoked row is never renewed. Revocation is checked before this runs
 *     in both stores, so this is the second gate, not the only one: a
 *     cancelled agent cannot have its hour restarted by a request that
 *     arrived first.
 *
 * The window length is the lifetime this row's own mint gave it, with the
 * kind's hour as the ceiling (keyprovider.js `renewTtlSeconds`), so a
 * renewal can never hand out a longer life than the mint did — a provider
 * session of 15 minutes is not renewed into an hour. A row's capabilities are
 * not touched here at all — renewing is about time, never about powers.
 *
 * A renewal also never shortens the window the row already carries. Two
 * requests can read the same row and renew in either order, and a write that
 * lands second must not pull the hour back to the earlier one's value: a key
 * that is something is using is the one thing this must not cut short. The
 * rule is written once here rather than in each store's SQL, so the answer a
 * store returns and the row it wrote are the same claim.
 * @param {Device} device
 * @param {number} at epoch seconds, the injected clock's now
 * @returns {Device} the row with its expiry moved to `at + ttl`
 */
export function renewKeyWindow(device, at) {
  const ceiling = keyTtlSeconds(device.kind);
  if (ceiling === null || device.revokedAt !== null) {
    return device;
  }
  const next = at + renewTtlSeconds(device, ceiling);
  const held = device.expiresAt;
  const expiresAt = held === undefined || held === null ? next : Math.max(next, held);
  return { ...device, expiresAt };
}

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
    expiresAt: device.expiresAt ?? null,
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
 * corrupted row cannot grant it. A row that carries its own capabilities wins
 * over the kind's: a team key (drive#20) is minted with the `device` kind so
 * the kind table's lookup still answers, but its row lists the role's own
 * capabilities, and a read-only member's key must not read as delete-capable
 * because of the label. A row with no capabilities field (the tests' bare
 * `{kind}` shape) falls back to the kind table.
 * @param {{kind: string, capabilities?: string[]}} device
 */
export function canDelete(device) {
  if (Array.isArray(device.capabilities)) {
    return device.capabilities.includes("delete");
  }
  const kind = /** @type {import("./keyprovider.js").KeyKind} */ (device.kind);
  return CAPABILITIES_BY_KIND[kind].includes("delete");
}
