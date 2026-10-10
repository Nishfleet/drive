-- The account-wide sign-in send counter (drive#878): how many sign-in links
-- the whole account has started inside the current one-minute window.
--
-- The edge limits (drive issue #147) bound POST /api/signin per client IP and,
-- with the constant-key binding, per Cloudflare location — a rate-limit key is
-- counted separately in each location, so a walk spread over N locations could
-- start the location ceiling N times a minute and no binding would see the
-- sum. This table is the shared counter the bindings cannot be: the customer
-- database is one database, so the row below is the same row for every
-- request no matter which location served it, and one guarded upsert in
-- src/signin-send-limit.js (signinAccountSendOutcome) is the whole decision —
-- the same shape the per-address counters use
-- (migrations/drive/0026_signin_address_sends.sql), one window instead of two.
--
-- One row, ever. The key is the constant "account": every sender shares it,
-- which is the point. The window start is the instant of the first send
-- inside the window and expires a full minute later, a fixed window like the
-- bindings'. No cleanup job: the table holds one row whatever the traffic
-- does, and a send after the window resets it in place.
--
-- Purely additive, so a rollback of the code leaves the table in place and
-- the previous Worker version is untouched by it (drive's D1 rule: code rolls
-- back, data does not). One-way, like every file here: D1 has no
-- down-migrations.
create table "signin_account_sends" (
  "counter" text not null primary key,
  "window_start" integer not null,
  "count" integer not null
);
