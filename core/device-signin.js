// The device sign-in store (RFC 8628): the pending code the CLI asks for, the
// short user code the person types on the approval page, and the device token
// the CLI picks up when a signed-in person approves it.
//
// Build step 4 (drive#55) first kept this in a per-isolate `Map`
// (core/keystore.js), which the midnight review of #122 found
// unsafe: a Worker has many instances, so a code started on one was lost on
// another and every in-flight sign-in died with the isolate (drive issue
// #136 finding 1). This module is the real store: a D1-backed implementation
// (`createD1DeviceSigninStore`) whose row is written by `/v1/device/code`,
// moved to `approved` by the signed-in approval page, and consumed by
// `/v1/device/token`, across instances and restarts. The in-memory
// implementation is kept for the tests and a deployment with no database —
// the same memory-stand-in/real-adapter split core/files.js uses.
//
// The device code and the minted token are secrets, so both are stored only as
// SHA-256 digests (`core/db.js` sha256Hex), the same rule the key
// store follows. The short user code is written as-typed because the approval
// page looks the row up by it; it is not a credential alone, because approval
// also requires a signed-in account (drive issue #136 finding 2).
//
// `account` is the signed-in account the approval page passes in
// (`{id, name, email}`, resolved by the core/status.js `signedInAccount` gate);
// its fields are copied onto the code row, so a poll on another instance can
// name the owner without this module holding an accounts table of its own.
import { batch, first, newId, nowSeconds, run, sha256Hex } from "./db.js";
import {
  accountFields,
  DEVICE_CODE_INTERVAL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_TOKEN_TTL_SECONDS,
  deviceLabel,
  newUserCode,
} from "./device-signin-codes.js";

/**
 * @typedef {import("./device-signin-codes.js").DeviceSigninStore} DeviceSigninStore
 * @typedef {import("./device-signin-codes.js").DeviceCodeResult} DeviceCodeResult
 * @typedef {import("./device-signin-codes.js").PendingDeviceApproval} PendingDeviceApproval
 * @typedef {import("./device-signin-codes.js").ApproveResult} ApproveResult
 * @typedef {import("./device-signin-codes.js").PollResult} PollResult
 * @typedef {import("./device-signin-codes.js").RevokeResult} RevokeResult
 * @typedef {import("./device-signin-codes.js").RevokeAllResult} RevokeAllResult
 */

export {
  DEVICE_CODE_INTERVAL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_TOKEN_TTL_SECONDS,
  newUserCode,
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
      // The row and the sweep of the rows that are past their TTL are one
      // transaction: `/v1/device/code` is public (the CLI holds no credential
      // before it asks for one), so without the sweep an anonymous caller
      // could grow the table one dead row per request, forever. The sweep
      // deletes only rows already expired at this instant, never the row being
      // inserted, and the edge rate limit on the route (device-routes.js) caps
      // how fast either can happen.
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
      // The approve route is an account route, so a real call always carries
      // the signed-in account. The in-memory stand-in can name one from the
      // device, but this store cannot: with no account there is nobody to
      // attach, so it refuses without reading or writing the row.
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
        // Conditional on `pending` and on the code still being inside its TTL,
        // so two tabs approving at once cannot attach two accounts (the second
        // update changes nothing and the row keeps the first account) and a
        // code that expired between the read above and this write is not
        // approved by a request that started while it was alive. The re-read
        // below is the authority: it is the row as it is now, not the
        // predicate's guess.
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
          // The row vanished between the update and this read.
          return { error: "unknown-code" };
        }
        if (stored.expiresAt < nowSeconds(now())) {
          return { error: "expired-code" };
        }
        if (stored.account.id === "") {
          // The update did not attach an account; say so rather than
          // dereferencing null.
          return { error: "unknown-code" };
        }
        return { accountId: stored.account.id, name: stored.account.name };
      }
      // Already approved. Somebody else may have got here first, and a code
      // that already names one account must not be handed to a second one by
      // the idempotent path below, so the row is reported as spent rather than
      // re-attached.
      return { error: "approved-code" };
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
      // Consume the code and write the token in one transaction, so a failure
      // between the two cannot lose a sign-in someone already approved: either
      // both statements land or the code stays `approved` for the next poll.
      // The update is conditional on the row still being `approved` and still
      // inside its TTL, so a poll that crosses the boundary cannot mint a
      // token for a code that expired, and it stamps `consumed_by` with this
      // poll's own nonce.
      //
      // The insert is that nonce's guard: `INSERT ... SELECT ... WHERE EXISTS`
      // fires only while the row still carries this poll's nonce, and a poll
      // that lost the race neither changed the nonce nor matches it, so it
      // inserts nothing. The two racing polls therefore mint exactly one token
      // row between them — the loser leaves no inert credential behind, which
      // is what a plain batch (whose statements run either way) would.
      const nonce = newId("claim");
      await batch(db, [
        {
          // The numbered placeholders are written in ascending order (`?1`,
          // `?2`, `?3`) and bound in that order: `?1` is this poll's nonce,
          // `?2` the code hash, `?3` the clock. D1 binds `?N` by position, and
          // the test harness's SQLite adapter rewrites them positionally too,
          // so the two agree only while the written order is the bound order.
          sql: "UPDATE device_codes SET status = 'used', consumed_by = ?1 WHERE device_code_hash = ?2 AND status = 'approved' AND consumed_by = '' AND expires_at > ?3",
          params: [nonce, hash, nowSeconds(now())],
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
            nowSeconds(now()),
            nowSeconds(now()) + DEVICE_TOKEN_TTL_SECONDS,
            hash,
            nonce,
          ],
        },
      ]);
      // The nonce is the authority on who won, not the statement's row count:
      // the row the update left behind says which poll holds this code.
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
      return { status: "approved", deviceToken: token, account: row.account };
    },

    /**
     * @param {string} token
     */
    async accountForDeviceToken(token) {
      if (typeof token !== "string" || token === "") {
        return null;
      }
      // The expiry and the revocation are the WHERE clause, not a check the
      // caller could forget: a dead row is the same answer as a row that was
      // never written, so there is one way for a token to fail and one place it
      // can happen.
      //
      // The close state is joined in for the same reason: a token minted
      // before the account closed must stop signing the CLI in the moment the
      // account closes (drive#497), and the accounts row is where close is
      // written. It is a LEFT JOIN because a person can hold a device token
      // with no accounts row yet — the site Worker's sign-in mints the Better
      // Auth user first — and that state is not closed.
      const row = await first(
        db,
        `SELECT t.account_id, t.account_name, t.account_email, a.state AS account_state
          FROM device_tokens t
          LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.token_hash = ?1 AND t.revoked_at IS NULL AND t.expires_at > ?2`,
        await sha256Hex(token),
        nowSeconds(now()),
      );
      if (!row || typeof row !== "object") {
        return null;
      }
      const r = /** @type {Record<string, unknown>} */ (row);
      if (r.account_state === "closed") {
        return null;
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
