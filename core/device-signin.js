import { batch, first, newId, nowSeconds, run, sha256Hex } from "./db.js";
import {
  accountFields,
  DEVICE_CODE_INTERVAL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_TOKEN_REFRESH_SECONDS,
  DEVICE_TOKEN_TTL_SECONDS,
  deviceLabel,
  newUserCode,
  renewDeviceTokenWindow,
} from "./device-signin-codes.js";

/**
 * Any device sign-in store: the shape the routes read. The in-memory
 * implementation is a stand-in; the D1 one is the real store. Every caller
 * awaits, and both implementations are async (the D1 statements are), so the
 * interface below is Promise-only: a stand-in cannot accidentally be read as a
 * plain value, and a caller cannot forget the await and get `undefined`.
 *
 * `approveDeviceCode`'s account is optional because the in-memory store's own
 * older call shape can name one from the device (a deployment with no account
 * store still walks the flow); the D1 store never takes that path, because the
 * approve route is an account route and its account is always the sign-in
 * flow's.
 * @typedef {object} DeviceSigninStore
 * @property {Map<string, {id: string, name: string, email: string|null}>} [accounts]
 *        only the in-memory store holds one, for a test that models a
 *        lost account row
 * @property {(request?: {name?: string}) => Promise<DeviceCodeResult>} requestDeviceCode
 * @property {(userCode: string) => Promise<PendingDeviceApproval|null>} pendingDeviceApproval
 * @property {(userCode: string, account?: {id: string, name?: string, email?: string}) => Promise<ApproveResult>} approveDeviceCode
 * @property {(userCode: string) => Promise<{name: string}|null>} describeUserCode
 * @property {(deviceCode: string) => Promise<PollResult>} pollDeviceCode
 * @property {(token: string) => Promise<{id: string, name: string, email: string|null}|null>} accountForDeviceToken
 * @property {(token: string) => Promise<RevokeResult>} revokeDeviceToken
 * @property {(account: {id: string}) => Promise<{revoked: number}>} revokeAllDeviceTokens
 * @property {(at?: number) => Promise<number>} sweepDeviceTokens
 */

/**
 * A freshly started device code: the CLI's secret and the short code a person
 * types on the approval page.
 * @typedef {{deviceCode: string, userCode: string, expiresIn: number, interval: number}} DeviceCodeResult
 */

/**
 * A pending device code the approval page can name without putting the code
 * in the form. `createdAt` and `expiresAt` are epoch seconds.
 * @typedef {{name: string, createdAt: number, expiresAt: number}} PendingDeviceApproval
 */

/**
 * An approval's answer: the account it attached, or a named refusal.
 * @typedef {{accountId?: string, name?: string, error?: string}} ApproveResult
 */

/**
 * A poll's answer: `pending` until the page approves, then the device token
 * (shown once), the epoch second its window ends at, and the account it names.
 * `expiresAt` is here because the CLI keeps it: a device that knows when its
 * own token dies can say so instead of finding out from a 401 (drive#557).
 * @typedef {{status: "unknown"|"expired"|"pending"}|{status: "approved", deviceToken: string, expiresAt: number, account: {id: string, name: string, email: string|null}}} PollResult
 */

/**
 * A revoke's answer: what the row says, or a named refusal for a token the
 * store never held.
 * @typedef {{revoked: true, expiresAt: number, revokedAt: number}|{error: "not-found"}} RevokeResult
 */

/**
 * A bulk revoke's answer: how many of the account's live tokens went dead. It
 * counts the rows it changed, never the rows it found, so "0" means every
 * token on this account was already dead and the answer is about the new ones.
 * @typedef {{revoked: number}} RevokeAllResult
 */

export {
  DEVICE_CODE_INTERVAL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_TOKEN_REFRESH_SECONDS,
  DEVICE_TOKEN_TTL_SECONDS,
  renewDeviceTokenWindow,
};

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
     * The device a code belongs to, for the approve page's intro (drive#558):
     * a person approving from a second device reads which terminal asked
     * rather than guessing. Read-only, and it answers for a spent or expired
     * code too, so the page can still say which sign-in ran out. Null when
     * the store never held the code.
     * @param {string} userCode
     * @returns {Promise<{name: string}|null>}
     */
    async describeUserCode(userCode) {
      const deviceCode = byUserCode.get(userCode);
      const code = deviceCode === undefined ? undefined : byDeviceCode.get(deviceCode);
      if (code === undefined) {
        return null;
      }
      return { name: code.name };
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
      sweepTokens(minted);
      const expiresAt = minted + DEVICE_TOKEN_TTL_SECONDS;
      tokens.set(await sha256Hex(token), {
        account,
        createdAt: minted,
        expiresAt,
        revokedAt: null,
      });
      code.status = "used";
      return { status: "approved", deviceToken: token, expiresAt, account };
    },

    /**
     * The account a device token belongs to, or null. The token is hashed
     * before lookup, so the store never holds the value the CLI holds.
     *
     * This is the one place a bearer token becomes an account, so it is where
     * a token past its expiry or one that has been revoked stops being one:
     * both answer `null`, the same answer a token that was never minted gets,
     * so the account gate cannot tell a dead credential from a made-up one.
     *
     * A token that gets here is live, so this is also where its window is
     * renewed (drive#557): the drive is reached every day by the same command,
     * and a device whose token dies on a fixed 30 days while it is in daily
     * use is a device that gets signed out for no reason. The rule is the one
     * above, and it runs after both refusals, so nothing here can revive a
     * dead row.
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
      const at = nowSeconds(now());
      if (at >= row.expiresAt) {
        return null;
      }
      row.expiresAt = renewDeviceTokenWindow(row.expiresAt, at);
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

/**
 * The D1-backed device sign-in store. Every method is one or two prepared
 * statements; the row is the state, so a code started on one instance is
 * visible on the next one and across a restart.
 * @param {D1Database} db
 * @param {{now?: () => number, randomBytes?: () => Uint8Array}} [options]
 * @returns {DeviceSigninStore}
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
     * @returns {Promise<DeviceCodeResult>}
     */
    async requestDeviceCode(request = {}) {
      const deviceCode = newId("dev");
      const userCode = newUserCode(randomBytes);
      const createdAt = nowSeconds(now());
      await batch(db, [
        {
          sql: "DELETE FROM device_codes WHERE expires_at <= ?1",
          params: [createdAt],
        },
        {
          sql: `INSERT INTO device_codes
                  (device_code_hash, user_code, name, status, account_id, account_name, account_email, created_at, expires_at)
                VALUES (?1, ?2, ?3, 'pending', '', '', '', ?4, ?5)`,
          params: [
            await sha256Hex(deviceCode),
            userCode,
            deviceLabel(request.name),
            createdAt,
            createdAt + DEVICE_CODE_TTL_SECONDS,
          ],
        },
      ]);
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
      const row = await first(
        db,
        "SELECT name, created_at, expires_at, status FROM device_codes WHERE user_code = ?1",
        userCode,
      );
      if (row === null || typeof row !== "object") {
        return null;
      }
      const r = /** @type {Record<string, unknown>} */ (row);
      if (String(r.status) !== "pending") {
        return null;
      }
      const expiresAt = Number(r.expires_at);
      if (expiresAt < nowSeconds(now())) {
        return null;
      }
      return {
        name: String(r.name ?? ""),
        createdAt: Number(r.created_at),
        expiresAt,
      };
    },

    /**
     * @param {string} userCode
     * @param {{id: string, name?: string, email?: string}} [account]
     * @returns {Promise<ApproveResult>}
     */
    async approveDeviceCode(userCode, account) {
      if (account === undefined) {
        return { error: "unknown-code" };
      }
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
        await run(
          db,
          `UPDATE device_codes
             SET status = 'approved', account_id = ?1, account_name = ?2, account_email = ?3
           WHERE user_code = ?4 AND status = 'pending' AND expires_at > ?5`,
          fields.id,
          fields.name,
          fields.email,
          userCode,
          nowSeconds(now()),
        );
        const stored = asCode(
          await first(
            db,
            "SELECT status, expires_at, account_id, account_name, account_email FROM device_codes WHERE user_code = ?1",
            userCode,
          ),
        );
        if (stored === null) {
          return { error: "unknown-code" };
        }
        if (stored.expiresAt < nowSeconds(now())) {
          return { error: "expired-code" };
        }
        if (stored.account.id === "") {
          return { error: "unknown-code" };
        }
        return { accountId: stored.account.id, name: stored.account.name };
      }
      return { error: "approved-code" };
    },

    /**
     * The device a code belongs to, for the approve page's intro (drive#558):
     * a person approving from a second device reads which terminal asked
     * rather than guessing. Read-only, by the as-typed user code, the same
     * lookup the approve write keys on. Null when the store never held the
     * code.
     * @param {string} userCode
     * @returns {Promise<{name: string}|null>}
     */
    async describeUserCode(userCode) {
      const row = await first(db, "SELECT name FROM device_codes WHERE user_code = ?1", userCode);
      if (row === null || row === undefined || typeof row !== "object") {
        return null;
      }
      const name = /** @type {Record<string, unknown>} */ (row).name;
      return typeof name === "string" ? { name } : null;
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
      const nonce = newId("claim");
      const minted = nowSeconds(now());
      await batch(db, [
        {
          sql: "UPDATE device_codes SET status = 'used', consumed_by = ?1 WHERE device_code_hash = ?2 AND status = 'approved' AND consumed_by = '' AND expires_at > ?3",
          params: [nonce, hash, minted],
        },
        {
          sql: `INSERT INTO device_tokens (token_hash, account_id, account_name, account_email, created_at, expires_at)
                SELECT ?1, ?2, ?3, ?4, ?5, ?6
                 WHERE EXISTS (SELECT 1 FROM device_codes WHERE device_code_hash = ?7 AND consumed_by = ?8)`,
          params: [
            await sha256Hex(token),
            row.account.id,
            row.account.name,
            row.account.email,
            minted,
            minted + DEVICE_TOKEN_TTL_SECONDS,
            hash,
            nonce,
          ],
        },
      ]);
      const consumed = await first(
        db,
        "SELECT consumed_by FROM device_codes WHERE device_code_hash = ?1",
        hash,
      );
      const winner =
        /** @type {{consumed_by?: string}|null} */ (consumed) !== null &&
        /** @type {{consumed_by?: string}} */ (consumed).consumed_by === nonce;
      if (!winner) {
        return { status: "expired" };
      }
      return {
        status: "approved",
        deviceToken: token,
        expiresAt: minted + DEVICE_TOKEN_TTL_SECONDS,
        account: row.account,
      };
    },

    /**
     * @param {string} token
     */
    async accountForDeviceToken(token) {
      if (typeof token !== "string" || token === "") {
        return null;
      }
      const hash = await sha256Hex(token);
      const at = nowSeconds(now());
      const row = await first(
        db,
        `SELECT t.account_id, t.account_name, t.account_email, t.expires_at, a.state AS account_state
          FROM device_tokens t
          LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.token_hash = ?1 AND t.revoked_at IS NULL AND t.expires_at > ?2`,
        hash,
        at,
      );
      if (!row || typeof row !== "object") {
        return null;
      }
      const r = /** @type {Record<string, unknown>} */ (row);
      if (r.account_state === "closed") {
        return null;
      }
      const held = Number(r.expires_at);
      const renewed = renewDeviceTokenWindow(held, at);
      if (renewed !== held) {
        await run(
          db,
          "UPDATE device_tokens SET expires_at = MAX(expires_at, ?1) WHERE token_hash = ?2 AND revoked_at IS NULL",
          renewed,
          hash,
        );
      }
      return {
        id: String(r.account_id ?? ""),
        name: String(r.account_name ?? ""),
        email: String(r.account_email ?? ""),
      };
    },

    /**
     * Revoke one device token: `drive logout`'s server-side half. The write is
     * conditional on the token not being revoked already, so two callers racing
     * cannot stamp two different times, and the row is read back either way so
     * the answer is the row's own (`revokedAt` is the first revoke's time, not
     * this one's). A token the store never held answers `not-found` rather
     * than claiming a revoke that changed nothing.
     * @param {string} token
     * @returns {Promise<RevokeResult>}
     */
    async revokeDeviceToken(token) {
      if (typeof token !== "string" || token === "") {
        return { error: "not-found" };
      }
      const hash = await sha256Hex(token);
      const revokedAt = nowSeconds(now());
      await run(
        db,
        "UPDATE device_tokens SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL",
        revokedAt,
        hash,
      );
      const row = /** @type {Record<string, unknown>|null} */ (
        await first(
          db,
          "SELECT expires_at, revoked_at FROM device_tokens WHERE token_hash = ?1",
          hash,
        )
      );
      if (!row || row.revoked_at === null || row.revoked_at === undefined) {
        return { error: "not-found" };
      }
      return {
        revoked: true,
        expiresAt: Number(row.expires_at),
        revokedAt: Number(row.revoked_at),
      };
    },

    /**
     * Revoke every live device token on one account: the "sign out of every
     * device" half (drive#34, slice drive#236). One statement, filtered on the
     * account id the gate resolved, so no loop reads rows it cannot name.
     *
     * The write is conditional on `revoked_at IS NULL`, which is what makes it
     * both idempotent and honest about a row's history: a token that is already
     * dead keeps the first revoke's timestamp, and `meta.changes` therefore
     * counts only the rows this call actually killed. A caller that runs this
     * twice sees `0` the second time.
     *
     * Nothing is deleted. The expiry and revocation columns are the same ones
     * the single bearer lookup reads, so a token killed here is refused at the
     * gate for every route at once, exactly as a revoke by `DELETE
     * /v1/device/token` is; the rows drop later, through the same sweep the
     * single revoke's rows drop through.
     * @param {{id: string}} account
     * @returns {Promise<RevokeAllResult>}
     */
    async revokeAllDeviceTokens(account) {
      const changed = await run(
        db,
        "UPDATE device_tokens SET revoked_at = ?1 WHERE account_id = ?2 AND revoked_at IS NULL",
        nowSeconds(now()),
        account.id,
      );
      return {
        revoked: Number(/** @type {{meta?: {changes?: number}}} */ (changed)?.meta?.changes ?? 0),
      };
    },

    /**
     * Drop the token rows that can no longer authenticate: expired or revoked.
     * The bearer lookup already refuses both, so this is housekeeping, never
     * the security boundary.
     * @param {number} [at]
     * @returns {Promise<number>} how many rows went
     */
    async sweepDeviceTokens(at = nowSeconds(now())) {
      const dropped = await run(
        db,
        "DELETE FROM device_tokens WHERE expires_at <= ?1 OR revoked_at IS NOT NULL",
        at,
      );
      return Number(/** @type {{meta?: {changes?: number}}} */ (dropped)?.meta?.changes ?? 0);
    },
  };
}
