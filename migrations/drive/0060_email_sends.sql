-- The send ledger (drive issue #1206): the send function itself, not each
-- caller, keeps a mail that is due once per period from going out twice.
--
-- Until this, "already warned this month" lived in every sender that needed
-- it (core/cap.js read the account row's cap_warned_at stamp before mailing
-- the 80% warning), so a second caller could mail the same person twice in
-- one month and nothing outside that caller would notice. The ledger moves
-- the once-per-period decision into core/email-send.js's sendEmail(): before
-- a send that carries a ledger claims the period, it inserts here and sends
-- only when the insert added a row. The insert is the one statement
-- (https://sqlite.org/lang_upsert.html): ON CONFLICT DO NOTHING adds nothing
-- when this account and kind already claimed this period, and the affected-row
-- count is the whole decision.
--
--   account_id   the account the mail is about, the same id every other
--                drive table keys on. The ledger pins one account's own
--                rows to its id, so one account's sends can never release
--                or read another's.
--   kind         the email kind as core/emails.js registers it
--                ("cap-warning" today; more when a sender needs one).
--   period       the period the send is once per, as UTC "YYYY-MM" for a
--                month. A new month is a new row, so the next crossing is
--                mailed again with no caller-side clearing.
--   sent_at      unix seconds when the claim was written, for reading the
--                ledger; the claim itself is the row's existence.
--
-- A send that throws hands its claim back (core/email-send.js deletes the
-- row it just added), so a failed mail retries on the next trip instead of
-- being lost for the month -- the same rule the welcome row's
-- welcome_sent_at claim follows (src/welcome.js).
--
-- Purely additive, so a rollback of the code leaves the table in place and
-- the previous Worker version is untouched by it (drive's D1 rule: code
-- rolls back, data does not). One-way, like every file here: D1 has no
-- down-migrations.

create table "email_sends" (
  "account_id" text not null,
  "kind" text not null,
  "period" text not null,
  "sent_at" integer not null,
  primary key ("account_id", "kind", "period")
);
