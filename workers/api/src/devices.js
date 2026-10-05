// The D1 key store for cap enforcement (drive issue #64): `accounts.cap_cents`
// and `devices` with `b2_key_id` / `capabilities` (migrations/drive/0010).
//
// The in-memory key store (keystore.js) is the stand-in a deployment without
// a database keeps; this module is the real rows. Cap enforcement
// (src/cap.js `enforceCap` / `applyCapSwap`) talks to a KeyProvider
// (`mint` / `revoke` / `swapToReadOnly`) that reads and persists those rows,
// so a swap that ran on one Worker instance is the row the next instance
// sees. The storage-side revoke / swap is still the vendor's key API (#173);
// until then a minted session expires on its own and the row here is what
// makes the api's own storage API refuse a write immediately. Drive#173 (2026-10-03)
// measured the vendor's side: iDrive e2 has no key API over S3, so the expiry
// is the whole of the withdrawal there.

import { BILLING_CONFIG, storedGb } from "../../../src/billing.js";
import { applyCapSwap, READ_ONLY_CAPABILITIES } from "../../../src/cap.js";
import { monthStart, monthUsageRollup } from "../../../src/meter.js";
import { agentCapGate, agentCapPlan, capKeyRow } from "./agent-caps.js";
import { all, first, newId, nowSeconds, run, sha256Hex } from "./db.js";
import { tokensMatch } from "./http.js";
import { bucketForKeyPrefix, mintTtlSeconds, teamPrefix } from "./keyprovider.js";
import { publicDevice, renewKeyWindow } from "./keystore.js";

const CLOSE_CRON_LIMIT = 100;

/**
 * @typedef {import("./keystore.js").Device} Device
 * @typedef {import("./keyprovider.js").KeyScope} KeyScope
 * @typedef {import("./keyprovider.js").KeyProvider} KeyProvider
 */

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseJsonList(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.filter((name) => typeof name === "string");
  }
  if (typeof raw !== "string") {
    throw new TypeError(`capabilities must be a JSON list, got ${typeof raw}`);
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string")) {
    throw new TypeError(`capabilities must be a JSON list of names, got ${raw}`);
  }
  return parsed;
}

/**
 * @param {unknown} raw
 * @returns {string[]|null}
 */
function parseCappedFrom(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  const names = parseJsonList(raw);
  return names.length === 0 ? null : names;
}

/**
 * @param {unknown} row
 * @returns {Device|null}
 */
function deviceFromRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const r = /** @type {Record<string, unknown>} */ (row);
  if (typeof r.id !== "string" || r.id === "") {
    return null;
  }
  return {
    id: r.id,
    accountId: String(r.account_id ?? ""),
    name: String(r.name ?? ""),
    kind: /** @type {Device["kind"]} */ (String(r.kind ?? "agent")),
    accessKeyId: String(r.b2_key_id ?? ""),
    secretHash: String(r.secret_hash ?? ""),
    prefix: String(r.prefix ?? ""),
    capabilities: parseJsonList(r.capabilities),
    createdAt: Number(r.created_at ?? 0),
    // Null is a key that never expires (a person's own device key); a column
    // written before drive#106 is null too, so an existing row keeps the life
    // it had rather than being handed an expiry it was never minted with.
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
    // Null is a row written before drive#106's second column existed, so the
    // kind's hour is the ceiling on every renewal of it.
    ttlSeconds:
      r.ttl_seconds === null || r.ttl_seconds === undefined ? null : Number(r.ttl_seconds),
    lastSeenAt:
      r.last_seen_at === null || r.last_seen_at === undefined ? null : Number(r.last_seen_at),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
    ...(parseCappedFrom(r.capped_from) === null
      ? {}
      : { cappedFrom: parseCappedFrom(r.capped_from) }),
  };
}

/**
 * Move one row's window forward: the later of the expiry this call computed and
 * the expiry the row already holds.
 *
 * This is the one statement that renews an hour, and the comparison is in the
 * SQL, not only in the JavaScript, because the JavaScript can only compare
 * against the row *this call read*. Two requests can read the same row and
 * write in either order, so a request that read first and writes second would
 * otherwise pull a restarted hour back to the value it read — the row must
 * keep the later expiry for the bound to hold under a race, and this is where
 * that is decided. `tests/integration/agent-key-ttl-d1.test.mjs` runs this
 * exact statement with a stale value to prove it.
 *
 * @param {D1Database} db
 * @param {{id: string}} device
 * @param {number|null} expiresAt the window this call computed, or null for a
 *   kind that never expires (its row keeps the null it has)
 * @param {number} lastSeenAt
 * @returns {Promise<unknown>} the run result, whose `meta.changes` is how the
 *   caller proves a write landed
 */
export function renewKeyRow(db, device, expiresAt, lastSeenAt) {
  return run(
    db,
    `UPDATE devices SET last_seen_at = ?1,
       expires_at = CASE
         WHEN ?2 IS NULL THEN devices.expires_at
         WHEN devices.expires_at IS NULL OR devices.expires_at < ?2 THEN ?2
         ELSE devices.expires_at
       END
      WHERE id = ?3 AND revoked_at IS NULL`,
    lastSeenAt,
    expiresAt,
    device.id,
  );
}

/**
 * The D1-backed device and cap store. Every method is a prepared statement
 * against `migrations/drive/0010_accounts_devices.sql`, so a key minted on
 * one Worker instance is the row the cap swap on the next instance reads.
 *
 * @param {D1Database} db
 * @param {{now?: () => number, keyProvider?: import("./keyprovider.js").KeyProvider}} [options]
 */
export function createD1DeviceStore(db, options = {}) {
  const now = options.now ?? (() => Date.now());
  const inner = options.keyProvider;

  /**
   * @param {Device} device
   */
  async function put(device) {
    const cappedFrom =
      device.cappedFrom === undefined || device.cappedFrom === null
        ? null
        : JSON.stringify(device.cappedFrom);
    await run(
      db,
      `INSERT INTO devices (
         id, account_id, name, kind, b2_key_id, secret_hash, capabilities,
         prefix, capped_from, created_at, last_seen_at, revoked_at, expires_at, ttl_seconds
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT(id) DO UPDATE SET
         account_id = excluded.account_id,
         name = excluded.name,
         kind = excluded.kind,
         b2_key_id = excluded.b2_key_id,
         secret_hash = excluded.secret_hash,
         capabilities = excluded.capabilities,
         prefix = excluded.prefix,
         capped_from = excluded.capped_from,
         last_seen_at = excluded.last_seen_at,
         revoked_at = excluded.revoked_at,
         expires_at = excluded.expires_at,
         ttl_seconds = excluded.ttl_seconds`,
      device.id,
      device.accountId,
      device.name,
      device.kind,
      device.accessKeyId,
      device.secretHash,
      JSON.stringify(device.capabilities),
      device.prefix,
      cappedFrom,
      device.createdAt,
      device.lastSeenAt,
      device.revokedAt,
      // Null is written as null, not as 0: a key that never expires is a
      // different claim from one that expired at the epoch.
      device.expiresAt ?? null,
      // The lifetime the mint gave, or null on a row written before the column
      // existed. Null there means "the kind's own hour is the ceiling", which is
      // what an old row is held to: it is never handed a longer life than a new
      // one.
      device.ttlSeconds ?? null,
    );
  }

  /**
   * @param {string} accountId
   * @param {string} email
   * @param {number} capCents
   */
  async function upsertCapCents(accountId, email, capCents) {
    const at = nowSeconds(now());
    await run(
      db,
      `INSERT INTO accounts (id, email, created_at, cap_cents, state)
       VALUES (?1, ?2, ?3, ?4, 'active')
       ON CONFLICT(id) DO UPDATE SET
         cap_cents = excluded.cap_cents,
         email = CASE WHEN excluded.email = '' THEN accounts.email ELSE excluded.email END`,
      accountId,
      email,
      at,
      capCents,
    );
  }

  /**
   * @param {string} accountId
   * @param {"active"|"read_only"|"closed"} state
   */
  async function setAccountState(accountId, state) {
    await run(db, "UPDATE accounts SET state = ?1 WHERE id = ?2", state, accountId);
  }

  /**
   * `purgeCursor` is the drive path the purge of this account stopped after
   * (drive#565): NULL before the first batch and once the purge finished, so
   * NULL `purged_at` with a non-NULL cursor reads "partially purged, resume
   * after this path".
   * @param {unknown} row
   * @returns {{id: string, email: string, state: string, closedAt: number|null, reminderSentAt: number|null, closeMailSentAt: number|null, purgedAt: number|null, purgeCursor: string|null}|null}
   */
  function closeStateFromRow(row) {
    if (!row || typeof row !== "object") {
      return null;
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    if (typeof r.id !== "string" || r.id === "") {
      return null;
    }
    return {
      id: r.id,
      email: typeof r.email === "string" ? r.email : "",
      state: typeof r.state === "string" ? r.state : "active",
      closedAt: r.closed_at === null || r.closed_at === undefined ? null : Number(r.closed_at),
      reminderSentAt:
        r.reminder_sent_at === null || r.reminder_sent_at === undefined
          ? null
          : Number(r.reminder_sent_at),
      closeMailSentAt:
        r.close_mail_sent_at === null || r.close_mail_sent_at === undefined
          ? null
          : Number(r.close_mail_sent_at),
      purgedAt: r.purged_at === null || r.purged_at === undefined ? null : Number(r.purged_at),
      purgeCursor:
        typeof r.purge_cursor === "string" && r.purge_cursor !== "" ? r.purge_cursor : null,
    };
  }

  /**
   * @param {string} accountId
   */
  async function getCloseState(accountId) {
    return closeStateFromRow(
      await first(
        db,
        "SELECT id, email, state, closed_at, reminder_sent_at, close_mail_sent_at, purged_at, purge_cursor FROM accounts WHERE id = ?1",
        accountId,
      ),
    );
  }

  /**
   * The one revoke that reaches every credential an account holds: each live
   * storage key at the provider and in D1, every live device token, every live
   * share link and every live upload request. Close (drive#235) and
   * sign-out-every-device (drive#236) both call this, so the two cannot drift:
   * a credential that survives one survives the other, and a credential table
   * is added here once rather than at two call sites (drive#497).
   *
   * The account id is the whole filter on every statement, and it is the id
   * the account gate resolved, so a caller can never name another account's
   * rows. Each statement is conditional on its own `revoked_at IS NULL`, so a
   * second call keeps the first revoke's timestamp and counts only what it
   * actually killed.
   *
   * Order, and why: the live keys are read before the write so each one's
   * provider credential can be withdrawn by the access key id its row holds;
   * D1 is then revoked first, so the api refuses every credential from the
   * next request on whether or not the vendor call succeeds; the vendor is
   * last, one credential at a time. A vendor refusal is thrown after the local
   * rows are already dead (revokeCredentialAtProvider), so the failure is
   * visible and a retry — with no live key left — is a clean revoke.
   * @param {string} accountId
   * @returns {Promise<number>} how many storage key rows this call killed
   */
  async function revokeAccountCredentials(accountId) {
    const at = nowSeconds(now());
    const live = await all(
      db,
      "SELECT b2_key_id FROM devices WHERE account_id = ?1 AND revoked_at IS NULL",
      accountId,
    );
    const keys = await run(
      db,
      "UPDATE devices SET revoked_at = ?1 WHERE account_id = ?2 AND revoked_at IS NULL",
      at,
      accountId,
    );
    await run(
      db,
      "UPDATE device_tokens SET revoked_at = ?1 WHERE account_id = ?2 AND revoked_at IS NULL",
      at,
      accountId,
    );
    // The site Worker's share and upload-request rows (src/share.js
    // createD1LinkStore, migrations/drive/0006_share_links.sql). A revoked
    // link is refused by the same `revoked_at` read the single revoke writes,
    // so a link killed here is dead on the next request to whichever isolate
    // answers it.
    await run(
      db,
      "UPDATE shares SET revoked_at = ?1 WHERE account_id = ?2 AND revoked_at IS NULL",
      at,
      accountId,
    );
    await run(
      db,
      "UPDATE upload_requests SET revoked_at = ?1 WHERE account_id = ?2 AND revoked_at IS NULL",
      at,
      accountId,
    );
    for (const row of live) {
      const accessKeyId = /** @type {Record<string, unknown>} */ (row).b2_key_id;
      if (typeof accessKeyId === "string" && accessKeyId !== "") {
        await revokeCredentialAtProvider(accessKeyId);
      }
    }
    return Number(/** @type {{meta?: {changes?: number}}} */ (keys).meta?.changes ?? 0);
  }

  /**
   * Close the account: `state` becomes `closed`, `closed_at` is stamped once,
   * and every live key is revoked. A second close keeps the original stamp so
   * the 30-day window cannot be restarted by retrying.
   * @param {{id: string, email?: string}} account
   * @param {number} atSeconds
   */
  async function closeAccountRow(account, atSeconds) {
    const existing = await getCloseState(account.id);
    const email = account.email ?? existing?.email ?? "";
    await run(
      db,
      `INSERT INTO accounts (id, email, created_at, state, closed_at)
       VALUES (?1, ?2, ?3, 'closed', ?3)
       ON CONFLICT(id) DO UPDATE SET
         state = 'closed',
         email = CASE WHEN excluded.email = '' THEN accounts.email ELSE excluded.email END,
         closed_at = CASE
           WHEN accounts.state = 'closed' AND accounts.closed_at IS NOT NULL
           THEN accounts.closed_at
           ELSE excluded.closed_at
         END`,
      account.id,
      email,
      atSeconds,
    );
    await revokeAccountCredentials(account.id);
    const written = await getCloseState(account.id);
    if (written === null) {
      throw new Error(`closeAccount wrote no accounts row for ${account.id}`);
    }
    return { ...written, alreadyClosed: written.closedAt !== atSeconds };
  }

  /**
   * @param {string} accountId
   */
  async function cancelClose(accountId) {
    const existing = await getCloseState(accountId);
    if (existing === null || existing.state !== "closed" || existing.closedAt === null) {
      throw new TypeError("close-not-closed");
    }
    if (existing.purgedAt !== null) {
      throw new TypeError("close-already-purged");
    }
    await run(
      db,
      `UPDATE accounts
         SET state = 'active', closed_at = NULL, reminder_sent_at = NULL,
             close_mail_sent_at = NULL, purge_cursor = NULL
       WHERE id = ?1`,
      accountId,
    );
    const written = await getCloseState(accountId);
    if (written === null) {
      throw new Error(`cancelClose left no accounts row for ${accountId}`);
    }
    return written;
  }

  /**
   * @param {number} atSeconds
   */
  async function listDueReminder(atSeconds) {
    const rows = await all(
      db,
      `SELECT id, email, state, closed_at, reminder_sent_at, close_mail_sent_at, purged_at, purge_cursor FROM accounts
         WHERE state = 'closed'
           AND closed_at IS NOT NULL
           AND reminder_sent_at IS NULL
           AND purged_at IS NULL
           AND closed_at <= ?1
         LIMIT ?2`,
      atSeconds,
      CLOSE_CRON_LIMIT,
    );
    return rows.map(closeStateFromRow).filter((row) => row !== null);
  }

  /**
   * @param {number} atSeconds
   */
  async function listDuePurge(atSeconds) {
    const rows = await all(
      db,
      `SELECT id, email, state, closed_at, reminder_sent_at, close_mail_sent_at, purged_at, purge_cursor FROM accounts
         WHERE state = 'closed'
           AND closed_at IS NOT NULL
           AND purged_at IS NULL
           AND closed_at <= ?1
         LIMIT ?2`,
      atSeconds,
      CLOSE_CRON_LIMIT,
    );
    return rows.map(closeStateFromRow).filter((row) => row !== null);
  }

  /**
   * Closed accounts whose day-0 receipt never landed, so the nightly pass
   * can send it. No time floor: a close that stamped `closed` and then
   * failed to mail is due on the next run.
   */
  async function listDueCloseMail() {
    const rows = await all(
      db,
      `SELECT id, email, state, closed_at, reminder_sent_at, close_mail_sent_at, purged_at, purge_cursor FROM accounts
         WHERE state = 'closed'
           AND closed_at IS NOT NULL
           AND close_mail_sent_at IS NULL
           AND purged_at IS NULL
         LIMIT ?1`,
      CLOSE_CRON_LIMIT,
    );
    return rows.map(closeStateFromRow).filter((row) => row !== null);
  }

  /**
   * @param {string} accountId
   * @param {number} atSeconds
   */
  async function markReminderSent(accountId, atSeconds) {
    await run(
      db,
      "UPDATE accounts SET reminder_sent_at = ?1 WHERE id = ?2 AND reminder_sent_at IS NULL",
      atSeconds,
      accountId,
    );
  }

  /**
   * @param {string} accountId
   * @param {number} atSeconds
   */
  async function markCloseMailSent(accountId, atSeconds) {
    await run(
      db,
      "UPDATE accounts SET close_mail_sent_at = ?1 WHERE id = ?2 AND close_mail_sent_at IS NULL",
      atSeconds,
      accountId,
    );
  }

  /**
   * Records how far one account's purge got (drive#565): the last drive path
   * whose objects the batch delete removed. The next nightly pass lists from
   * after that path instead of starting over. Conditional on
   * `purged_at IS NULL`, so a late write can never reopen a purged account.
   * @param {string} accountId
   * @param {string} cursor
   */
  async function markPurgeProgress(accountId, cursor) {
    await run(
      db,
      "UPDATE accounts SET purge_cursor = ?1 WHERE id = ?2 AND purged_at IS NULL",
      cursor,
      accountId,
    );
  }

  /**
   * @param {string} accountId
   * @param {number} atSeconds
   */
  async function markPurged(accountId, atSeconds) {
    // The cursor is cleared with the stamp: a purged account has no progress
    // to resume, and a NULL cursor with `purged_at` set reads as finished.
    await run(
      db,
      "UPDATE accounts SET purged_at = ?1, purge_cursor = NULL WHERE id = ?2 AND purged_at IS NULL",
      atSeconds,
      accountId,
    );
  }

  /**
   * Stand-in credential when no storage provider is configured: the api's
   * own storage API is what verifies it, so the pair never has to exist
   * outside this Worker.
   */
  async function mintCredential(/** @type {KeyScope} */ scope) {
    if (inner !== undefined) {
      const minted = await inner.mint(scope);
      return {
        accessKeyId: minted.accessKeyId,
        secret: minted.secret,
        sessionToken: minted.sessionToken ?? null,
        expiresIn: minted.expiresIn ?? null,
      };
    }
    return {
      accessKeyId: newId("ak"),
      secret: newId("sk"),
      sessionToken: null,
      expiresIn: null,
    };
  }

  /**
   * Withdraw one credential at the provider, so a revoked row is also a
   * credential that stops working (drive#371). On a provider whose model is
   * the vendor's own key API this is `remove_access_key`; on the STS path the
   * credential is a bounded session and there is nothing to withdraw, which
   * is why the call is the provider's to make rather than assumed here. A
   * provider that refuses is not swallowed: the api's own row is already
   * revoked (the caller is refused at once), and the refusal is thrown so the
   * failure is visible rather than read as a clean revoke.
   * @param {string} accessKeyId
   */
  async function revokeCredentialAtProvider(accessKeyId) {
    if (inner === undefined || typeof inner.revoke !== "function") {
      return;
    }
    await inner.revoke(accessKeyId);
  }

  /**
   * What an agent key may do right now, with the cap applied where it can be
   * enforced (drive issue #171). This is the path that counts the requests and
   * reads the month, and both real per-key paths call it: `authenticate`, which
   * every request the storage API serves goes through, and `renewKey`, which
   * is the tool's own hourly call. A route that checked the cap on its own
   * would bound only the route that checked it; here the key store owns the
   * key's powers, so a refusal cannot be routed around by using another
   * endpoint.
   *
   * The row that comes back is the swapped one when the cap took the key: a
   * read-only row, whose `capabilities` are the read-only set, so the caller's
   * own write check (keystore.js `canWrite`) refuses the request that crossed
   * the cap and still answers the reads on the same key.
   *
   * The swap is the account cap's swap (`agentCapPlan` over `capSwapPlan` in
   * src/cap.js) on this store's own `keyProviderFor`, which revokes the old
   * credential at the provider before it mints the read-only one, so the write
   * power is gone at the vendor in the same request and not an hour later.
   *
   * A plan built from a "read_only" answer only ever takes powers away, and
   * that is the only answer this applies: nothing here restores a key to write.
   * A write key comes back from `POST /v1/keys` (`drive init`), the one route
   * that hands a credential to a tool, because a restored credential minted
   * here would be a secret nobody is holding.
   * @param {Device} device
   * @returns {Promise<{device: Device, capped: boolean}>}
   */
  async function enforceAgentCaps(device) {
    const status = await agentCapGate(db, device, now());
    if (status === null || status.state !== "read_only") {
      return { device, capped: false };
    }
    const plan = agentCapPlan([capKeyRow(device)], status);
    if (plan.swaps.length === 0) {
      // Already where the cap put it: a second request on a capped key plans
      // no swap, so the key is left exactly as the first one left it.
      return { device, capped: true };
    }
    await applyCapSwap(plan, store.keyProviderFor(device.accountId));
    // The row as it stands now, not the row this call read: the answer has to
    // be the key the store holds, or the caller would write with powers that
    // have already been withdrawn.
    const swapped = deviceFromRow(
      await first(db, "SELECT * FROM devices WHERE id = ?1 AND revoked_at IS NULL", device.id),
    );
    return { device: swapped ?? device, capped: true };
  }

  // The account's live device rows, oldest first, as this module reads them: one
  // statement for every answer about a device that is still signed in
  // (`listCapKeys` for the cap plan, `listLive` for the first-run page's poll),
  // so the two cannot disagree about which rows are live.
  /**
   * @param {string} accountId
   * @returns {Promise<Device[]>}
   */
  async function liveDevices(accountId) {
    const result = await db
      .prepare(
        "SELECT * FROM devices WHERE account_id = ?1 AND revoked_at IS NULL ORDER BY created_at",
      )
      .bind(accountId)
      .all();
    return /** @type {Device[]} */ (
      (result.results ?? []).map(deviceFromRow).filter((device) => device !== null)
    );
  }

  const store = {
    put,

    /**
     * Every device row the account holds, live and revoked, in the public
     * shape the agent key list reads. `listLive` is the answer for a device
     * that is still signed in.
     * @param {{id: string}} account
     * @returns {Promise<ReturnType<typeof publicDevice>[]>}
     */
    async listPublic(account) {
      const result = await db
        .prepare("SELECT * FROM devices WHERE account_id = ?1 ORDER BY created_at")
        .bind(account.id)
        .all();
      return (result.results ?? [])
        .map(deviceFromRow)
        .filter((device) => device !== null)
        .map((device) => publicDevice(device));
    },

    /**
     * The account's live keys in the shape src/cap.js `capSwapPlan` reads.
     * Revoked rows are left out: a revoked key is already gone and must not
     * be swapped again.
     * @param {string} accountId
     */
    async listCapKeys(accountId) {
      const devices = await liveDevices(accountId);
      return devices.map((device) =>
        Object.freeze({
          keyId: device.id,
          kind: device.kind,
          prefix: device.prefix,
          // The bucket this row's own prefix puts it in. A cap swap mints
          // its replacement against this bucket (src/cap.js
          // `applyCapSwap`), so a team key stays in the team's bucket and
          // an account key stays in the account's, whatever the cap does
          // (drive#462).
          bucket: bucketForKeyPrefix(accountId, device.prefix),
          capabilities: Object.freeze([...device.capabilities]),
          ...(device.cappedFrom ? { cappedFrom: Object.freeze([...device.cappedFrom]) } : {}),
        }),
      );
    },

    /**
     * The account's live device rows, oldest first, in the shape the first-run
     * page's poll reads: `id`, `name`, `kind` and `lastSeenAt`. Whether a
     * device reads as connected is not answered here — that window is
     * src/status.js `connectionStatus`'s own, so the page, the route and the
     * CLI share the one rule. The columns behind the answer are this store's:
     * the api Worker's `authenticate` and `renewKey` stamp `last_seen_at` on
     * the row a request authenticated, and drive issue #556 reads it back for
     * the page.
     *
     * `lastSeenAt` is epoch **milliseconds**, because that is the clock
     * src/status.js `connectionStatus` compares against `Date.now()`: the
     * column is epoch seconds (written by `nowSeconds()`), and this is the one
     * read whose answer is that payload, so the conversion happens here once
     * instead of in every caller. A row that never signed in has null. Revoked
     * rows are left out for the same reason as `listCapKeys`: a device whose
     * key was revoked has signed out, so it must not read as connected.
     *
     * Only a machine's own key answers this read (kind `device`). The other
     * kinds in this table are credentials for tools and storage, and every
     * request one authenticates stamps `last_seen_at` on its row
     * (devices.js `authenticate`, `renewKey`), so an agent key would flip the
     * first-run page to "your drive is mounted on this Mac" while the machine
     * has not signed in at all (drive issue #556). The question this read
     * answers is the one `drive login` mints a key to answer.
     *
     * @param {{id: string}} account
     * @returns {Promise<Array<{id: string, name: string, kind: string, lastSeenAt: number|null}>>}
     */
    async listLive(account) {
      const devices = await liveDevices(account.id);
      return devices
        .filter((device) => device.kind === "device")
        .map((device) => ({
          id: device.id,
          name: device.name,
          kind: device.kind,
          lastSeenAt: device.lastSeenAt === null ? null : device.lastSeenAt * 1000,
        }));
    },

    /**
     * The row a storage key authenticates, or null. A revoked key, a wrong
     * secret and a credential past its hour are all null: the caller learns
     * only that the key does not work, never which half was wrong.
     *
     * A request that does authenticate renews the window in the same statement
     * that stamps `last_seen_at` — the one write this path already made —
     * through the one renewal rule in keystore.js `renewKeyWindow`, so a
     * connected tool keeps working without a person re-running anything, and
     * a revoked row (which the WHERE clause already excludes) is never
     * renewed. Two claims the read has to make, in order: a credential past
     * its hour is refused with no write at all, and a machine row that was
     * written before the column existed (drive#106's migration is
     * expand-only, so its `expires_at` is NULL) is handed an hour by that
     * first request rather than being let through immortal — a NULL on
     * `agent`, `s3` or `branch` means "no hour was minted with this one",
     * not "this one lasts forever". Only a `device` row has no hour, and
     * `renewKeyWindow` hands it back untouched.
     * @param {string} accessKeyId
     * @param {string} secret
     * @returns {Promise<Device|null>}
     */
    async authenticate(accessKeyId, secret) {
      const row = await first(
        db,
        "SELECT * FROM devices WHERE b2_key_id = ?1 AND revoked_at IS NULL",
        accessKeyId,
      );
      const device = deviceFromRow(row);
      if (device === null || device.secretHash === "") {
        return null;
      }
      // The one compare in http.js. A device is stored only as the hash of its
      // secret, so both sides here are hashes: the stored one, and the hash of
      // the secret this request presented.
      if (!(await tokensMatch(device.secretHash, await sha256Hex(secret)))) {
        return null;
      }
      const seen = nowSeconds(now());
      const renewed = renewKeyWindow(device, seen);
      if (device.expiresAt !== undefined && device.expiresAt !== null && seen >= device.expiresAt) {
        // Past the hour and nothing renewed it: the credential is dead, so the
        // row is not touched and no window is restarted.
        return null;
      }
      // The renewal is written through the case, so a row whose kind never
      // expires (null) keeps its null rather than being handed one, and the
      // row keeps the later of the two expiries, so a request that read the
      // row first and writes second cannot pull the hour back to the value it
      // read (`renewKeyRow`). The `revoked_at IS NULL` guard repeats the read
      // above: a row revoked between the two statements is not renewed by
      // this one.
      await renewKeyRow(db, device, renewed.expiresAt ?? null, seen);
      // The cap, counted and enforced on the request that proved the key is
      // still held by something using it. A key the cap has taken is handed
      // back read-only, so the write route refuses it (canWrite) while the
      // reads on the same key keep working.
      const capped = await enforceAgentCaps({
        ...device,
        lastSeenAt: seen,
        expiresAt: renewed.expiresAt ?? null,
      });
      return capped.device;
    },

    /**
     * @param {{id: string}} account
     * @param {string} keyId
     * @returns {Promise<{revoked: true}|{error: "not-found"}>}
     */
    async revokeKey(account, keyId) {
      const row = await first(
        db,
        "SELECT * FROM devices WHERE id = ?1 AND account_id = ?2",
        keyId,
        account.id,
      );
      const device = deviceFromRow(row);
      if (device === null) {
        return { error: "not-found" };
      }
      if (device.revokedAt === null) {
        await run(db, "UPDATE devices SET revoked_at = ?1 WHERE id = ?2", nowSeconds(now()), keyId);
        await revokeCredentialAtProvider(device.accessKeyId);
      }
      return { revoked: true };
    },

    /**
     * Revoke every credential one account holds: the key half and the token,
     * share-link and upload-request halves of "sign out of every device" and
     * account close (drive#34, drive#236, drive#497). One account id, taken
     * from the account gate, so the store never reads a row it cannot name and
     * there is no loop that can leave half the account's credentials live.
     *
     * Conditional on each row's own `revoked_at IS NULL`, so a key that is
     * already dead keeps the first revoke's timestamp and the return counts
     * only the storage key rows this call killed: an answer of `0` means every
     * key on this account was already off, while the tokens, links and upload
     * requests are revoked by the same call whether or not a key was left.
     *
     * The revoked keys are refused by the same `authenticate` the single-key
     * revoke's rows are refused by, and each one's vendor credential is
     * withdrawn in the same call, so there is no second path where a key this
     * call turned off still works at the storage server (drive#371). Nothing
     * is deleted: the rows stay, cancelled, so an export and the devices list
     * can still name them.
     * @param {{id: string}} account
     * @returns {Promise<{revoked: number}>}
     */
    async revokeAllKeys(account) {
      return { revoked: await revokeAccountCredentials(account.id) };
    },

    /**
     * Revoke every live key one account holds scoped to `teamId`: the write
     * half of "the owner removes a member and the member's key stops working"
     * (drive#20), and the row the memory store's own `revokeTeamKeys`
     * delegates to when a database is bound.
     *
     * The row, not this isolate's map: `authenticate` reads the database for
     * every key this isolate has not revoked (drive#402), so a removal that
     * only marked the map left a removed member's key working on every other
     * isolate and on every request after this one (drive#408).
     *
     * The prefix is the one rule that names a team key — keyprovider.js
     * `teamPrefix`, the same function `teamScopeFor` writes at mint and both
     * revokes read — so this statement's filter is written once and cannot
     * drift from the prefix a key was minted with. One prefix for both roles,
     * a reader's and a writer's, so neither capability hides from the revoke.
     * An account's own keys and another team's keys carry a different prefix,
     * so they are outside this statement by construction rather than by a
     * LIKE that would let one team id match another's.
     *
     * Conditional on `revoked_at IS NULL`, so a key that is already dead keeps
     * the first revoke's timestamp and `meta.changes` counts only the rows
     * this call killed, which is the number the route reports in
     * `x-drive-revoked-keys`. Nothing is deleted: the row stays, cancelled, so
     * the devices list can still name it.
     * @param {string} accountId
     * @param {string} teamId
     * @returns {Promise<{revoked: number}>}
     */
    async revokeTeamKeys(accountId, teamId) {
      const prefix = teamPrefix(teamId);
      const live = await all(
        db,
        "SELECT b2_key_id FROM devices WHERE account_id = ?1 AND prefix = ?2 AND revoked_at IS NULL",
        accountId,
        prefix,
      );
      const changed = await run(
        db,
        "UPDATE devices SET revoked_at = ?1 WHERE account_id = ?2 AND prefix = ?3 AND revoked_at IS NULL",
        nowSeconds(now()),
        accountId,
        prefix,
      );
      for (const row of live) {
        const accessKeyId = /** @type {Record<string, unknown>} */ (row).b2_key_id;
        if (typeof accessKeyId === "string" && accessKeyId !== "") {
          await revokeCredentialAtProvider(accessKeyId);
        }
      }
      return {
        revoked: Number(/** @type {{meta?: {changes?: number}}} */ (changed)?.meta?.changes ?? 0),
      };
    },

    /**
     * Restart the hour on one of the account's own keys (drive issue #106).
     * The one renewal rule is keystore.js `renewKeyWindow`, so this store and
     * the in-memory stand-in renew by the same amount and by the same refusal
     * set: another account's key is "not found", a revoked key is refused and
     * left exactly as it was, and a kind that never expires is handed back
     * unchanged. No request field is read, so the powers on the row cannot be
     * widened by a call that is only about time.
     *
     * An expired key can be renewed: the credential is dead, but the row is
     * not cancelled and the caller is the signed-in device, so this is the
     * one route by which a tool that sat idle for an hour comes back.
     * @param {{id: string}} account
     * @param {string} keyId
     * @returns {Promise<{renewed: boolean, device: ReturnType<typeof publicDevice>}|{error: string}>}
     */
    async renewKey(account, keyId) {
      const row = await first(
        db,
        "SELECT * FROM devices WHERE id = ?1 AND account_id = ?2",
        keyId,
        account.id,
      );
      const device = deviceFromRow(row);
      if (device === null) {
        return { error: "not-found" };
      }
      if (device.revokedAt !== null) {
        return { error: "revoked" };
      }
      const at = nowSeconds(now());
      const renewed = renewKeyWindow(device, at);
      const before = device.expiresAt ?? null;
      // `revoked_at IS NULL` repeats the read above, and the row count is what
      // proves it landed: a key revoked between the two statements is not
      // renewed by this one, so the answer says revoked rather than renewed.
      // The row keeps the later of the two expiries, the same rule
      // `authenticate` writes, so a slow request cannot pull a restarted hour
      // back to the value it read before the restart.
      const changed = await renewKeyRow(db, device, renewed.expiresAt ?? null, at);
      if (Number(/** @type {{meta?: {changes?: number}}} */ (changed).meta?.changes ?? 0) === 0) {
        return { error: "revoked" };
      }
      // The cap is enforced before the answer, on the same rows: a key at its
      // ceiling is taken read-only here and the renewal is refused rather than
      // handing a tool another hour of a credential the cap has withdrawn. The
      // key row itself is not deleted or cancelled, so the person sees the key
      // they had and `drive init` mints a new one beside it.
      const capped = await enforceAgentCaps({ ...renewed, lastSeenAt: at });
      if (capped.capped) {
        return { error: "capped" };
      }
      return {
        renewed: renewed.expiresAt !== before,
        // The stamp this call just wrote, not the row as it was read: the
        // answer a caller shows has to be the answer the store holds.
        device: publicDevice({ ...renewed, lastSeenAt: at }),
      };
    },

    /**
     * @param {string} accountId
     * @returns {Promise<number>}
     */
    async getCapUsd(accountId) {
      const row = await first(db, "SELECT cap_cents FROM accounts WHERE id = ?1", accountId);
      if (!row || typeof row !== "object") {
        return BILLING_CONFIG.defaultCapUsd;
      }
      const cents = /** @type {{cap_cents?: unknown}} */ (row).cap_cents;
      if (cents === null || cents === undefined) {
        return BILLING_CONFIG.defaultCapUsd;
      }
      if (typeof cents !== "number" || !Number.isFinite(cents)) {
        throw new TypeError(
          `accounts.cap_cents must be a number of cents or null, got ${String(cents)}`,
        );
      }
      return cents / 100;
    },

    /**
     * Whether a card is really on file for this account (drive#417), read
     * from `accounts.card_added_at` — the stamp the card step writes
     * (src/abuse-guards.js), and the only record a card exists. Fail closed: no accounts row and a null stamp both
     * read as no card, because an account that cannot show a card cannot show
     * a charge either (the usage page's "no charge yet" label, src/billing.js).
     * No Dodo call happens here: real capture waits on the Dodo key (#325).
     * @param {string} accountId
     * @returns {Promise<boolean>}
     */
    async cardAdded(accountId) {
      const row = await first(db, "SELECT card_added_at FROM accounts WHERE id = ?1", accountId);
      if (!row || typeof row !== "object") {
        return false;
      }
      const at = /** @type {{card_added_at: unknown}} */ (row).card_added_at;
      if (at === null || at === undefined) {
        return false;
      }
      if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) {
        throw new TypeError(
          `accounts.card_added_at must be a unix second or null, got ${String(at)}`,
        );
      }
      return true;
    },

    /**
     * @param {{id: string, email?: string}} account
     * @param {number} capCents
     */
    async setCapCents(account, capCents) {
      if (!Number.isInteger(capCents) || capCents < 0) {
        throw new TypeError(
          `cap_cents is a whole number of cents, 0 or more, got ${String(capCents)}`,
        );
      }
      await upsertCapCents(account.id, account.email ?? "", capCents);
    },

    setAccountState,
    getCloseState,
    closeAccount: closeAccountRow,
    cancelClose,
    listDueReminder,
    listDuePurge,
    listDueCloseMail,
    markReminderSent,
    markCloseMailSent,
    markPurgeProgress,
    markPurged,

    /**
     * The account's month so far, in the shape usageSummary() reads, for the
     * cap swap `drive cap` runs. The peak is the meter's own
     * `monthUsageRollup` (one MAX, one conversion through `storedGb`), and
     * the GB-minutes are the SUM of the rolled `usage_minutes` rows — the
     * half `monthUsageRollup` deliberately does not own. Both windows use
     * this store's `now()`, so a frozen clock in a test is the month that
     * was seeded, not the wall clock.
     *
     * A month with no rolled rows reads 0/0, which is the $0 an empty month
     * bills and below every cap, so the swap does nothing on a drive that
     * stored nothing. `capUsd` is the amount just set, so the state this read
     * produces is the one the CLI just asked for.
     * @param {string} accountId
     * @param {{capUsd: number}} options
     */
    async monthUsage(accountId, options) {
      const at = now();
      const peak = await monthUsageRollup(db, accountId, at, at);
      const start = monthStart(at);
      const end = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 1);
      const row = await first(
        db,
        `SELECT COALESCE(SUM(gb_minutes_live), 0) AS gb_minutes
           FROM usage_minutes
          WHERE account_id = ?1 AND hour >= ?2 AND hour < ?3`,
        accountId,
        start,
        end,
      );
      const gbMinutes = Number(
        /** @type {{gb_minutes?: unknown} | null | undefined} */ (row)?.gb_minutes ?? 0,
      );
      if (!Number.isFinite(gbMinutes) || gbMinutes < 0) {
        throw new TypeError(`usage_minutes.gb_minutes_live must be 0 or more, got ${gbMinutes}`);
      }
      // The peak is the size the drive holds now (the page's "stored now"); the
      // bill itself reads only the GB-minutes (drive#463).
      const peakGb = storedGb(peak.peakBytes);
      return {
        gbMinutes,
        storedGb: peakGb,
        storedDaily: [],
        downloadBytes: 0,
        averageStoredGb: peakGb,
        capUsd: options.capUsd,
        cardAdded: true,
      };
    },

    /**
     * A KeyProvider bound to one account, so `mint(scope)` can persist the
     * row without the caller smuggling an account id through the scope. The
     * answer is the api's own row-shaped one, key id included.
     * @param {string} accountId
     * @returns {import("./keyprovider.js").AccountKeyProvider}
     */
    keyProviderFor(accountId) {
      return {
        /**
         * @param {KeyScope} scope
         */
        async mint(scope) {
          const sibling = deviceFromRow(
            await first(
              db,
              `SELECT * FROM devices
                 WHERE account_id = ?1 AND prefix = ?2 AND revoked_at IS NULL
                 ORDER BY created_at DESC`,
              accountId,
              scope.prefix,
            ),
          );
          const credential = await mintCredential(scope);
          // The hour the minted credential lives. A key this account already
          // holds on the same prefix (the one being swapped) names the kind, so
          // a swap keeps the lifetime the key had; with no sibling the kind is
          // an agent key, which is what a cap swap replaces.
          const kind = sibling?.kind ?? "agent";
          const ttl = mintTtlSeconds(kind, credential.expiresIn);
          const device = {
            id: newId("key"),
            accountId,
            name: sibling?.name ?? "cap",
            kind,
            accessKeyId: credential.accessKeyId,
            secretHash: await sha256Hex(credential.secret),
            prefix: scope.prefix,
            capabilities: [...scope.capabilities],
            createdAt: nowSeconds(now()),
            expiresAt: ttl === null ? null : nowSeconds(now()) + ttl,
            lastSeenAt: null,
            revokedAt: null,
          };
          await put(device);
          return {
            keyId: device.id,
            accessKeyId: credential.accessKeyId,
            secret: credential.secret,
            sessionToken: credential.sessionToken,
            expiresIn: credential.expiresIn,
            expiresAt: device.expiresAt,
            // The scope's own bucket, in the one answer that carries a
            // credential and the row that holds it (drive#462).
            bucket: scope.bucket,
          };
        },

        /**
         * @param {string} keyId
         */
        async revoke(keyId) {
          const row = await first(
            db,
            "SELECT * FROM devices WHERE id = ?1 AND account_id = ?2",
            keyId,
            accountId,
          );
          const device = deviceFromRow(row);
          if (device === null) {
            throw new Error(`No key ${keyId} on this account to revoke.`);
          }
          await run(
            db,
            "UPDATE devices SET revoked_at = ?1 WHERE id = ?2 AND account_id = ?3 AND revoked_at IS NULL",
            nowSeconds(now()),
            keyId,
            accountId,
          );
          // The api's row is revoked; the vendor's credential is withdrawn
          // in the same request, so a revoked key does not keep working at
          // the storage server until something else expires it (drive#371).
          await revokeCredentialAtProvider(device.accessKeyId);
        },

        /**
         * @param {string} keyId
         */
        async swapToReadOnly(keyId) {
          const row = await first(
            db,
            "SELECT * FROM devices WHERE id = ?1 AND account_id = ?2 AND revoked_at IS NULL",
            keyId,
            accountId,
          );
          const device = deviceFromRow(row);
          if (device === null) {
            throw new Error(`No key ${keyId} on this account to swap.`);
          }
          // The old credential is withdrawn at the vendor before the
          // replacement is minted: a cap swap that left the old key live at
          // the storage server would not cap anything (drive#371).
          await revokeCredentialAtProvider(device.accessKeyId);
          const credential = await mintCredential({
            prefix: device.prefix,
            capabilities: READ_ONLY_CAPABILITIES,
            // The cap swap keeps the key inside the bucket the old key was
            // scoped to, so the replacement credential is limited to the same
            // boundary: an account's own bucket for an account key, and the
            // team's for a key on a team prefix (drive#371, drive#462).
            bucket: bucketForKeyPrefix(accountId, device.prefix),
          });
          // The swap keeps the row's own lifetime and its own id: the hour
          // restarts on the new credential, and the key a person sees listed
          // is the one that was there before. Nothing about the swap widens
          // the window — `cappedFrom` records the powers it took, and the
          // capabilities become READ_ONLY_CAPABILITIES, never more.
          const ttl = mintTtlSeconds(device.kind, credential.expiresIn);
          const updated = {
            ...device,
            accessKeyId: credential.accessKeyId,
            secretHash: await sha256Hex(credential.secret),
            cappedFrom: [...device.capabilities],
            capabilities: [...READ_ONLY_CAPABILITIES],
            expiresAt: ttl === null ? null : nowSeconds(now()) + ttl,
          };
          await put(updated);
          return {
            keyId: updated.id,
            accessKeyId: credential.accessKeyId,
            secret: credential.secret,
            sessionToken: credential.sessionToken,
            expiresIn: credential.expiresIn,
            expiresAt: updated.expiresAt,
          };
        },
      };
    },
  };
  return store;
}
