# Restore runbook

How to put data back. Read the whole page before acting: one of these paths can
destroy the thing it is meant to recover, and the rule at the end is the one
that matters.

## The one rule

Rollback rolls back code, never data. D1, KV, the object storage and the Durable
Objects sit outside the Worker version, and D1 has no down-migrations anywhere.
A migration is one-way. Restoring data is a separate, deliberate act from
rolling back a deploy.

## A file a person deleted

1. If they deleted it from the Files page, it is in `.trash/` for 30 days and
   they can restore it themselves from "Recently deleted" (`purgeExpiredTrash`,
   `core/files.js:717`). Send them there first.
2. If they deleted it any other way (the CLI, an rclone command), the object
   storage still holds the previous version. Every stored path keeps its
   versions, and the reconciler reads them through `store.listVersions`
   (`core/files.js:831`, the shape the reconciler and an operator both read). An
   operator restores the wanted version into the current key. The window is the
   provider's version window, so do this as soon as the request arrives.
3. Do not run the nightly trash purge by hand to "tidy up" while a restore is
   in flight. It runs at 05:00 UTC (`TRASH_PURGE_SCHEDULE`, `core/files.js:676`).

## A D1 row or table

There is no down-migration. Recovery is forward:

- If the row was overwritten by a bug, fix the bug and write the correct value
  forward with a new migration.
- If the database itself is lost, that is a provider-level restore, and it is
  Nish's call. D1 Time Travel and the Cloudflare dashboard are the provider's
  tools, never an agent's silent action.

## The whole site

Roll the Worker back to a known-good version if a deploy is at fault (see
`docs/runbooks/incident.md`). That restores the routes and the pages. It does
not touch the data.

## The backup that is not built yet

`docs/build-spec.md` step 8 ("Backup and old versions") plans a nightly
`rclone sync --backup-dir` from the primary storage to a Hetzner Storage Box,
with a 31-day purge. It is not built, and the restore command from it does not
ship yet: `cmd/drive/main.go:147` records that `drive restore` is no longer
advertised. Until it is:

- The provider's own versioning is the only copy of an old file.
- A file removed from the primary storage on purpose is gone once the window
  closes.
- The backup timer must alert on a missed night, because a silent miss reads as
  a good backup.

Building step 8 is tracked in `docs/build-spec.md` and the scoreboard; do not
claim a backup that does not run.
