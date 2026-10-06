-- Per-address sign-in mail counters (drive#550): how many sign-in links one
-- inbox has been sent inside the current hour and the current day.
--
-- The edge limits (drive issue #147) bound how much mail one caller IP can
-- ask for, so a script spread across many IPs walks right past them and lands
-- every link in one customer's inbox. Cloudflare's rate-limit binding only
-- offers 10- and 60-second windows, so an hour and a day cannot be expressed
-- as bindings; the count lives here instead, on the customer database the
-- sign-in route already reads, and one guarded upsert in
-- src/signin-send-limit.js is the whole decision.
--
-- One row per address ever sent to, keyed by the lowercased address so
-- Alice@, alice@ and ALICE@ share one ceiling (the same key the account row
-- is looked up by, the lower(email) query in emailHasUser). A window's start
-- is the instant of the first send inside it, and the window expires a full
-- hour (or day) later, so the counters are fixed windows rather than a
-- rolling count. No cleanup job: the row is one small record per address, and
-- a later send reuses it by resetting the expired window in place.
--
-- Purely additive, so a rollback of the code leaves the table in place and
-- the previous Worker version is untouched by it (drive's D1 rule: code rolls
-- back, data does not). One-way, like every file here: D1 has no
-- down-migrations.
create table "signin_address_sends" (
  "address" text not null primary key,
  "hour_window_start" integer not null,
  "hour_count" integer not null,
  "day_window_start" integer not null,
  "day_count" integer not null
);
