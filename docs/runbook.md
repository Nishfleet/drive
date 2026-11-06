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
  collects every invocation's console lines for up to 7 days (Cloudflare's
  Workers Logs retention), sampling
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

## Restore a database to the moment before a deploy

D1 Time Travel restores a database to any minute inside its retention window.
The restore point is the start time of the deploy run whose migration went
wrong: copy it from the run page as an ISO 8601 UTC time, for example
`2026-11-01T14:17:00Z`.

**Warning: a restore rewrites the live database back to that moment, and
writes made since are gone.** It is destructive and it is Nish's call, on a
fresh export first (see "The weekly backup").

1. Download the newest weekly artifact for the database you are restoring
   (`d1-backup-waitlist` or `d1-backup-drive`) so the pre-restore state is also
   saved. The drive dump is in `sqlite3` format (see "The weekly backup").
2. Preview the restore (harmless):

   ```sh
   npx cf d1 time-travel restore <database-id> --timestamp <deploy-start-time> --dry-run
   ```

3. Run it for real:

   ```sh
   npx cf d1 time-travel restore <database-id> --timestamp <deploy-start-time> --force
   ```

Database ids: waitlist `93c9f523-159c-4261-8541-d4c059906df3`, drive
`0f636b57-4a2e-482a-bf40-8aa315e2403e` — the same ids the deploy migrates.

## Undo a migration

D1 has no down-migrations anywhere, so a migration is one-way. The order of
escapes, cheapest first:

1. **A forward-fix migration.** If the migration landed but the code that
   reads it did not, or the shape is wrong in a small way, write a new
   migration that corrects the shape and let it apply on the next deploy.
2. **The Time Travel restore** above, when the data itself is wrong and no
   forward fix is clean. A restore to the pre-deploy time undoes the
   migration's writes and everything after them, so it also undoes the
   deploy — restore the database, then redeploy the previous good commit.
3. Never edit an applied migration file in place: D1's migrations table has
   its name recorded, and a rewritten file never runs again.

## The weekly backup

`d1-export.yml` runs Mondays 05:37 UTC (or by hand) and uploads each
database's dump as its own GitHub artifact — `d1-backup-waitlist` and
`d1-backup-drive` — kept 90 days: the copy that survives a wrong restore, a
deleted database or a provider problem. The two databases run as two jobs, so
a database that cannot be dumped fails its own job and costs the other
nothing. The dumps are sealed with `age` before upload: anyone with read
access to this public repository can download its workflow artifacts, so only
the ciphertext leaves the runner.

**The matrix also carries the `0509` database** (fleet-ops#10594). It is
dumped from here because the export credential is the Cloudflare D1 token on
this repository's production environment, D1 permissions are account-scoped,
and the 0509 repository holds no such token and no `AGE_RECIPIENT`. It moves
to its own repository's copy of the job when that setup lands
(fleet-ops#10829); `test/d1-export.test.mjs` fails while it is out of the
matrix, because that would end the only backup it has. Its artifact is named
after the database, so `d1-backup-0509` sits beside `d1-backup-waitlist` on
the run's summary page.

`siterep_payments` and `aiconverter` are backed up by their own
repositories' `d1-export.yml` (siterep-public and aiconverter-app), so they
are not in this matrix: one owner per database. The test fails if either
comes back here.

The TinyStudio signups database was deleted (fleet-ops incident
2026-10-29), so its row left the matrix (drive#1027).

**The drive database is dumped in `sqlite3` format.** The stock D1 export
refuses a database that holds a virtual table, and the FTS5 index on
`file_index` (migration `0039_file_index_fts.sql`) is one. Its matrix row
sets the export API's own `dump_options.compatibility: sqlite3_cli_only`,
which "matches the output of the `sqlite3 .dump` command, including virtual
tables such as FTS5"
(https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/).
That dump loads with plain `sqlite3 -bail`, not with `-safe`, because it
writes the FTS5 table through `PRAGMA writable_schema`. As downloaded, it is
a local SQLite restore and does not load straight back into D1. To put it back
in D1, follow Cloudflare's own workaround for virtual tables (delete them,
move the data, recreate them,
https://developers.cloudflare.com/d1/best-practices/import-export-data/):

1. `sqlite3 -bail restore.db < drive.sql`.
2. In `restore.db`, drop the triggers `file_index_fts_ai`, `file_index_fts_au`
   and `file_index_fts_ad`, then `DROP TABLE file_index_fts`. SQLite drops the
   five `file_index_fts_*` shadow tables with it.
3. `sqlite3 restore.db .dump > d1.sql`. Remove `BEGIN TRANSACTION`, `COMMIT;`
   and any `CREATE TABLE _cf_KV` from `d1.sql`, as the same Cloudflare page
   says, then import it the way "Restore from a dump" steps 4 and 5 say.
4. Run the migration file itself as a query:
   `npx cf d1 query <database-id> --sql="$(cat migrations/drive/0039_file_index_fts.sql)"`.
   Keep the `=`: the file starts with `--`, so `--sql "…"` with a space
   reads it as a new flag and stops with "Unknown argument".
   `test/d1-export.test.mjs` runs every `cf d1` command here with
   `--dry-run`. Do not use `cf d1 migrations apply`, because the imported
   `d1_migrations` table already lists 0039, so `apply` would skip it. The file creates
   `file_index_fts`, fills it from `file_index` (its backfill), and adds the
   three triggers.

The search index holds only `file_index`'s `name`, `account_id` and `path`
under the same rowid, and the triggers keep it in step, so step 4 rebuilds
every search name. The nightly reconciler (`src/search.js`) rewrites it again.

**One-time setup (Nish):** run `age-keygen -o d1-backup-key.txt` on a
machine you keep keys on, and put the public key line it prints (`age1…`)
into the repository variable `AGE_RECIPIENT` (Settings → Secrets and
variables → Actions → Variables). Keep the private file off GitHub and off
the runner. Until `AGE_RECIPIENT` is set the weekly run fails loud on
purpose — a backup that quietly shipped plaintext, or quietly shipped
nothing, is the invisibility drive#520 exists to end.

Restore from a dump. The first restore path is D1 Time Travel
(https://developers.cloudflare.com/d1/reference/time-travel/): it puts a
whole database back to any minute of the last 30 days, and "Restore a
database to the moment before a deploy" above has the commands. Use a dump
only when Time Travel cannot help: a deleted database, a moment older than
30 days, or a read of old rows without touching the live database.

1. Download the artifact for that database from the run's summary page. The
   drive dump is in `sqlite3` format, so after you decrypt it (step 3) a D1
   restore of it takes the four steps under "The drive database is dumped in
   `sqlite3` format" above.
2. The monthly restore drill does exactly this for every database in the
   matrix, on the fleet host where the private key already lives: it takes the
   newest artifact, decrypts it into a local SQLite file, counts the rows and
   writes one report. It is `fleet-d1-restore-drill.service` in the
   Nishfleet/fleet-ops repository, and `docs/RUNBOOK.md` there has its
   schedule and how to start it by hand.
3. Decrypt it with the private key, and check the sha256 the run log
   printed against the decrypted file:

   ```sh
   age -d -i d1-backup-key.txt -o waitlist-<date>.sql waitlist-<date>.sql.age
   sha256sum waitlist-<date>.sql
   ```

4. Small dumps, or a table at a time, go back through the CLI:

   ```sh
   npx cf d1 query <database-id> --sql="$(cat dump.sql)"
   ```

   `--sql` carries the statements in the command line, so split a large dump
   into statement-sized files rather than growing one argument past the
   shell's limit.
5. A whole-database import of a large dump is the D1 import API's
   init/upload/ingest protocol; prefer the Time Travel restore for point-in-
   time recovery and keep the dump for reading and surgical repairs.

## Turn off a reported link

A share link (`/s/<token>`) or an upload request (`/upload.html?k=<token>`) is
reported — someone says it should not be open. Support turns it off in the
drive database, in one step, without a deploy and without the owner's
password. A turned-off link keeps its row with `revoked_at` set
(`migrations/drive/0006_share_links.sql`, tables `shares` and
`upload_requests`), so the owner's list still says "Revoked" and the row is
the proof of the turn-off. The route answers the same `404` for a revoked
link as for one that never existed, so nobody holding the link can tell the
difference.

Both statements below run against the drive database
`0f636b57-4a2e-482a-bf40-8aa315e2403e` (the `DRIVE_DB` binding). `cf d1 raw`
is this repository's `wrangler d1 execute`: it is the command that runs a
write statement against a D1 database, and it is the one that takes
`--local`, so the same statement runs against a local copy and against the
live database.

**Find the account and the links first.** Read-only, and the account id is
what the second statement names. A token is in one table or the other, so
read both:

```sh
npx cf d1 raw 0f636b57-4a2e-482a-bf40-8aa315e2403e --sql "SELECT token, account_id, path, name, created_at, expires_at, revoked_at FROM shares WHERE token = '<token>'"
```

```sh
npx cf d1 raw 0f636b57-4a2e-482a-bf40-8aa315e2403e --sql "SELECT token, account_id, folder, created_at, expires_at, revoked_at FROM upload_requests WHERE token = '<token>'"
```

**Turn off one link.** Run the statement for the table the token is in — a
share link is in `shares`, an upload request is in `upload_requests`. The
`revoked_at` value is epoch milliseconds, the same unit as `created_at` and
`expires_at` in those tables, and SQLite's own clock writes it:

```sh
npx cf d1 raw 0f636b57-4a2e-482a-bf40-8aa315e2403e --sql "UPDATE shares SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE token = '<token>' AND revoked_at IS NULL"
```

```sh
npx cf d1 raw 0f636b57-4a2e-482a-bf40-8aa315e2403e --sql "UPDATE upload_requests SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE token = '<token>' AND revoked_at IS NULL"
```

`AND revoked_at IS NULL` keeps the first turn-off's timestamp, so a second
run does not re-date the row and the owner still sees when the link was
turned off. The row is not deleted: the owner's list reads "Revoked" from it.

**Turn off every public link of one account.** One statement per table, both
of them, so a share link and an upload request of that account go off
together:

```sh
npx cf d1 raw 0f636b57-4a2e-482a-bf40-8aa315e2403e --sql "UPDATE shares SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE account_id = '<account-id>' AND revoked_at IS NULL"
```

```sh
npx cf d1 raw 0f636b57-4a2e-482a-bf40-8aa315e2403e --sql "UPDATE upload_requests SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE account_id = '<account-id>' AND revoked_at IS NULL"
```

`account_id` is the whole filter, so one account's links go off and no other
account's rows are touched. A link that is already off is not re-dated: the
`revoked_at IS NULL` guard leaves the first turn-off's timestamp on it. A
link that had already expired also gets a `revoked_at`, so the owner's list
reads "Revoked" for it rather than "Expired" — it was dead either way.

**Rehearse it locally first.** The same statements run against a local D1,
which is how this section was checked: apply the migrations to a local copy,
put one link in it, run the statement, and the link answers `404` where it
answered `200` before.

```sh
npx cf d1 migrations apply 0f636b57-4a2e-482a-bf40-8aa315e2403e --dir migrations/drive --local --persist-to /tmp/drive-local
npx cf d1 raw 0f636b57-4a2e-482a-bf40-8aa315e2403e --local --persist-to /tmp/drive-local --sql "SELECT token, account_id, revoked_at FROM shares"
npx cf d1 raw 0f636b57-4a2e-482a-bf40-8aa315e2403e --local --persist-to /tmp/drive-local --sql "UPDATE shares SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE token = '<token>' AND revoked_at IS NULL"
```

The local copy is a SQLite file under the state directory
(`--persist-to`), so a row can be read back with `sqlite3` after the
statement. `cf d1 query` runs the same SQL against the live database but has
no local equivalent and refuses the `--local` flag.

## Pause the scheduled jobs

The triggers live in `cloudflare.config.ts` (`triggers.scheduled`). Comment
out the entry, merge through CI, and the job stops firing; uncomment to
resume. A paused monitor opens an issue after two missed windows (about two
hours for the hourly meter) — pause or delete the matching monitor too if
the pause is deliberate.

## Switch the weekly backup off

- Stop the schedule only: delete the `- cron: "37 5 * * 1"` line from
  `.github/workflows/d1-export.yml` and merge through CI. `workflow_dispatch`
  stays, so a restore drill still starts a backup by hand.
- Stop it completely: delete `.github/workflows/d1-export.yml` and merge
  through CI.
- Keep the `AGE_RECIPIENT` repository variable either way: it is the backup
  key's public half, and a backup turned back on later fails loud without it
  rather than shipping plaintext dumps.

## The Access service token and the uptime monitors

The site sits behind Cloudflare Access (drive#159), so `/api/health` needs a
service token before any monitor can reach it:

1. Zero Trust → Access → Service Auth → Service Tokens: create one token.
2. Give it an Access policy on the self-hosted app for the
   `storagebun.com` hostname, scoped to the `/api/health` path only, so the
   token cannot open the drive itself.
3. Set the token's id and secret as `CF_ACCESS_CLIENT_ID` /
   `CF_ACCESS_CLIENT_SECRET` on the `production` environment — the deploy
   smoke starts checking health on the next deploy.
4. Create the uptime monitors (Sentry Uptime or Sentry Crons monitors on the
   four slugs in the table above) with their own second service token — not
   the deploy smoke's — in two headers, `CF-Access-Client-Id` and
   `CF-Access-Client-Secret`. A monitor must assert the body contains
   `"ok":true`: Access answers a dead or missing token with a 302 redirect,
   which counts as down.

Two tokens for the health check, one job each. Both are scoped to
`/api/health` only, so neither can open the drive itself, and a leaked
monitor token is revoked and replaced on its own, without touching the
deploy smoke's credentials or deploying anything (review finding on PR
#697). The storage-event webhook carries a third service token of its own,
scoped to its path only, for the same reason - see "Registering a bucket's
storage notifications" below.

## Worker facts

Generated from `cloudflare.config.ts` and the route table in `src/index-app.js` by `npm run docs:facts` (`src/render-docs.js`). `test/docs-drift.test.mjs` fails when a block differs. Edit the config or the routes, not these lists.

Bindings:
<!-- facts:BINDINGS -->
| Binding | Kind |
| --- | --- |
| `ASSETS` | assets |
| `METER_JOBS` | queue |
| `BRANCH_JOBS` | queue |
| `WAITLIST_DB` | d1 |
| `DRIVE_DB` | d1 |
| `METER_DB` | d1 |
| `BRANCH_SNAPSHOTS` | kv |
| `REINDEX_QUEUE` | queue |
| `METER_EVENT_TOKEN` | secret |
| `API` | worker |
| `WAITLIST_RATE_LIMITER` | rateLimit |
| `SIGNIN_RATE_LIMITER` | rateLimit |
| `SIGNIN_GLOBAL_RATE_LIMITER` | rateLimit |
| `REQUEST_UPLOAD_RATE_LIMITER` | rateLimit |
| `REQUEST_UPLOAD_LINK_RATE_LIMITER` | rateLimit |
| `HEALTH_RATE_LIMITER` | rateLimit |
| `SHARE_DOWNLOAD_RATE_LIMITER` | rateLimit |
| `SHARE_MINT_RATE_LIMITER` | rateLimit |
| `REQUEST_MINT_RATE_LIMITER` | rateLimit |
| `BRANCH_RATE_LIMITER` | rateLimit |
| `EMAIL` | sendEmail |
<!-- /facts:BINDINGS -->
Site Worker routes:
<!-- facts:ROUTES -->
- `ALL /*`
- `ALL /api/keys/revoke`
- `ALL /api/*`
- `GET /api/auth/*`
- `POST /api/auth/*`
- `ALL /v1/*`
- `GET /api/first-run-status`
- `GET /api/search/*`
- `GET /api/files`
- `POST /api/files`
- `GET /api/files/*`
- `POST /api/files/*`
- `GET /api/starter`
- `POST /api/starter`
- `GET /api/branches`
- `POST /api/branches`
- `GET /api/branches/*`
- `POST /api/branches/*`
- `GET /api/rewind`
- `POST /api/rewind`
- `GET /api/rewind/*`
- `POST /api/rewind/*`
- `GET /api/usage`
- `GET /api/export`
- `GET /api/balance`
- `GET /api/milestones`
- `POST /api/milestones`
- `GET /api/history`
- `POST /api/history`
- `GET /api/webhooks`
- `POST /api/webhooks`
- `DELETE /api/webhooks/:id`
- `POST /api/webhooks/:id/test`
- `GET /api/webhooks/:id/deliveries`
- `GET /api/receipts/:id`
- `POST /api/topup/auto`
- `POST /api/topup`
- `GET /api/billing/portal`
- `GET /api/devices`
- `DELETE /api/devices`
- `GET /api/devices/*`
- `DELETE /api/devices/*`
- `GET /api/cap`
- `POST /api/cap`
- `GET /api/account/close`
- `POST /api/account/close`
- `POST /api/account/close/cancel`
- `GET /api/share`
- `POST /api/share`
- `DELETE /api/share`
- `GET /api/request`
- `POST /api/request`
- `DELETE /api/request`
- `POST /api/waitlist`
- `GET /api/quote`
- `POST /api/storage-events`
- `POST /api/storage-events/signed`
- `POST /api/signin`
- `GET /api/signin/verify`
- `GET /api/signin/access`
- `POST /api/signin/access`
- `GET /s/*`
- `GET /api/request/info`
- `POST /api/request/upload`
- `POST /api/billing/webhook`
- `GET /unsubscribe`
- `POST /api/emails/send`
- `GET /api/health`
<!-- /facts:ROUTES -->

## The merge gate

Ruleset `main gate` (id 24262668) guards `main` with GitHub's merge queue and two required checks from `ci.yml`: `verify` and `go`. Nothing else is required. The bypass list is empty: `gh api repos/Nishfleet/drive/rulesets/24262668 --jq '.bypass_actors'` prints `[]`. A renamed required job never reports, so nothing can merge; rename a job only together with the ruleset.

## Registering a bucket's storage notifications (drive#831)

Two doors take a bucket's events, and only one of them is open today:

| Door | Credential | What it does |
| --- | --- | --- |
| `POST /api/storage-events` | `METER_EVENT_TOKEN` in a header | Meters the event. No index job, so the object's search row waits for the nightly reindex. |
| `POST /api/storage-events/signed` | a Standard Webhooks signature (`STORAGE_EVENTS_WEBHOOK_SECRET`) | Meters the event and enqueues a single-object index job, so the row is right in minutes. |

The signed door ships closed: with `STORAGE_EVENTS_WEBHOOK_SECRET` unset it
answers `503` and accepts nothing, the same closed door
`/api/billing/webhook` answers with `DODO_WEBHOOK_SECRET` unset. That name is
not declared in `cloudflare.config.ts` on purpose - a declared
`bindings.secret()` with no value behind it fails every deploy - so the
operator steps below run in this order:

1. Set the secret: `cf workers secrets update STORAGE_EVENTS_WEBHOOK_SECRET --type secret_text --text <value> --worker drive-pricing`,
   with a value of the Standard Webhooks shape (`whsec_<32 random bytes, base64>`).
   `--type` is required: cf refuses the update without it.
   The value survives a deploy.
2. Add one notification rule per bucket in the provider's own console
   (iDrive e2 / MinIO: KeySpace event notifications) pointed at
   `https://storagebun.com/api/storage-events/signed`
   for `s3:ObjectCreated:*` and `s3:ObjectRemoved:*`. A rule that cannot sign
   (a vendor webhook carrying only a bearer token) stays on
   `/api/storage-events` with `METER_EVENT_TOKEN`.
3. Let the rule through Cloudflare Access (operator step, drive#1076). The
   `storagebun.com` app answers every path with the sign-in redirect
   (drive#159), and a vendor webhook cannot follow one, so the rule needs a
   service token as well as its own credential. In the Zero Trust dashboard
   (Access → Applications → the self-hosted app for the host the rule posts
   to: `storagebun.com`, and the workers.dev app while that address stays
   on), add a service-token policy scoped to the `/api/storage-events/*`
   path - create it, or extend an existing service-token policy that already
   covers this path - and put a token whose only policy is this one in the
   rule's `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers, in the
   provider's console on the rule from step 2. A wildcard path does not
   cover its parent, so a rule on the bare `/api/storage-events` door needs
   the `/api/storage-events` path too (Cloudflare One, "Application paths").
   Nothing in this repo applies an Access policy, and the
   `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` values the deploy reads
   are the health probe's, so this step is Nish's, in the dashboard, once per
   app. Confirm it through the wall: the post in the next step carries this
   token in the two headers and no browser, and a `{"ok":true,...}` answer
   is the policy matching. A `302` to
   `https://<account>.cloudflareaccess.com/` is the policy not matching this
   path, and the provider retries that redirect and drops the event.
4. Confirm it: post one signed event (headers `webhook-id`,
   `webhook-timestamp`, `webhook-signature` from `core/topup.js` `signWebhook`,
   plus `CF-Access-Client-Id` and `CF-Access-Client-Secret` from step 3;
   body the fixture in `test/storage-events-signed.test.mjs`, a create with
   `eventName`, `keyName` `u/<account>/notes.md`, and `bucket` that account's
   own name) and expect `{"ok":true,"stored":1,"deduped":0,"enqueued":1}`.
   Repost the same `webhook-id` and expect `stored:0`, `deduped:1`,
   `enqueued:0`. Then wait for the next nightly run and confirm the row is
   there.

Until step 2 is done for a bucket, a file saved into it through the drive
folder, the S3 API or an agent tool is metered and indexed at the nightly run
(03:00 and 04:00 UTC), which is what the limits page says today.
