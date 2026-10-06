# Runbook: alarms, restore points and the weekly backup

The operator procedures for the alarms drive#520 turned on. Every step names
the command a person runs from a checkout with `npx cf` authenticated
(`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in the environment).
Nothing here runs on its own except the workflows named in each section.

## Where a failure becomes visible

- **Sentry errors** — every request error and every `waitUntil` rejection is
  reported through `src/monitoring.js` (`captureError`), when the deployment
  has `SENTRY_DSN` set. An unset DSN is safe: nothing reports and nothing
  breaks.
- **Sentry Crons monitors** — each scheduled branch checks in under its own
  monitor slug, upserted from the cron string in the code:

  | Branch | Slug | Schedule |
  | --- | --- | --- |
  | Meter hourly rollup | `meter-hourly-rollup` | `5 * * * *` |
  | Meter nightly reconciler | `meter-nightly-reconcile` | `0 4 * * *` |
  | Nightly reindex | `nightly-reindex` | `0 3 * * *` |
  | Nightly trash purge | `nightly-trash-purge` | `0 5 * * *` |
  | Nightly account close | `nightly-account-close` | `0 6 * * *` |

  A missing or late check-in opens an issue on the second consecutive miss
  (`failureIssueThreshold: 2`); the first good run resolves it.
- **The billing gap warning** — when the meter's catch-up cap leaves closed
  hours unbilled, the hourly run raises a Sentry warning with both marks.
  The gap drains itself on later runs; a warning that repeats every hour for
  a day means the drain is stuck.
- **Workers Logs** — `observability.enabled` in `cloudflare.config.ts`
  collects every invocation's console lines for 14 days, sampling
  everything. This is the floor under Sentry, not the pager.
- **`/api/health`** — answers `{"ok":true}` only when the meter's watermark
  is fresh and the storage reader works; a stale meter or the in-memory
  fallback fails the check by design. It is the deploy smoke's probe
  (deploy-production.yml) and the shape the uptime monitors assert.
- **The deploy smoke** — every deploy checks the live Worker version and
  `/api/health` through the Access service token, and rolls the Worker
  version back on failure. Until `CF_ACCESS_CLIENT_ID` /
  `CF_ACCESS_CLIENT_SECRET` are set on the `production` environment the
  health half is skipped with a warning on the run.

## Restore a database to the deploy's bookmark

Before any migration, the deploy captures each database's Time Travel
bookmark, prints it in the run log and the step summary ("restore point for
waitlist (bookmark): …"). The bookmark is the point a restore returns to.

**Warning: a restore rewrites the live database back to that moment, and
writes made since are gone.** It is destructive and it is Nish's call, on a
fresh export first (see the next section).

1. Download the newest weekly artifact (`d1-backup`) so the pre-restore
   state is also saved.
2. Preview the restore (harmless):

   ```sh
   npx cf d1 time-travel restore <database-id> --bookmark <bookmark> --dry-run
   ```

3. Run it for real:

   ```sh
   npx cf d1 time-travel restore <database-id> --bookmark <bookmark> --force
   ```

Database ids: waitlist `93c9f523-159c-4261-8541-d4c059906df3`, drive
`0f636b57-4a2e-482a-bf40-8aa315e2403e` — the same ids the deploy bookmarks
and migrates.

## Undo a migration

D1 has no down-migrations anywhere, so a migration is one-way. The order of
escapes, cheapest first:

1. **A forward-fix migration.** If the migration landed but the code that
   reads it did not, or the shape is wrong in a small way, write a new
   migration that corrects the shape and let it apply on the next deploy.
2. **The bookmark restore** above, when the data itself is wrong and no
   forward fix is clean. A restore to the pre-migration bookmark undoes the
   migration's writes and everything after them, so it also undoes the
   deploy — restore the database, then redeploy the previous good commit.
3. Never edit an applied migration file in place: D1's migrations table has
   its name recorded, and a rewritten file never runs again.

## The weekly backup

`d1-export.yml` runs Mondays 05:37 UTC (or by hand) and uploads
`waitlist-<date>.sql.age` and `drive-<date>.sql.age` as the `d1-backup`
GitHub artifact, kept 90 days — the copy that survives a wrong restore, a
deleted database or a provider problem. The dumps are sealed with `age`
before upload: anyone with read access to this private repository can
download its workflow artifacts, so only the ciphertext leaves the runner.

**One-time setup (Nish):** run `age-keygen -o d1-backup-key.txt` on a
machine you keep keys on, and put the public key line it prints (`age1…`)
into the repository variable `AGE_RECIPIENT` (Settings → Secrets and
variables → Actions → Variables). Keep the private file off GitHub and off
the runner. Until `AGE_RECIPIENT` is set the weekly run fails loud on
purpose — a backup that quietly shipped plaintext, or quietly shipped
nothing, is the invisibility drive#520 exists to end.

Restore from a dump:

1. Download the artifact from the run's summary page.
2. Decrypt it with the private key, and check the sha256 the run log
   printed against the decrypted file:

   ```sh
   age -d -i d1-backup-key.txt -o drive-<date>.sql drive-<date>.sql.age
   sha256sum drive-<date>.sql
   ```

3. Small dumps, or a table at a time, go back through the CLI:

   ```sh
   npx cf d1 query <database-id> --sql "$(cat dump.sql)"
   ```

   `--sql` carries the statements in the command line, so split a large dump
   into statement-sized files rather than growing one argument past the
   shell's limit.
4. A whole-database import of a large dump is the D1 import API's
   init/upload/ingest protocol; prefer the Time Travel restore for point-in-
   time recovery and keep the dump for reading and surgical repairs.

## Pause the scheduled jobs

The triggers live in `cloudflare.config.ts` (`triggers.scheduled`). Comment
out the entry, merge through CI, and the job stops firing; uncomment to
resume. A paused monitor opens an issue after two missed windows (about two
hours for the hourly meter) — pause or delete the matching monitor too if
the pause is deliberate.

## The Access service token and the uptime monitors

The site sits behind Cloudflare Access (drive#159), so `/api/health` needs a
service token before any monitor can reach it:

1. Zero Trust → Access → Service Auth → Service Tokens: create one token.
2. Give it an Access policy on the self-hosted app for the
   `drive-pricing.nishant345.workers.dev` hostname, scoped to the
   `/api/health` path only, so the token cannot open the drive itself.
3. Set the token's id and secret as `CF_ACCESS_CLIENT_ID` /
   `CF_ACCESS_CLIENT_SECRET` on the `production` environment — the deploy
   smoke starts checking health on the next deploy.
4. Create the uptime monitors (Sentry Uptime or Sentry Crons monitors on the
   four slugs in the table above) with their own second service token — not
   the deploy smoke's — in two headers, `CF-Access-Client-Id` and
   `CF-Access-Client-Secret`. A monitor must assert the body contains
   `"ok":true`: Access answers a dead or missing token with a 302 redirect,
   which counts as down.

Two tokens, one job each. Both are scoped to `/api/health` only, so neither
can open the drive itself, and a leaked monitor token is revoked and
replaced on its own, without touching the deploy smoke's credentials or
deploying anything (review finding on PR #697).
