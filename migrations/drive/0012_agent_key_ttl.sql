-- The hour an agent's storage credential lives (drive issue #106).
--
-- Space swaps a key for a one-hour scoped credential. Ours lived until the
-- person revoked it, so a leaked agent key was a key that worked forever. This
-- column is the api Worker's own half of the bound: the row's credential is
-- refused at `expires_at` and renewed only while the row is live
-- (workers/api/src/keystore.js `renewKeyWindow`, devices.js `authenticate`).
--
-- Expand only. The column is nullable with no default and no NOT NULL, so the
-- code that was running before this migration reads the same schema and the
-- same rows: an existing row is NULL, which means "this key never expires",
-- and every read treats NULL that way (devices.js `deviceFromRow`). Nothing is
-- dropped, renamed or backfilled here — a rollback that rolled back data would
-- have no down-migration to run, so there is nothing to roll back.

ALTER TABLE devices ADD COLUMN expires_at INTEGER;
