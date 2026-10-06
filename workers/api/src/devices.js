import { applyCapSwap } from "../../../src/cap.js";
import { agentCapGate, agentCapPlan, capKeyRow } from "./agent-caps.js";
import { all, first, newId, nowSeconds, run } from "./db.js";
import { bindD1DeviceStore } from "./device-d1-api.js";

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
  /** @type {ReturnType<typeof bindD1DeviceStore>} */
  let store;
  const now = options.now ?? (() => Date.now());
  const inner = options.keyProvider;
  // Whether this deployment's provider mints credentials that die on their
  // own (the STS path, s3-keys.js `namesSession`). When it does, a device
  // row whose `expires_at` is null is not a permanent key: it is a row the
  // pre-#544 code wrote over a session that has since died, and the
  // authenticate below refuses it instead of reading the null as forever
  // (drive#713). A provider that names no session — iDrive's key pairs, the
  // stand-in — leaves those rows exactly the permanent keys they say they
  // are.
  const providerNamesSessions = inner !== undefined && inner.namesSession === true;
  // One provider revoke, retried: enough for a blip, small enough that a
  // request is not held long when the vendor is down for real.
  const PROVIDER_REVOKE_ATTEMPTS = 3;
  const PROVIDER_REVOKE_PAUSE_MS = 100;

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
   * Whether a card is really on file, as `cardAdded` and `monthUsage` both
   * need it. One query, one set of rules: fail closed on a missing row and on
   * a null stamp, and a stamp that is not a positive unix second is a type
   * error rather than a silent false.
   * @param {string} accountId
   * @returns {Promise<boolean>}
   */
  async function readCardAdded(accountId) {
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
  }

  /**
   * The cap's own write of the account state, guarded: it moves a row between
   * `active` and `read_only` and leaves a `closed` row closed (drive#496, the
   * owner's second addition on #496 — the unguarded form un-closed a closed
   * account, because both the cap write and the hourly cap walk land here).
   *
   * `closed` is the terminal state of src/account-close.js: its keys are
   * already revoked and its files are on their way out, so nothing about the
   * spending cap may say the account is active again. A row that does not
   * exist yet is still written, because a cap set before the close row exists
   * is the only record of the cap.
   *
   * @param {string} accountId
   * @param {"active"|"read_only"|"closed"} state
   */
  async function setAccountState(accountId, state) {
    await run(
      db,
      `UPDATE accounts SET state = ?1
        WHERE id = ?2 AND COALESCE(state, 'active') <> 'closed'`,
      state,
      accountId,
    );
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
   *
   * A refused call is retried a short, bounded number of times first
   * (drive#518 review): a vendor blip must not strand a live credential
   * behind rows that already say revoked, and a stranded one is exactly the
   * hole drive#497 and this issue close. The last refusal is re-thrown, so a
   * persistent outage still surfaces on the route that asked for the revoke.
   * @param {string} accessKeyId
   */
  async function revokeCredentialAtProvider(accessKeyId) {
    if (inner === undefined || typeof inner.revoke !== "function") {
      return;
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await inner.revoke(accessKeyId);
        return;
      } catch (error) {
        if (attempt >= PROVIDER_REVOKE_ATTEMPTS) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, PROVIDER_REVOKE_PAUSE_MS));
      }
    }
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

  store = bindD1DeviceStore({
    db,
    now,
    put,
    providerNamesSessions,
    liveDevices,
    mintCredential,
    revokeCredentialAtProvider,
    enforceAgentCaps,
    upsertCapCents,
    readCardAdded,
    setAccountState,
    getCloseState,
    revokeAccountCredentials,
    closeAccountRow,
    cancelClose,
    listDueReminder,
    listDuePurge,
    listDueCloseMail,
    markReminderSent,
    markCloseMailSent,
    markPurgeProgress,
    markPurged,
    deviceFromRow,
    renewKeyRow,
  });
  return store;
}
