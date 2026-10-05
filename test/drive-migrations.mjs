// The drive database's migrations, read from the folder they ship in.
//
// Every test that wants "a customer database" wants the same thing: the schema
// the deploy builds, no more and no less. Both D1 stand-ins used to answer
// that with a hand-written list of file names - test/harness.mjs carried two of
// them - and a hand-written list drifts. Seven of the files in
// `migrations/drive/` were in neither, so a test could prove a thing about a
// table or a column production does not have, and stay green while doing it
// (drive#579). A migration added today lands here with no edit, and the next
// run of the suite either reads the real column or fails.
//
// The order is the one `wrangler d1 migrations apply` uses: the number first,
// then the whole file name. So `0012_agent_key_ttl.sql` lands before
// `0012_branch_snapshot_kv.sql` exactly as the deploy orders them, and two
// files that ever share a number have an order that does not depend on which
// order the filesystem hands the directory back in.
//
// This lives in its own module rather than inside either stand-in because the
// list is the one thing both of them must agree on, and the failure when they
// do not is invisible: one adapter builds a schema the other never sees.

import { readdirSync, readFileSync } from "node:fs";

const migrationsDir = new URL("../migrations/drive/", import.meta.url);

/** Every migration in the folder, in the order the deploy applies them. */
export const DRIVE_MIGRATION_NAMES = Object.freeze(
  readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b)),
);

/**
 * The same list as the paths `createTestD1` applies, relative to
 * `migrations/`, which is the shape a test hands it.
 */
export const DRIVE_MIGRATIONS = Object.freeze(DRIVE_MIGRATION_NAMES.map((name) => `drive/${name}`));

/**
 * Every drive migration applied to a real SQLite database, in order.
 * @param {import("node:sqlite").DatabaseSync} sqlite
 */
export function applyDriveMigrations(sqlite) {
  for (const name of DRIVE_MIGRATION_NAMES) {
    sqlite.exec(readFileSync(new URL(`../migrations/drive/${name}`, import.meta.url), "utf8"));
  }
}
