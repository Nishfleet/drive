// The sign-in send counters the edge bindings cannot be (drive#550, drive#878).
//
// The edge limits (drive issue #147) bound how much mail one caller IP can
// ask for; a script spread across many IPs walks right past them and lands
// every link in one customer's inbox. The first guard here is keyed on the
// address instead: 5 links an hour and 20 a day, so no caller can push more
// than that into one mailbox however many IPs the asks come from.
//
// The second guard is keyed on nothing at all: the account-wide bound
// (drive#878). Cloudflare counts a rate-limit key separately in each Cloudflare
// location, so the constant-key binding bounds one location and a walk spread
// over many locations multiplies it. This guard's row lives on the customer
// database — one database, so one row for every location — and the account's
// total of sign-in starts is bounded by it however the requests arrive. One
// honest limit: a window's edges are whichever location's clock ran the send,
// so the account figure is 5000 per (60 seconds minus the locations' clock
// skew) — the same clock trust the address guard's windows run on, at
// account scale.
//
// Cloudflare's rate-limit binding only offers 10- and 60-second windows, so
// an hour and a day cannot be expressed there. The count lives on the
// customer database the route already reads
// (migrations/drive/0026_signin_address_sends.sql), and one guarded upsert is
// the whole decision: the statement spends the address's slot only when both
// windows have room, and the write's change count answers whether it spent
// one. One statement is the point — two requests for the same address in the
// same instant are serialized by the database write itself, so the ceiling
// cannot be outrun by a burst the way a read-then-write pair can.

import { DAY_MS } from "../core/units.js";

/** Links one address may be sent inside one hour window. */
export const SIGNIN_SEND_HOURLY_MAX = 5;

/** Links one address may be sent inside one day window. */
export const SIGNIN_SEND_DAILY_MAX = 20;

/** One hour, in seconds — the window the hourly ceiling lives in. */
export const SIGNIN_SEND_HOUR_SECONDS = 60 * 60;

/** One day, in seconds — the window the daily ceiling lives in. */
export const SIGNIN_SEND_DAY_SECONDS = DAY_MS / 1000;

/**
 * Sign-in starts the whole account may make inside one account-wide window
 * (drive#878). The figure is SIGNIN_GLOBAL_RATE_LIMITER's own 5000/min on
 * purpose (cloudflare.config.ts): inside any one location the binding refuses
 * first, so the counter only records what a location's own ceilings let
 * through, and across every location the account's total is now 5000 a minute
 * rather than 5000 times the number of locations. That is 25x the measured
 * worst realistic case (200/min, the campus NAT the tuning pass measured) and
 * 10x the per-IP ceiling, so real shared offices never meet it.
 */
export const SIGNIN_ACCOUNT_SEND_MAX = 5000;

/** One minute, in seconds — the window the account-wide ceiling lives in. */
export const SIGNIN_ACCOUNT_SEND_WINDOW_SECONDS = 60;

/**
 * The one row's key. A constant, which is the whole mechanism: the address
 * guard has a row per inbox, and this guard has one row that every Cloudflare
 * location shares, because the customer database is one database.
 */
const ACCOUNT_COUNTER_KEY = "account";

/**
 * The one guarded upsert. ?1 the address, ?2 the send's second, ?3 the
 * send's second again (each window's own start when it resets), ?4 the hour
 * cutoff, ?5 the day cutoff, ?6 the hourly max, ?7 the daily max.
 *
 * The WHERE is the ceiling: an update happens only when the hour window has
 * room — expired (its start a full window before this send) or under its
 * max — and the day window has room too, so one send needs space in both.
 * When the guard holds the write back, D1 answers a change count of 0 and
 * nothing was spent. The cutoff comparison is `<=` because the window starts
 * at its own start: a send one window after it belongs to the next window, and
 * a send one second before it does not.
 */
const SPEND_SQL = `insert into "signin_address_sends"
  ("address", "hour_window_start", "hour_count", "day_window_start", "day_count")
values (?1, ?2, 1, ?3, 1)
on conflict("address") do update set
  "hour_window_start" = case
    when "signin_address_sends"."hour_window_start" <= ?4 then ?2
    else "signin_address_sends"."hour_window_start" end,
  "hour_count" = case
    when "signin_address_sends"."hour_window_start" <= ?4 then 1
    else "signin_address_sends"."hour_count" + 1 end,
  "day_window_start" = case
    when "signin_address_sends"."day_window_start" <= ?5 then ?3
    else "signin_address_sends"."day_window_start" end,
  "day_count" = case
    when "signin_address_sends"."day_window_start" <= ?5 then 1
    else "signin_address_sends"."day_count" + 1 end
where ("signin_address_sends"."hour_window_start" <= ?4
         or "signin_address_sends"."hour_count" < ?6)
  and ("signin_address_sends"."day_window_start" <= ?5
         or "signin_address_sends"."day_count" < ?7)`;

/**
 * What the address guard said about one send. `allowed` is a slot spent —
 * the send may go out. `refused` is the address over one of its two
 * ceilings, nothing spent and no mail answered for. `broken` is the counter
 * itself failing — a database that threw is a deployment problem, not a
 * caller over a ceiling, and the route answers those two differently on
 * purpose (the same split the edge limits draw in src/rate-limit.js).
 * @typedef {"allowed"|"refused"|"broken"} SigninSendOutcome
 */

/**
 * The account-wide guard's one guarded upsert (drive#878). ?1 the constant
 * key, ?2 the send's second, ?3 the window cutoff (the send's second minus a
 * full window), ?4 the account max.
 *
 * The WHERE is the ceiling, the same move SPEND_SQL makes: an update happens
 * only when the window has room — expired (its start a full window before
 * this send) or under its max — and when the guard holds the write back, D1
 * answers a change count of 0 and nothing was spent. The cutoff comparison is
 * `<=` because the window starts at its own start: a send one window after it
 * belongs to the next window, and a send one second before it does not.
 */
const ACCOUNT_SPEND_SQL = `insert into "signin_account_sends"
  ("counter", "window_start", "count")
values (?1, ?2, 1)
on conflict("counter") do update set
  "window_start" = case
    when "signin_account_sends"."window_start" <= ?3 then ?2
    else "signin_account_sends"."window_start" end,
  "count" = case
    when "signin_account_sends"."window_start" <= ?3 then 1
    else "signin_account_sends"."count" + 1 end
where "signin_account_sends"."window_start" <= ?3
   or "signin_account_sends"."count" < ?4`;

/**
 * Spends one of the address's send slots and answers whether the send may go
 * out. The caller passes the lowercased address, the key the account row is
 * looked up by, so Alice@, alice@ and ALICE@ share one ceiling.
 *
 * A send the guard allows still costs a slot even when the mail later fails
 * (a mailer that threw, a missing email setting): the slot counts asks that
 * reached the send step, not links that landed, so a broken mailer cannot
 * turn an address's ceiling into an unbounded retry budget.
 *
 * @param {D1Database} db the customer database
 * @param {string} address the lowercased address
 * @param {number} [now] seconds since the epoch; a test's clock, or the
 *   current time
 * @returns {Promise<SigninSendOutcome>}
 */
export async function signinSendOutcome(db, address, now = Math.floor(Date.now() / 1000)) {
  let meta;
  try {
    ({ meta } = await db
      .prepare(SPEND_SQL)
      .bind(
        address,
        now,
        now,
        now - SIGNIN_SEND_HOUR_SECONDS,
        now - SIGNIN_SEND_DAY_SECONDS,
        SIGNIN_SEND_HOURLY_MAX,
        SIGNIN_SEND_DAILY_MAX,
      )
      .run());
  } catch (error) {
    // The reason travels to the log only: a public answer naming the
    // counter's failure would hand a stranger a map of what is broken.
    console.error("signin-send-limit: the address send counter write failed", error);
    return "broken";
  }
  return meta.changes >= 1 ? "allowed" : "refused";
}

/**
 * Spends one of the account's send slots and answers whether the send may go
 * out (drive#878). No address argument, on purpose: the row is the same for
 * every caller, so a walk that mints a fresh address per request and a
 * different IP per request still draws from the one counter — the bound the
 * per-location binding cannot be, because Cloudflare counts its keys in each
 * location separately.
 *
 * The same spending rule as the address guard: a slot counts an ask that
 * reached the send step, not a link that landed, so a broken mailer cannot
 * turn the ceiling into an unbounded retry budget. The route runs this guard
 * after the address one and before the send, so an ask the address guard
 * refused never moves the account's counter, and an ask the account guard
 * refuses has already spent its address's slot — it did reach for a send.
 *
 * @param {D1Database} db the customer database
 * @param {number} [now] seconds since the epoch; a test's clock, or the
 *   current time
 * @returns {Promise<SigninSendOutcome>}
 */
export async function signinAccountSendOutcome(db, now = Math.floor(Date.now() / 1000)) {
  let meta;
  try {
    ({ meta } = await db
      .prepare(ACCOUNT_SPEND_SQL)
      .bind(
        ACCOUNT_COUNTER_KEY,
        now,
        now - SIGNIN_ACCOUNT_SEND_WINDOW_SECONDS,
        SIGNIN_ACCOUNT_SEND_MAX,
      )
      .run());
  } catch (error) {
    // The reason travels to the log only: a public answer naming the
    // counter's failure would hand a stranger a map of what is broken.
    console.error("signin-send-limit: the account send counter write failed", error);
    return "broken";
  }
  return meta.changes >= 1 ? "allowed" : "refused";
}

/**
 * How long a row is kept after its day window ends (drive#725). A row whose
 * day window ended is already a reset waiting to happen: the next send for
 * that address rewrites both windows in place, so deleting the row changes no
 * answer the guard gives. The extra day is the issue's own rule ("ended more
 * than 24 hours ago"), so a row is deleted once its day window started more
 * than 48 hours ago.
 */
export const SIGNIN_SEND_ROW_GRACE_SECONDS = SIGNIN_SEND_DAY_SECONDS;

/**
 * The nightly sweep of the counter table (drive#725). The sign-in route is
 * public, so without it the table would keep every address anybody ever typed,
 * account or not. It deletes each row whose day window ended more than 24
 * hours ago, and nothing else: one DELETE on `signin_address_sends`, no other
 * table, no account, no file.
 *
 * A failed delete throws, so the nightly trigger is recorded as failed and the
 * next night tries again; the guard keeps working on the rows either way.
 *
 * @param {D1Database} db the customer database
 * @param {number} nowMs the trip's clock, epoch milliseconds
 * @returns {Promise<{purged: number, cutoff: number}>} rows deleted, and the
 *   day-window start (epoch seconds) a row had to be older than
 */
export async function purgeExpiredSigninSends(db, nowMs) {
  const cutoff = Math.floor(nowMs / 1000) - SIGNIN_SEND_DAY_SECONDS - SIGNIN_SEND_ROW_GRACE_SECONDS;
  const result = await db
    .prepare('delete from "signin_address_sends" where "day_window_start" < ?1')
    .bind(cutoff)
    .run();
  return { purged: Number(result?.meta?.changes ?? 0), cutoff };
}
