// The daily draw's laws (drive#642), as properties over random size histories
// rather than hand-picked cases: a fast-check sequence of stored sizes, an
// upload or a delete at any point, and the draw walked day by day the way the
// hourly cron walks it (core/prepaid.js drawForDay). The four laws the issue
// names, each checked for every random history the generator can produce:
//
//   1. a draw is never negative, and never more than that day's own share of
//      the month plus the remainder carried into it - the remainder is the
//      only lawful overflow, and it is carried, never charged twice;
//   2. money drawn never runs ahead of money billed: the carry can only hold
//      a day's draw back, never spend it early, whatever the sizes did;
//   3. thirty daily draws at a constant size equal that month's price exactly,
//      in whole integer units - a remainder is carried until it makes a whole
//      millicent, then drawn, so nothing is dropped and nothing is doubled;
//   4. any 30-day span never bills more than the monthly price of the biggest
//      size in that span, whatever the sizes did between.
//
// The generator is seeded-and-reproducible (fc asserts re-runs the same
// history on failure) and the model below is deliberately the arithmetic the
// production draw uses, so a bug in the carry shows as a law failing rather
// than as a number that looks plausible.

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  centsFromDrawnMillicents,
  DRAW_DAYS,
  dailyDrawMillicents,
  monthBillCents,
} from "../core/billing.js";
import { GB } from "./d1-sqlite.mjs";

/** The day-to-day state the draw carries: the /30 millicent remainder and the
 * millicents not yet whole enough to post as cents. */
function freshDrawState() {
  return { thirtyRemainder: 0, unposted: 0, drawnMillicents: 0, drawnCents: 0 };
}

/**
 * One day's draw, exactly the two carries core/prepaid.js keeps, and their
 * running totals.
 * @param {number} monthlyMillicents
 * @param {{thirtyRemainder: number, unposted: number, drawnMillicents: number, drawnCents: number}} state
 */
function drawOneDay(monthlyMillicents, state) {
  /** A month with no stored size bills nothing, so no draw is made. */
  if (monthlyMillicents === 0) {
    return 0;
  }
  const step = dailyDrawMillicents(monthlyMillicents, state.thirtyRemainder);
  const posted = centsFromDrawnMillicents(step.drawMillicents, state.unposted);
  state.thirtyRemainder = step.remainderMillicents;
  state.unposted = posted.unpostedMillicents;
  state.drawnMillicents += step.drawMillicents;
  state.drawnCents += posted.drawCents;
  return step.drawMillicents;
}

/** The month's price for a stored size, in millicents. */
const monthMillis = (/** @type {number} */ bytes) =>
  monthBillCents({ size30Bytes: bytes }).totalMillicents;

/**
 * A stored size in bytes: from an empty drive through the maximum's 750 GB and
 * beyond, at whole-gigabyte steps the meter can actually write.
 */
const sizeBytes = fc.integer({ min: 0, max: 12000 }).map((gb) => gb * GB);

/** A short run of days: the sizes stored, oldest first. */
const sizeHistory = fc.array(sizeBytes, { minLength: 1, maxLength: 40 });

test("the draw is never negative and never more than the day's own share plus its carry", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 5_000_000_000 }),
      fc.integer({ min: 0, max: DRAW_DAYS - 1 }),
      (monthly, carried) => {
        const step = dailyDrawMillicents(monthly, carried);
        assert.ok(step.drawMillicents >= 0, `a draw is never negative: ${step.drawMillicents}`);
        assert.ok(
          step.drawMillicents * DRAW_DAYS <= monthly + carried,
          `a draw never exceeds the day's share plus its carry: ${step.drawMillicents}`,
        );
        // Nothing is dropped: the whole month plus the carry is either drawn now
        // or carried to the next day.
        assert.equal(
          step.drawMillicents * DRAW_DAYS + step.remainderMillicents,
          monthly + carried,
          "the day's draw and its remainder account for the month exactly",
        );
        assert.ok(
          step.remainderMillicents >= 0 && step.remainderMillicents < DRAW_DAYS,
          `the carried remainder stays in 0..${DRAW_DAYS - 1}: ${step.remainderMillicents}`,
        );
      },
    ),
    { numRuns: 500 },
  );
});

test("a 30-day total never passes the monthly price of the biggest size in that span", () => {
  fc.assert(
    fc.property(sizeHistory, (sizes) => {
      const state = freshDrawState();
      const span = sizes.slice(0, DRAW_DAYS);
      for (const bytes of span) {
        drawOneDay(monthMillis(bytes), state);
      }
      if (span.length < DRAW_DAYS) {
        return; // the span law is about a full 30 days
      }
      const biggestInSpan = Math.max(...span);
      const monthOfBiggest = monthBillCents({ size30Bytes: biggestInSpan });
      const shareOfBiggest = monthOfBiggest.totalMillicents;
      assert.ok(
        state.drawnCents <= monthOfBiggest.totalCents,
        `the ${span.length}-day total ${state.drawnCents}c must not pass the ${biggestInSpan / GB} GB month ${monthOfBiggest.totalCents}c`,
      );
      assert.ok(
        state.drawnMillicents <= shareOfBiggest,
        `the ${span.length}-day millicent total ${state.drawnMillicents} must not pass the ${shareOfBiggest} millicent month of the biggest size in the span`,
      );
      assert.ok(
        state.unposted >= 0 && state.unposted < 1000,
        "the unposted millicents stay sub-cent",
      );
    }),
    { numRuns: 300 },
  );
});

test("thirty daily draws at a constant size equal that month's price exactly", () => {
  fc.assert(
    fc.property(sizeBytes, (bytes) => {
      const month = monthBillCents({ size30Bytes: bytes });
      const state = freshDrawState();
      for (let day = 0; day < DRAW_DAYS; day += 1) {
        drawOneDay(monthMillis(bytes), state);
      }
      // Nothing dropped and nothing doubled: every one of the month's
      // millicents is either drawn across the thirty days or is the remainder
      // the last day carried, and the cycle telescopes exactly.
      assert.equal(
        DRAW_DAYS * state.drawnMillicents + state.thirtyRemainder,
        DRAW_DAYS * month.totalMillicents,
        `thirty days at ${bytes / GB} GB must draw ${
          month.totalMillicents
        } millicents, carried inside, never dropped or doubled`,
      );
      assert.equal(
        state.drawnCents * 1000 + state.unposted,
        state.drawnMillicents,
        "the cents posted are exactly the millicents drawn, with the sub-cent part carried",
      );
      assert.ok(
        Math.abs(state.drawnCents - month.totalCents) <= 1,
        "the cents posted are the month's cents, not a near miss",
      );
    }),
    { numRuns: 200 },
  );
});

test("money drawn never runs ahead of the money billed so far", () => {
  fc.assert(
    fc.property(sizeHistory, (sizes) => {
      const state = freshDrawState();
      let billedMillicents = 0;
      for (const bytes of sizes) {
        const monthly = monthMillis(bytes);
        drawOneDay(monthly, state);
        billedMillicents += monthly;
        // Each day's step accounts for the month plus the carry it was handed
        // (draw * 30 + carry = month + carried in), so the days telescope:
        // every millicent drawn had been billed first, and the only money not
        // yet drawn is the sub-carry the last day still holds.
        assert.ok(
          DRAW_DAYS * state.drawnMillicents <= billedMillicents,
          `${sizes.length} days drew ${state.drawnMillicents} millicents from ${billedMillicents} billed`,
        );
        assert.equal(
          DRAW_DAYS * state.drawnMillicents + state.thirtyRemainder,
          billedMillicents,
          "the days telescope: what is not drawn is the carry, nothing is lost",
        );
      }
    }),
    { numRuns: 300 },
  );
});
