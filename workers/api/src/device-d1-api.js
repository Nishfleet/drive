// D1 device-store methods. Extracted from workers/api/src/devices.js
// (drive issue #617) with no behaviour change; createD1DeviceStore still
// builds the nested helpers and returns this object.

import { BILLING_CONFIG, minutesInMonth, storedGb } from "../../../src/billing.js";
import { READ_ONLY_CAPABILITIES } from "../../../src/cap.js";
import { monthStart, monthUsageThrough } from "../../../src/meter.js";
import { all, first, newId, nowSeconds, run, sha256Hex } from "./db.js";
import { tokensMatch } from "./http.js";
import { bucketForKeyPrefix, mintTtlSeconds, teamPrefix } from "./keyprovider.js";
import { publicDevice, renewKeyWindow } from "./keystore.js";

const _CLOSE_CRON_LIMIT = 100;

/**
 * @param {Record<string, unknown>} ctx
 */
export function bindD1DeviceStore(ctx) {
  const {
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
  } = ctx;
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
      // drive#713: on a provider that names a session (the STS path), a
      // `device` row with no expiry at all is not a permanent key — it is a
      // row the pre-#544 code wrote over a session the vendor has since
      // ended, read as "never expires". The api cannot re-mint for the
      // caller here (it holds only the secret's hash), and a machine kind's
      // null is a different claim — "no hour was minted", which renewal
      // starts — so this is the device kind only. The row is refused with no
      // write, the same answer a wrong secret or a dead hour gets, and it is
      // left in the table: `drive login` again is the way forward, and the
      // minted answer names the session it dies at (drive#544). A provider
      // that names no session keeps these rows working as the permanent keys
      // they say they are.
      if (
        providerNamesSessions &&
        device.kind === "device" &&
        (device.expiresAt === undefined || device.expiresAt === null)
      ) {
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
      return readCardAdded(accountId);
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
     * cap swap `drive cap` runs and the hourly enforcement walk
     * (drive#496). It is `monthUsageThrough` (src/meter.js) and nothing else:
     * the one SUM/MAX/AVG the Dodo push reads (src/dodo.js), so the cap, the
     * invoice and the enforcement walk cannot count three different months.
     * That read carries the download bytes too, which the half of it that
     * lived here did not, so a month of downloads alone can now reach the
     * cap like a month of storage does.
     *
     * A month with no rolled rows reads all zeroes, which is the $0 an empty
     * month bills and below every cap, so the swap does nothing on a drive
     * that stored nothing. `capUsd` is the amount the caller is enforcing at
     * — just set by `drive cap`, or the account's own cap for the cron walk.
     * @param {string} accountId
     * @param {{capUsd: number}} options
     */
    async monthUsage(accountId, options) {
      const at = now();
      const month = await monthUsageThrough(db, accountId, at);
      // The peak is the size the drive holds now (the page's "stored now"); the
      // bill itself reads only the GB-minutes (drive#463).
      const peakGb = storedGb(month.peakBytes);
      return {
        gbMinutes: month.gbMinutes,
        // The month this read's minutes fell in sets the divisor (drive#531).
        monthMinutes: minutesInMonth(at),
        storedGb: peakGb,
        storedDaily: [],
        downloadBytes: month.downloadBytes,
        // The month's own average, not its peak: a save re-marks the hour, so
        // the peak runs ahead of what the drive held and the cap would trip
        // early on a busy day (drive#535). The average is what the invoice's
        // maximum follows too (drive#463).
        averageStoredGb: month.averageStoredGb,
        capUsd: options.capUsd,
        cardAdded: true,
        // The display stamp only, forwarded from the same accounts row
        // `cardAdded` reads (drive#417): until a card is really on file the
        // usage page says no charge has been made and shows no bill. The cap
        // line and the write cap do not read it.
        cardOnFile: await readCardAdded(accountId),
      };
    },

    /**
     * Every account the cap walk has to decide this month (drive#496): the
     * ones with a `usage_minutes` row in the month so far, plus any account
     * still carrying a cap state or notice from before — a drive made
     * read-only last month has no row yet this month, and without it here it
     * would stay read-only into a month it has not spent anything in. An
     * account with neither bills $0 and is below every cap, so the walk does
     * not spend a query on it.
     * @returns {Promise<ReadonlyArray<{id: string}>>}
     */
    async listMeteredAccounts() {
      const result = await db
        .prepare(
          `SELECT account_id FROM usage_minutes WHERE hour >= ?1 AND account_id <> ''
           UNION
           SELECT id FROM accounts
            WHERE state = 'read_only' OR cap_warned_at IS NOT NULL OR read_only_sent_at IS NOT NULL`,
        )
        .bind(monthStart(now()))
        .all();
      return (result?.results ?? []).map(
        (row) =>
          /** @type {{id: string}} */ ({
            id: String(/** @type {{account_id?: unknown}} */ (row).account_id),
          }),
      );
    },

    /**
     * The cap notices this account has already been sent, and the address to
     * send the next one to (drive#496). Both stamps are nullable by
     * construction (migrations/drive/0024_cap_notices.sql): null is "never
     * sent", which is what a drive that has never crossed 80% and has never
     * been read-only has. The read is the whole notice state, so the walk
     * cannot send one of these twice by asking a different question.
     *
     * The address comes from the same accounts row every other cap read uses
     * (getCapUsd, cardAdded), and a row with no address reads as an empty
     * string so the caller reports it instead of sending to nobody.
     * @param {string} accountId
     * @returns {Promise<{email: string, warnedAt: number|null, readOnlySentAt: number|null}>}
     */
    async capNotices(accountId) {
      const row =
        /** @type {{email?: unknown, cap_warned_at?: unknown, read_only_sent_at?: unknown}|null|undefined} */ (
          await first(
            db,
            "SELECT email, cap_warned_at, read_only_sent_at FROM accounts WHERE id = ?1",
            accountId,
          )
        );
      const at = (/** @type {unknown} */ value) =>
        value === null || value === undefined ? null : Number(value);
      return {
        email: typeof row?.email === "string" ? row.email : "",
        warnedAt: at(row?.cap_warned_at),
        readOnlySentAt: at(row?.read_only_sent_at),
      };
    },

    /**
     * Stamp one cap notice as sent. Guarded on the stamp still being null, the
     * same rule src/account-close.js's markCloseMailSent uses: a retry of the
     * hourly walk that ran while another run was mid-send cannot move a stamp
     * that is already there, so a notice goes out once per crossing even if
     * two runs overlap.
     * @param {string} accountId
     * @param {"cap-warning"|"read-only"} kind
     * @param {number} atSeconds
     */
    async markCapNoticeSent(accountId, kind, atSeconds) {
      const column =
        kind === "cap-warning"
          ? "cap_warned_at"
          : kind === "read-only"
            ? "read_only_sent_at"
            : null;
      if (column === null) {
        throw new TypeError(
          `markCapNoticeSent needs kind "cap-warning" or "read-only", got ${String(kind)}`,
        );
      }
      // The column name is one of the two literals above and never anything a
      // caller passed, so this is not a caller-shaped SQL string.
      await run(
        db,
        `UPDATE accounts SET ${column} = ?1 WHERE id = ?2 AND ${column} IS NULL`,
        atSeconds,
        accountId,
      );
    },

    /**
     * Re-arm one cap notice: clear its stamp once the state it announced has
     * ended, so the next crossing is mailed again (drive#496).
     * @param {string} accountId
     * @param {"cap-warning"|"read-only"} kind
     */
    async clearCapNotice(accountId, kind) {
      const column =
        kind === "cap-warning"
          ? "cap_warned_at"
          : kind === "read-only"
            ? "read_only_sent_at"
            : null;
      if (column === null) {
        throw new TypeError(
          `clearCapNotice needs kind "cap-warning" or "read-only", got ${String(kind)}`,
        );
      }
      // One of the two literals above, never caller-shaped SQL.
      await run(db, `UPDATE accounts SET ${column} = NULL WHERE id = ?1`, accountId);
    },

    /**
     * The cap state the account row currently carries, or "active" when the
     * row is gone. The web upload lane and the public upload links read this,
     * so a read-only account is refused at the edge without re-counting the
     * month (drive#496).
     * @param {string} accountId
     * @returns {Promise<"active"|"read_only"|"closed">}
     */
    async accountState(accountId) {
      const row = await first(db, "SELECT state FROM accounts WHERE id = ?1", accountId);
      const state = /** @type {{state?: unknown} | null | undefined} */ (row)?.state;
      if (state === undefined || state === null) {
        return "active";
      }
      if (state !== "active" && state !== "read_only" && state !== "closed") {
        throw new TypeError(
          `accounts.state must be "active", "read_only" or "closed", got ${String(state)}`,
        );
      }
      return state;
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
