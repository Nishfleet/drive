-- Step 6 remainder (drive issue #51): the Dodo hourly push's own table from
-- docs/build-spec.md "Data model (D1)". Additive only: one new table, no
-- existing table touched, no column dropped or renamed, so a rollback is
-- rolling the code back. D1 has no down-migrations, so this file is one-way.
--
-- Numbered 0013 and filed under drive/ because billing_pushes is customer
-- data, the same drive database usage_minutes already lives in (METER_DB /
-- DRIVE_DB). 0011 is rate_limit on origin/main and 0012 is branch snapshots,
-- so this takes the next free number; the deploy sorts on the numeric prefix
-- alone, and two files sharing one would race for the apply order.
--
-- The push reads accounts.dodo_customer_id, but `accounts` is NOT created
-- here: 0010_accounts_devices.sql already owns it (id, email, created_at,
-- dodo_customer_id, card_added_at, cap_cents, state) and every NOT NULL
-- column there carries a DEFAULT. A second `CREATE TABLE IF NOT EXISTS
-- accounts` would be dead when that file ran first and would silently win —
-- dropping the state CHECK and pinning cap_cents to 1200 — when this file ran
-- first, because both files share the numeric prefix and the deploy sorts on
-- it alone. The table is left to its owner. The push skips an account with no
-- dodo_customer_id; it never creates one.
--
-- billing_pushes is keyed on (account_id, hour) so a retried push of the same
-- hour is ignored. dodo_event_id is unique so Dodo's own idempotency key and
-- this row stay 1:1. amount_units is the delta of monthBillCents().totalCents
-- for that hour, integer cents, so Dodo is never handed a fractional cent.
-- Timestamps are epoch milliseconds, matching usage_minutes.

CREATE TABLE IF NOT EXISTS billing_pushes (
  account_id TEXT NOT NULL,
  -- Epoch milliseconds of the start of the UTC hour this row covers.
  hour INTEGER NOT NULL,
  dodo_event_id TEXT NOT NULL,
  -- Integer cents pushed this hour: the delta of the month's capped bill.
  amount_units INTEGER NOT NULL,
  pushed_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, hour)
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_pushes_dodo_event_id_idx
  ON billing_pushes (dodo_event_id);

CREATE INDEX IF NOT EXISTS billing_pushes_hour_idx ON billing_pushes (hour);
