// The device sign-in store (RFC 8628): the pending code the CLI asks for, the
// short user code the person types on the approval page, and the device token
// the CLI picks up when a signed-in person approves it.
//
// Build step 4 (drive#55) first kept this in a per-isolate `Map`
// (workers/api/src/keystore.js), which the midnight review of #122 found
// unsafe: a Worker has many instances, so a code started on one was lost on
// another and every in-flight sign-in died with the isolate (drive issue
// #136 finding 1). This module is the real store: a D1-backed implementation
// (`createD1DeviceSigninStore`) whose row is written by `/v1/device/code`,
// moved to `approved` by the signed-in approval page, and consumed by
// `/v1/device/token`, across instances and restarts. The in-memory
// implementation is kept for the tests and a deployment with no database —
// the same memory-stand-in/real-adapter split src/files.js uses.
//
// The device code and the minted token are secrets, so both are stored only as
// SHA-256 digests (`workers/api/src/db.js` sha256Hex), the same rule the key
// store follows. The short user code is written as-typed because the approval
// page looks the row up by it; it is not a credential alone, because approval
// also requires a signed-in account (drive issue #136 finding 2).
//
// `account` is the signed-in account the approval page passes in
// (`{id, name, email}`, resolved by the src/status.js `signedInAccount` gate);
// its fields are copied onto the code row, so a poll on another instance can
// name the owner without this module holding an accounts table of its own.
import { first, newId, nowSeconds, run, sha256Hex } from "./db.js";

// How long a device code is good for, and how often the CLI may poll
// (RFC 8628's device_code and interval). Ten minutes is long enough to find a
// phone, short enough that a code left on a terminal screen dies.
export const DEVICE_CODE_TTL_SECONDS = 600;
export const DEVICE_CODE_INTERVAL_SECONDS = 5;

// The user code a person types on the approval page. The alphabet leaves out
// vowels (so a code cannot spell a word) and the look-alike 0/O and 1/I/L
// (so a code read aloud cannot be mistyped into another valid one).
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;

/**
 * A random user code, grouped as XXXX-XXXX for reading aloud. The alphabet's
 * 20 letters do not divide 256 evenly, so a byte above the last full group is
 * rejected rather than biased toward the alphabet's low end.
 * @param {() => Uint8Array} randomBytes
 */
export function newUserCode(randomBytes) {
  const bytes = randomBytes();
  const limit = Math.floor(256 / USER_CODE_ALPHABET.length) * USER_CODE_ALPHABET.length;
  let out = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    let byte = bytes[i];
    while (byte >= limit) {
      // Reached only when the injected generator returns a high byte; the
      // platform generator (crypto.getRandomValues) feeds it fresh bytes.
      byte = randomBytes()[0];
    }
    out += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    if (i === 3) {
      out += "-";
    }
  }
  return out;
}

/**
 * The one account name before a person has one: named for where it signed in.
 * Used only by the in-memory store over a device name; the real flow names the
 * account at sign-in, not here.
 * @param {unknown} deviceName
 */
function deviceLabel(deviceName) {
  const trimmed = typeof deviceName === "string" ? deviceName.trim() : "";
  return trimmed.length > 0 ? trimmed : "My drive";
}

/**
 * The account shape copied onto a code/token row.
 * @param {{id: string, name?: string, email?: string}} account
 */
function accountFields(account) {
  return {
    id: account.id,
    name: typeof account.name === "string" && account.name.length > 0 ? account.name : account.id,
    email: typeof account.email === "string" ? account.email : "",
  };
}

/**
 * The in-memory device sign-in store: the same four methods as the D1 one,
 * over Maps, for the tests and a deployment with no database binding. One
 * instance per isolate, exactly the stand-in the D1 store replaces.
 * @param {{now?: () => number, randomBytes?: () => Uint8Array}} [options]
 */
export function createMemoryDeviceSigninStore(options = {}) {
  const now = options.now ?? (() => Date.now());
  const randomBytes = options.randomBytes ?? (() => crypto.getRandomValues(new Uint8Array(16)));

  /** @type {Map<string, {deviceCode: string, userCode: string, name: string, status: string, accountId: string|null, createdAt: number, expiresAt: number}>} */
  const byDeviceCode = new Map();
  /** @type {Map<string, string>} user code -> device code */
  const byUserCode = new Map();
  /** @type {Map<string, {account: object, createdAt: number}>} token hash -> token */
  const tokens = new Map();
  /** @type {Map<string, object>} account id -> account the stand-in holds */
  const accounts = new Map();

  return {
    /** Every account this stand-in holds, so a test can model a row that is
     * gone (the store restored from a backup) the way the real account store
     * can lose one. */
    accounts,
    /**
     * Start a device sign-in: a code the CLI polls with, and a short code the
     * person types on the approval page.
     * @param {{name?: string}} [request]
     */
    requestDeviceCode(request = {}) {
      const deviceCode = newId("dev");
      const userCode = newUserCode(randomBytes);
      const createdAt = nowSeconds(now());
      byDeviceCode.set(deviceCode, {
        deviceCode,
        userCode,
        name: deviceLabel(request.name),
        status: "pending",
        accountId: null,
        createdAt,
        expiresAt: createdAt + DEVICE_CODE_TTL_SECONDS,
      });
      byUserCode.set(userCode, deviceCode);
      return {
        deviceCode,
        userCode,
        expiresIn: DEVICE_CODE_TTL_SECONDS,
        interval: DEVICE_CODE_INTERVAL_SECONDS,
      };
    },

    /**
     * A signed-in person approved the code: attach their account and mark the
     * code ready. Approving twice is a no-op once the account is attached.
     *
     * With no account passed (the stand-in's own older call shape) it makes
     * one, named for the device, so a deployment with no account store can
     * still walk the flow. The D1 store never takes that path: its account is
     * always the sign-in flow's.
     * @param {string} userCode
     * @param {{id: string, name?: string, email?: string}} [account]
     */
    approveDeviceCode(userCode, account) {
      const deviceCode = byUserCode.get(userCode);
      const code = deviceCode === undefined ? undefined : byDeviceCode.get(deviceCode);
      if (code === undefined) {
        return { error: "unknown-code" };
      }
      if (code.status === "used") {
        return { error: "used-code" };
      }
      if (code.expiresAt < nowSeconds(now())) {
        return { error: "expired-code" };
      }
      if (code.status !== "approved") {
        const own =
          account === undefined
            ? { id: newId("acct"), name: code.name, email: null }
            : accountFields(account);
        accounts.set(own.id, own);
        code.accountId = own.id;
        code.status = "approved";
      }
      const accountRow = accounts.get(code.accountId);
      if (accountRow === undefined) {
        return { error: "unknown-code" };
      }
      return { accountId: accountRow.id, name: accountRow.name };
    },

    /**
     * The CLI's poll. `pending` until the page approves, then the device token
     * (shown once) and the account. A code is consumed by the poll that
     * returns the token, so a stolen device code cannot mint a second token.
     * An approved code whose account row is gone (a store restored from a
     * backup, say) answers `expired` rather than a token that names no
     * account: there is nothing for that token to be.
     * @param {string} deviceCode
     */
    async pollDeviceCode(deviceCode) {
      const code = byDeviceCode.get(deviceCode);
      if (code === undefined) {
        return { status: "unknown" };
      }
      if (code.expiresAt < nowSeconds(now())) {
        return { status: "expired" };
      }
      if (code.status === "pending") {
        return { status: "pending" };
      }
      if (code.status === "used") {
        return { status: "expired" };
      }
      const account = code.accountId === null ? undefined : accounts.get(code.accountId);
      if (account === undefined) {
        return { status: "expired" };
      }
      const token = newId("dtok");
      tokens.set(await sha256Hex(token), {
        account,
        createdAt: nowSeconds(now()),
      });
      code.status = "used";
      return { status: "approved", deviceToken: token, account };
    },

    /**
     * The account a device token belongs to, or null. The token is hashed
     * before lookup, so the store never holds the value the CLI holds.
     * @param {string} token
     */
    async accountForDeviceToken(token) {
      if (typeof token !== "string" || token === "") {
        return null;
      }
      const row = tokens.get(await sha256Hex(token));
      return row === undefined ? null : row.account;
    },
  };
}

/**
 * The D1-backed device sign-in store. Every method is one or two prepared
 * statements; the row is the state, so a code started on one instance is
 * visible on the next one and across a restart.
 * @param {import("./db.js").D1Like} db
 * @param {{now?: () => number, randomBytes?: () => Uint8Array}} [options]
 */
export function createD1DeviceSigninStore(db, options = {}) {
  const now = options.now ?? (() => Date.now());
  const randomBytes = options.randomBytes ?? (() => crypto.getRandomValues(new Uint8Array(16)));

  /** @param {unknown} row */
  function asCode(row) {
    if (!row || typeof row !== "object") {
      return null;
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    return {
      status: String(r.status),
      account: {
        id: String(r.account_id ?? ""),
        name: String(r.account_name ?? ""),
        email: String(r.account_email ?? ""),
      },
      expiresAt: Number(r.expires_at),
    };
  }

  return {
    /**
     * @param {{name?: string}} [request]
     */
    async requestDeviceCode(request = {}) {
      const deviceCode = newId("dev");
      const userCode = newUserCode(randomBytes);
      const createdAt = nowSeconds(now());
      await run(
        db,
        `INSERT INTO device_codes
           (device_code_hash, user_code, name, status, account_id, account_name, account_email, created_at, expires_at)
         VALUES (?1, ?2, ?3, 'pending', '', '', '', ?4, ?5)`,
        await sha256Hex(deviceCode),
        userCode,
        deviceLabel(request.name),
        createdAt,
        createdAt + DEVICE_CODE_TTL_SECONDS,
      );
      return {
        deviceCode,
        userCode,
        expiresIn: DEVICE_CODE_TTL_SECONDS,
        interval: DEVICE_CODE_INTERVAL_SECONDS,
      };
    },

    /**
     * @param {string} userCode
     * @param {{id: string, name?: string, email?: string}} account
     */
    async approveDeviceCode(userCode, account) {
      const row = asCode(
        await first(
          db,
          "SELECT status, expires_at, account_id, account_name, account_email FROM device_codes WHERE user_code = ?1",
          userCode,
        ),
      );
      if (row === null) {
        return { error: "unknown-code" };
      }
      if (row.status === "used") {
        return { error: "used-code" };
      }
      if (row.expiresAt < nowSeconds(now())) {
        return { error: "expired-code" };
      }
      if (row.status !== "approved") {
        const fields = accountFields(account);
        // Conditional on `pending`, so two tabs approving at once cannot
        // attach two accounts: the second update changes nothing and the row
        // keeps the first account.
        await run(
          db,
          `UPDATE device_codes
             SET status = 'approved', account_id = ?1, account_name = ?2, account_email = ?3
           WHERE user_code = ?4 AND status = 'pending'`,
          fields.id,
          fields.name,
          fields.email,
          userCode,
        );
        const stored = asCode(
          await first(
            db,
            "SELECT status, expires_at, account_id, account_name, account_email FROM device_codes WHERE user_code = ?1",
            userCode,
          ),
        );
        if (stored === null || stored.account.id === "") {
          // The row vanished between the update and this read, or the update
          // did not attach an account; say so rather than dereferencing null.
          return { error: "unknown-code" };
        }
        return { accountId: stored.account.id, name: stored.account.name };
      }
      return { accountId: row.account.id, name: row.account.name };
    },

    /**
     * The CLI's poll. `pending` until the page approves, then the device token
     * (shown once) and the account. A code is consumed by the poll that
     * returns the token, so a stolen device code cannot mint a second token.
     * An approved code whose account row is gone (a store restored from a
     * backup, say) answers `expired` rather than a token that names no
     * account: there is nothing for that token to be.
     * @param {string} deviceCode
     */
    async pollDeviceCode(deviceCode) {
      const hash = await sha256Hex(deviceCode);
      const row = asCode(
        await first(
          db,
          "SELECT status, expires_at, account_id, account_name, account_email FROM device_codes WHERE device_code_hash = ?1",
          hash,
        ),
      );
      if (row === null) {
        return { status: "unknown" };
      }
      if (row.expiresAt < nowSeconds(now())) {
        return { status: "expired" };
      }
      if (row.status === "pending") {
        return { status: "pending" };
      }
      if (row.status === "used") {
        return { status: "expired" };
      }
      if (row.account.id === "") {
        return { status: "expired" };
      }
      const token = newId("dtok");
      // Consume the code first, conditional on it still being `approved`: the
      // poll that changes the row is the only one that mints a token, so a
      // stolen device code cannot mint a second one.
      const consumed = await run(
        db,
        "UPDATE device_codes SET status = 'used' WHERE device_code_hash = ?1 AND status = 'approved'",
        hash,
      );
      const changes =
        consumed && typeof consumed === "object" && "meta" in consumed
          ? Number(/** @type {{meta?: {changes?: number}}} */ (consumed).meta?.changes ?? 0)
          : 0;
      if (changes === 0) {
        return { status: "expired" };
      }
      await run(
        db,
        `INSERT INTO device_tokens (token_hash, account_id, account_name, account_email, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
        await sha256Hex(token),
        row.account.id,
        row.account.name,
        row.account.email,
        nowSeconds(now()),
      );
      return { status: "approved", deviceToken: token, account: row.account };
    },

    /**
     * @param {string} token
     */
    async accountForDeviceToken(token) {
      if (typeof token !== "string" || token === "") {
        return null;
      }
      const row = await first(
        db,
        "SELECT account_id, account_name, account_email FROM device_tokens WHERE token_hash = ?1",
        await sha256Hex(token),
      );
      if (!row || typeof row !== "object") {
        return null;
      }
      const r = /** @type {Record<string, unknown>} */ (row);
      return {
        id: String(r.account_id ?? ""),
        name: String(r.account_name ?? ""),
        email: String(r.account_email ?? ""),
      };
    },
  };
}
