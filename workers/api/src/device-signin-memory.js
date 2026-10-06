// In-memory device sign-in store. Extracted from workers/api/src/device-signin.js
// (drive issue #617) with no behaviour change; device-signin.js re-exports it.

import { newId, nowSeconds, sha256Hex } from "./db.js";
import {
  accountFields,
  DEVICE_CODE_INTERVAL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_TOKEN_TTL_SECONDS,
  deviceLabel,
  newUserCode,
} from "./device-signin.js";

/**
 * The in-memory device sign-in store: the same four methods as the D1 one,
 * over Maps, for the tests and a deployment with no database binding. One
 * instance per isolate, exactly the stand-in the D1 store replaces.
 * @param {{now?: () => number, randomBytes?: () => Uint8Array}} [options]
 * @returns {DeviceSigninStore}
 */
export function createMemoryDeviceSigninStore(options = {}) {
  const now = options.now ?? (() => Date.now());
  const randomBytes = options.randomBytes ?? (() => crypto.getRandomValues(new Uint8Array(16)));

  /** @type {Map<string, {deviceCode: string, userCode: string, name: string, status: string, accountId: string|null, createdAt: number, expiresAt: number}>} */
  const byDeviceCode = new Map();
  /** @type {Map<string, string>} user code -> device code */
  const byUserCode = new Map();
  /** @type {Map<string, {account: {id: string, name: string, email: string|null}, createdAt: number, expiresAt: number, revokedAt: number|null}>} token hash -> token */
  const tokens = new Map();
  /** @type {Map<string, {id: string, name: string, email: string|null}>} account id -> account the stand-in holds */
  const accounts = new Map();

  /**
   * The token rows that can no longer authenticate: expired or revoked. The
   * bearer lookup already refuses both, so dropping them is housekeeping and
   * never the security boundary — a store that never swept would refuse the
   * same tokens and only hold more rows.
   * @param {number} [at] epoch seconds to judge the rows at; injected so a
   *   test can sweep a row it cannot otherwise wait for.
   * @returns {number} how many rows went
   */
  function sweepTokens(at = nowSeconds(now())) {
    let dropped = 0;
    for (const [digest, row] of tokens) {
      if (row.revokedAt !== null || at >= row.expiresAt) {
        tokens.delete(digest);
        dropped++;
      }
    }
    return dropped;
  }

  return {
    /** Every account this stand-in holds, so a test can model a row that is
     * gone (the store restored from a backup) the way the real account store
     * can lose one. */
    accounts,
    /**
     * Start a device sign-in: a code the CLI polls with, and a short code the
     * person types on the approval page.
     * @param {{name?: string}} [request]
     * @returns {Promise<DeviceCodeResult>}
     */
    async requestDeviceCode(request = {}) {
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
     * The pending code a person is about to approve, or null. The approval
     * page names the device and the time from this, and never copies the
     * user code into the form (drive#518).
     * @param {string} userCode
     * @returns {Promise<PendingDeviceApproval|null>}
     */
    async pendingDeviceApproval(userCode) {
      const deviceCode = byUserCode.get(userCode);
      const code = deviceCode === undefined ? undefined : byDeviceCode.get(deviceCode);
      if (code === undefined || code.status !== "pending") {
        return null;
      }
      if (code.expiresAt < nowSeconds(now())) {
        return null;
      }
      return { name: code.name, createdAt: code.createdAt, expiresAt: code.expiresAt };
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
     * @returns {Promise<ApproveResult>}
     */
    async approveDeviceCode(userCode, account) {
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
      if (code.status === "approved") {
        // The same rule as the D1 store above: a code that already names an
        // account is spent, so a second pair of hands cannot attach itself to
        // somebody else's approved sign-in.
        return { error: "approved-code" };
      }
      const own =
        account === undefined
          ? { id: newId("acct"), name: code.name, email: null }
          : accountFields(account);
      accounts.set(own.id, own);
      code.accountId = own.id;
      code.status = "approved";
      const accountId = code.accountId;
      if (!accountId) {
        return { error: "unknown-code" };
      }
      const accountRow = accounts.get(accountId);
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
     * @returns {Promise<PollResult>}
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
      const minted = nowSeconds(now());
      // Minting is the only moment a new token row appears, so it is where the
      // dead ones go: a row that can no longer authenticate is not worth
      // holding, and this stand-in would otherwise grow one per sign-in for
      // the life of the isolate.
      sweepTokens(minted);
      tokens.set(await sha256Hex(token), {
        account,
        createdAt: minted,
        expiresAt: minted + DEVICE_TOKEN_TTL_SECONDS,
        revokedAt: null,
      });
      code.status = "used";
      return { status: "approved", deviceToken: token, account };
    },

    /**
     * The account a device token belongs to, or null. The token is hashed
     * before lookup, so the store never holds the value the CLI holds.
     *
     * This is the one place a bearer token becomes an account, so it is where
     * a token past its expiry or one that has been revoked stops being one:
     * both answer `null`, the same answer a token that was never minted gets,
     * so the account gate cannot tell a dead credential from a made-up one.
     * @param {string} token
     */
    async accountForDeviceToken(token) {
      if (typeof token !== "string" || token === "") {
        return null;
      }
      const row = tokens.get(await sha256Hex(token));
      if (row === undefined || row.revokedAt !== null) {
        return null;
      }
      if (nowSeconds(now()) >= row.expiresAt) {
        return null;
      }
      return row.account;
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
     * @returns {Promise<RevokeResult>}
     */
    async revokeDeviceToken(token) {
      if (typeof token !== "string" || token === "") {
        return { error: "not-found" };
      }
      const row = tokens.get(await sha256Hex(token));
      if (row === undefined) {
        return { error: "not-found" };
      }
      if (row.revokedAt === null) {
        row.revokedAt = nowSeconds(now());
      }
      return { revoked: true, expiresAt: row.expiresAt, revokedAt: row.revokedAt };
    },

    /**
     * Revoke every live device token on one account: the "sign out of every
     * device" half (drive#34, slice drive#236). This is `revokeDeviceToken`
     * without the caller's own token in front of it — one account id, every
     * row.
     *
     * The account id is the only filter and it is an id, never a token: the
     * caller of this method is the account route behind the account gate
     * (device-routes.js / key-routes.js), which resolved the account from a
     * credential it already holds, so a caller cannot name another account's
     * rows any more than it could with the single-token revoke. A row that is
     * already dead is left exactly as it is: the first revoke's timestamp is
     * the row's own history, and a bulk pass that is run twice must not rewrite
     * it. Idempotent, so the second call answers `0` and nothing more.
     *
     * Expired rows are counted too where they are not yet marked revoked: the
     * bearer lookup already refuses them, so the write is housekeeping on those
     * and the count is about the live ones the caller cared about. What is
     * never done here is deleting a row — `sweepDeviceTokens` does that, and
     * only for rows that can no longer authenticate.
     * @param {{id: string}} account
     * @returns {Promise<RevokeAllResult>}
     */
    async revokeAllDeviceTokens(account) {
      let revoked = 0;
      for (const row of tokens.values()) {
        if (row.account.id === account.id && row.revokedAt === null) {
          row.revokedAt = nowSeconds(now());
          revoked++;
        }
      }
      return { revoked };
    },

    /**
     * The token rows that can no longer authenticate. See the closure above;
     * exposed so a test (or a timer) can run it without minting.
     * @param {number} [at]
     * @returns {Promise<number>} how many rows went
     */
    async sweepDeviceTokens(at) {
      return sweepTokens(at);
    },
  };
}
