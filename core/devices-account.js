// Split out of core/devices.js (drive#617) to keep it under 800 lines; behaviour is unchanged.
import { BILLING_CONFIG, size30DropsOutDay, size30Window, storedGb } from "./billing.js";
import { first, run } from "./db.js";
import { monthStart, monthUsageThrough, size30Through } from "./meter-usage.js";

/** @typedef {import("./devices-rows.js").DeviceStoreContext} DeviceStoreContext */
/** @typedef {import("./devices-rows.js").Device} Device */
/** @typedef {import("./devices-rows.js").KeyScope} KeyScope */

/**
 * @param {DeviceStoreContext} ctx
 */
export function createAccountMethods(ctx) {
  const { db, now, upsertCapCents, readCardAdded } = ctx;

  return {
    helpers: {},
    methods: {
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
       * (core/abuse-guards.js), and the only record a card exists. Fail closed: no accounts row and a null stamp both
       * read as no card, because an account that cannot show a card cannot show
       * a charge either (the usage page's "no charge yet" label, core/billing.js).
       * No Dodo call happens here: real capture waits on the Dodo key (#325).
       * @param {string} accountId
       * @returns {Promise<boolean>}
       */
      async cardAdded(accountId) {
        return readCardAdded(accountId);
      },

      /**
       * The Better Auth `user` row behind an account id (drive issue #684), for
       * the display name an upload page and its digest show. The `user` table is
       * Better Auth's own (migrations/drive/0005_better_auth.sql) and `id` is
       * its primary key, so the upload link row's `account_id` is the id here;
       * the read matches src/auth.js's own columns rather than the `accounts`
       * billing row. `name` is the row's own value and may be blank: a caller
       * that shows a name to a stranger must not fall back to the address, and
       * the digest caller that may use the address already has `email`. A blank
       * address (an account that cannot be mailed) reads null, so the caller
       * reports it instead of mailing nobody.
       * @param {string} accountId
       * @returns {Promise<{id: string, name: string, email: string}|null>}
       */
      async accountById(accountId) {
        const row = /** @type {{id?: unknown, name?: unknown, email?: unknown}|null|undefined} */ (
          await first(db, 'SELECT id, name, email FROM "user" WHERE id = ?1', accountId)
        );
        if (row === null || row === undefined || typeof row.id !== "string" || row.id === "") {
          return null;
        }
        if (typeof row.email !== "string" || row.email === "") {
          return null;
        }
        return {
          id: row.id,
          name: typeof row.name === "string" ? row.name : "",
          email: row.email,
        };
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

      /**
       * The account's month so far, in the shape usageSummary() reads, for the
       * cap swap `drive cap` runs and the hourly enforcement walk
       * (drive#496). It is `monthUsageThrough` (core/meter.js) and nothing else:
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
        const window = size30Window(at);
        const size30 = await size30Through(db, accountId, window.from, at);
        const reachedDay =
          size30.reachedHour === null
            ? null
            : new Date(size30.reachedHour).toISOString().slice(0, 10);
        return {
          size30Bytes: size30.size30Bytes,
          size30ReachedDay: reachedDay,
          size30DropsOutDay: reachedDay === null ? null : size30DropsOutDay(reachedDay),
          storedGb: storedGb(month.peakBytes),
          storedDaily: [],
          downloadBytes: size30.downloadBytes,
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
    },
  };
}
