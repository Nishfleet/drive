// The nightly Recently-deleted purge. Extracted from core/files.js (drive#617).

import { parseTrashName, RECENTLY_DELETED_DAYS, TRASH_PATH, trashStorePath } from "./file-paths.js";
import { scopeStore } from "./file-store.js";

/** @typedef {import("./file-store.js").FileStore} FileStore */

// ------------------------------------------------------- the daily purge

/**
 * The cron string the nightly trash purge runs on. The trigger that fires it
 * lives in cloudflare.config.ts, spelled out by hand there because the config
 * cannot import this module (drive#432); test/meter.test.mjs's wiring pin
 * reads both and fails when the two strings drift apart.
 * @type {"0 5 * * *"}
 */
export const TRASH_PURGE_SCHEDULE = "0 5 * * *";

/**
 * Whether a parked file is past the window the page promises (drive issue
 * #521): older than RECENTLY_DELETED_DAYS, the point where `isRestorable`
 * has stopped saying yes and every copy on the page says it is gone. A name
 * dated in the future — a skewed clock where the delete happened — is never
 * expired, so it waits for now to catch up rather than vanishing a day
 * before its own window opens.
 * @param {number} deletedAt epoch milliseconds, from parseTrashName
 * @param {number} now epoch milliseconds
 */
export function isTrashExpired(deletedAt, now = Date.now()) {
  return now - deletedAt > RECENTLY_DELETED_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Empty every account's Recently deleted of what the page no longer promises
 * (drive issue #521): a parked file older than RECENTLY_DELETED_DAYS is
 * removed from storage, so the 30-day promise the Files page makes is a
 * promise about a window, not about a forever.
 *
 * Runs on TRASH_PURGE_SCHEDULE from the Worker's `scheduled` handler, so a
 * scheduled run has no request and so no signed-in account: the accounts to
 * walk are the rows in the `accounts` table, the same source the account
 * close cron takes its due rows from. Every account has a bucket (provisioned
 * at sign-up, drive#371), so a listing that fails is a real failure and this
 * lets it throw — a purge that silently skipped an account would leave files
 * past their promised removal day while the logs read success.
 *
 * Only entries whose name parses as a trash name are removed: a stray file
 * or folder under .trash that the park path did not write is not ours to
 * judge, and the next run sees it again.
 *
 * @param {D1Database} db the customer database (the `accounts` table)
 * @param {FileStore} store the unscoped store; this function scopes it per
 *   account, the same scoping every account-walking cron gets
 * @param {number} now epoch milliseconds, injectable so the tests pin one
 * @returns {Promise<{accounts: number, purged: number}>} how many accounts
 *   were walked and how many parked files were removed
 */
export async function purgeExpiredTrash(db, store, now = Date.now()) {
  const rows = await db.prepare("SELECT id FROM accounts").all();
  const accounts = /** @type {{id: string}[]} */ (rows.results ?? []);
  let purged = 0;
  for (const row of accounts) {
    const scoped = scopeStore(store, { id: row.id });
    // The recursive walk, because a parked file nests under
    // `.trash/<path>/<ts>` (drive#570): `list` is one folder deep and would
    // see the folders and none of the files in them.
    const entries = await scoped.listAll(TRASH_PATH);
    for (const entry of entries) {
      const parsed = parseTrashName(entry.name);
      if (parsed && isTrashExpired(parsed.deletedAt, now)) {
        await scoped.remove(trashStorePath(entry.name));
        purged += 1;
      }
    }
  }
  return { accounts: accounts.length, purged };
}
