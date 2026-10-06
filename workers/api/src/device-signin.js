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
import { batch, first, newId, nowSeconds, run, sha256Hex } from "./db.js";

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
 * (shown once) and the account it names.
 * @typedef {{status: "unknown"|"expired"|"pending"}|{status: "approved", deviceToken: string, account: {id: string, name: string, email: string|null}}} PollResult
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

// How long a device code is good for, and how often the CLI may poll
// (RFC 8628's device_code and interval). Ten minutes is long enough to find a
// phone, short enough that a code left on a terminal screen dies.
export const DEVICE_CODE_TTL_SECONDS = 600;
export const DEVICE_CODE_INTERVAL_SECONDS = 5;

// How long a minted device token is good for. A device token is the CLI's whole
// credential for the account gate, so a token that never dies is a credential a
// leak keeps: the store would hold it until the person deleted their account,
// and the only way to kill it would be to delete that account's keys. Thirty
// days is the session TTL src/auth.js already chose, and for the same reason
// ("the drive is reached on every visit, so signing in every week would be a
// support ticket, not a security win"): a month bounds what a leak is worth
// without asking a person to approve a code every few days. The number is
// written here rather than imported so this module keeps no dependency on the
// account store; keystore.test.js pins the two to each other, so they cannot
// drift into two different months.
export const DEVICE_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

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
export function deviceLabel(deviceName) {
  const trimmed = typeof deviceName === "string" ? deviceName.trim() : "";
  return trimmed.length > 0 ? trimmed : "My drive";
}

/**
 * The account shape copied onto a code/token row.
 * @param {{id: string, name?: string, email?: string}} account
 */
export function accountFields(account) {
  return {
    id: account.id,
    name: typeof account.name === "string" && account.name.length > 0 ? account.name : account.id,
    email: typeof account.email === "string" ? account.email : "",
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

export { createMemoryDeviceSigninStore } from "./device-signin-memory.js";
