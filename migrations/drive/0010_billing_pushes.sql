-- Step 6 remainder (drive issue #51): the Dodo hourly push's own tables from
-- docs/build-spec.md "Data model (D1)". Additive only: two new tables, no
-- existing table touched, no column dropped or renamed, so a rollback is
-- rolling the code back. D1 has no down-migrations, so this file is one-way.
--
-- Numbered 0010 and filed under drive/ because billing_pushes and the
-- accounts row the push reads (dodo_customer_id) are customer data, the same
-- drive database usage_minutes already lives in (METER_DB / DRIVE_DB).
--
-- accounts is the spec's own table (id, email, created_at, dodo_customer_id,
-- card_added_at, cap_cents, state). It lands here because the push cannot
-- invent a Dodo customer: an account with no dodo_customer_id is skipped,
-- never created. Checkout (a later slice) is what fills the id. Better Auth's
-- `account` table is OAuth links and is not this table.
--
-- billing_pushes is keyed on (account_id, hour) so a retried push of the same
-- hour is ignored. dodo_event_id is unique so Dodo's own idempotency key and
-- this row stay 1:1. amount_units is the delta of monthBillCents().totalCents
-- for that hour, integer cents, so Dodo is never handed a fractional cent.
-- Timestamps are epoch milliseconds, matching usage_minutes.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dodo_customer_id TEXT,
  card_added_at INTEGER,
  cap_cents INTEGER NOT NULL DEFAULT 1200,
  state TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS accounts_dodo_customer_id_idx
  ON accounts (dodo_customer_id);

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
