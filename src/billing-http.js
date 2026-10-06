// Usage and quote HTTP plus the usage summary. Extracted from src/billing.js
// (drive issue #617) with no behaviour change; src/billing.js re-exports
// every name here.

import {
  BILLING_CONFIG,
  BYTES_PER_GB,
  capLine,
  capStatus,
  checked,
  checkedMonthMinutes,
  downloadCostUsd,
  formatUsd,
  GB_PER_TB,
  gbMonths,
  minutesInMonth,
  monthBillCents,
  quoteForStoredTb,
  refuseFoundingFields,
  savedLine,
  USAGE_HISTORY_DAYS,
} from "./billing.js";
import { failureMessage } from "./messages.js";
import { PRICE } from "./pricing.js";
import { formatBytes, unauthorizedResponse, uploadProgress } from "./status.js";

/**
 * Everything the usage page and `drive usage` show for one month, read from
 * the same numbers in one call so the page cannot show a bill the invoice
 * would not match, and neither surface has to work out money itself
 * (drive issues #7 and #53).
 *
 * The shape carries both the raw sizes the surfaces read (storedGb,
 * gbMonths, storedDaily) and the finished labels for every number, so the
 * static page renders strings instead of repeating the arithmetic. The
 * labels are the same strings `drive usage` prints.
 *
 * @param {unknown} usage
 * @param {BillingConfig} [config]
 */
export function usageSummary(usage, config = BILLING_CONFIG) {
  if (typeof usage !== "object" || usage === null) {
    throw new TypeError(`usageSummary needs a usage object, got ${String(usage)}`);
  }
  const fields =
    /** @type {{gbMinutes?: unknown, monthMinutes?: unknown, peakGb?: unknown, storedGb?: unknown, storedDaily?: unknown, downloadBytes?: unknown, averageStoredGb?: unknown, capUsd?: unknown, cardAdded?: unknown, cardOnFile?: unknown}} */ (
      usage
    );
  // The peak no longer sets any number on the bill (drive#463: the maximum
  // follows the month's average), so a caller still passing it is refused.
  if (fields.peakGb !== undefined) {
    throw new TypeError(
      "usage.peakGb is no longer part of the bill (drive#463): the maximum follows the month's average",
    );
  }
  refuseFoundingFields(usage, "usage");
  const gbMinutes = checked(fields.gbMinutes, "usage.gbMinutes");
  const monthMinutes = checkedMonthMinutes(fields.monthMinutes);
  const storedGb = checked(fields.storedGb, "usage.storedGb");
  const downloadBytes = checked(fields.downloadBytes, "usage.downloadBytes");
  const averageStoredGb = checked(fields.averageStoredGb, "usage.averageStoredGb");
  const capUsd = checked(fields.capUsd, "usage.capUsd");
  const series = storedSeries(fields.storedDaily);
  // The cap writes stop at is the account's own cap for a provisioned account
  // and the free $1 for a signed-out default (unchanged, `cardAdded`): the
  // usage endpoint passes true here as it always has, so the cap line a
  // card-less account is shown still matches the cap enforceCap() stops writes
  // at (src/index.js capStateFor).
  const effectiveCap = fields.cardAdded ? capUsd : Math.min(capUsd, config.freeMonthlyUsd);
  // drive#417: whether a real card is on file, the usage surfaces' own flag,
  // separate from the write-cap basis above. It defaults to the write-cap flag
  // so every caller that predates the accounts stamp keeps showing the bill it
  // always did; the endpoint passes the accounts row's own state, fail-closed,
  // so a card-less month says no charge has been made and shows no bill.
  const cardOnFile =
    fields.cardOnFile === undefined ? fields.cardAdded === true : fields.cardOnFile === true;
  const downloads = downloadCostUsd(downloadBytes, averageStoredGb, config);
  const months = gbMonths(gbMinutes, monthMinutes);
  // The one bill function (drive#463): storage up to the maximum, plus the
  // download line. The page's cost and the cap both read it, so neither can
  // work out a different number.
  const bill = monthBillCents({
    gbMinutes,
    monthMinutes,
    downloadBytes,
    averageStoredGb,
    config,
  });
  return Object.freeze({
    gbMonths: months,
    storedGb,
    storedDaily: series,
    meteredUsd: bill.meteredCents / 100,
    maximumUsd: bill.maximumCents / 100,
    billUsd: bill.totalCents / 100,
    // The one function's whole result, cents and invoice lines, so the page,
    // the CLI and the Dodo push read the same bytes.
    billCents: bill,
    saved: savedLine(bill, gbMinutes, monthMinutes),
    downloads: Object.freeze({
      freeBytes: downloads.freeBytes,
      usedBytes: downloadBytes,
      billableBytes: downloads.billableBytes,
      usd: downloads.usd,
    }),
    cap: capStatus(gbMinutes, monthMinutes, effectiveCap, config, {
      downloadBytes,
      averageStoredGb,
    }),
    // The finished strings the page sets and `drive usage` prints. One place
    // formats each number, so a change here moves both surfaces together.
    labels: Object.freeze({
      storedNow: formatBytes(storedGb * BYTES_PER_GB),
      gbMonths: months.toFixed(2),
      downloads: `${formatBytes(downloadBytes)} of ${formatBytes(downloads.freeBytes)} free`,
      // The bill number is unchanged (monthBillCents() still owns it); only the
      // word shown for a card-less month is the honest one (drive#417). The
      // page hides the bill lines on the same flag, so a card-less month shows
      // neither a $10 line nor a bill as if charged.
      cost: cardOnFile ? formatUsd(bill.totalCents / 100) : PRICE.noChargeYet,
      // Two caps, because they are two things: `cap` is the cap writes stop
      // at (a card-less account's is the free $1, not the account's own) and
      // `accountCap` is the account's own setting, which is what the page's
      // cap slider shows.
      cap: formatUsd(effectiveCap),
      accountCap: formatUsd(capUsd),
    }),
    // The page reads this to hide the bill lines for a card-less month, so the
    // two surfaces cannot show a charge one and not the other (drive#417).
    cardOnFile,
  });
}

/**
 * A real calendar day in YYYY-MM-DD form. The pattern alone would accept
 * 2026-09-40; the parse-and-round-trip rejects a day the meter's rollup could
 * not have produced, including a day a month does not have.
 * @param {unknown} value
 * @returns {value is string}
 */
function isDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * The last-30-days stored-GB series, validated and ordered oldest first. The
 * meter feeds it one row per day; a later day never before an earlier one, so
 * the line chart reads left to right whatever order the rollup returns.
 * @param {unknown} entries
 */
function storedSeries(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError(`usage.storedDaily must be an array of days, got ${String(entries)}`);
  }
  const rows = entries.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError(
        `usage.storedDaily[${index}] must be a {day, gb} day, got ${String(entry)}`,
      );
    }
    const day = /** @type {{day?: unknown, gb?: unknown}} */ (entry);
    if (!isDay(day.day)) {
      throw new TypeError(
        `usage.storedDaily[${index}].day must be a real YYYY-MM-DD date, got ${String(day.day)}`,
      );
    }
    return Object.freeze({ day: day.day, gb: checked(day.gb, `usage.storedDaily[${index}].gb`) });
  });
  rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return Object.freeze(rows.slice(-USAGE_HISTORY_DAYS));
}

const USAGE_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * Handles GET /api/usage, the usage page's and the CLI's read. It answers with
 * the month's summary, for the signed-in account and nobody else: the account
 * is a required argument and a request that cannot prove one is a 401 with the
 * message table's words, never another account's money (drive issue #73,
 * north star: Safe). The one gate is signedInAccount() in src/status.js, the
 * same one /api/first-run-status uses.
 *
 * Until the meter and the account store land (issues #6 and #2), a signed-in
 * account has no usage rows, so the true answer is the empty month: nothing
 * metered, nothing held, the cap the default. The shape is the one a metered
 * account gets from the real rollup, so the page and the CLI can be written
 * against it now. Any other method is a 405 with the one allowed method named,
 * like the other endpoints — after the gate, so an anonymous request is told
 * only that it is not signed in, never which methods exist.
 *
 * `uploadLine` rides on the answer beside `capLine` (drive issue #308): the
 * live upload-progress line the usage page shows, the same words `drive status`
 * and the first-run page print. It is assembled here by `uploadProgress()` from
 * `UPLOAD_LABEL` in src/status.js, the one word table and the one byte
 * formatter, so the page sets a finished string and carries no second copy of
 * either. It is null when there is no queue to report — the queue is rclone's,
 * on the Mac, and the Worker has no device store yet — and a payload that is
 * not a queue is refused rather than rendered, so the line can never be a
 * default the drive did not ask for.
 * @param {Request} request
 * @param {{id: string, name: string, capUsd?: number, cardOnFile?: boolean, usage?: Record<string, unknown>|null}|null} account the signed-in account, or null when signed out. `usage` is the
 *   month's own metered numbers, read by the route from the account store's
 *   `monthUsage` (drive#496); without it this answers the empty month.
 * @param {unknown} [upload] the live rclone upload queue, or null when there is none to report
 * @param {string|null} [balanceLine] the prepaid balance line (src/topup.js balanceLine, drive#586), or null when there is no balance store
 * @param {string} [monthIso] the month's own first instant as the Worker sends it ("2026-10-01T00:00:00.000Z"), from the one boundary the meter, the cap walk and the invoice read (src/index.js, src/meter.js monthStart). The caller owns the month so this module carries no second answer to what month the numbers belong to. It sits behind the two defaults above, so it is written `[monthIso]` and defaults to empty: a caller that leaves it out is refused below by name, the same as one that sends a day that is not an instant.
 */
export function handleUsageRequest(
  request,
  account,
  upload = null,
  balanceLine = null,
  monthIso = "",
) {
  // The gate is first, before the method: an anonymous request learns nothing
  // about whether it could write, only that it is not signed in.
  if (!account) {
    return unauthorizedResponse();
  }
  if (request.method !== "GET") {
    return new Response("Method not allowed. GET this endpoint for monthly usage.", {
      status: 405,
      headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const capUsd =
    typeof account.capUsd === "number" && Number.isFinite(account.capUsd)
      ? account.capUsd
      : BILLING_CONFIG.defaultCapUsd;
  // The month these numbers belong to, named (drive#559): the first instant of
  // the UTC month, sent by the caller (src/index.js) from the one boundary the
  // meter, the cap walk and the invoice read. A month that is not one is a
  // caller bug, so it fails the read rather than shipping a page with a
  // heading nobody can check a statement against.
  if (typeof monthIso !== "string" || Number.isNaN(new Date(monthIso).getTime())) {
    throw new TypeError(
      `handleUsageRequest needs the month's first instant, got ${String(monthIso)}`,
    );
  }
  // The month's own numbers, when the route read them (drive#496). The route
  // passes the account store's `monthUsage` result — `monthUsageThrough` behind
  // `usageSummary`'s shape, the same metered month the cap and the invoice
  // read — so /api/usage reports what the drive actually holds and has
  // downloaded rather than the empty month this used to build. Without it
  // (the unit tests that call the handler directly, and a deployment with no
  // DRIVE_DB) the empty month stands and the response is still well formed;
  // a real deployment always has the binding, and the route passes the read
  // whenever it can.
  const metered = account.usage;
  const empty =
    metered !== null && typeof metered === "object"
      ? usageSummary(
          /** @type {Parameters<typeof usageSummary>[0]} */ (
            /** @type {Record<string, unknown>} */ (metered)
          ),
        )
      : usageSummary({
          gbMinutes: 0,
          // The month this read falls in sets the divisor (drive#531).
          monthMinutes: minutesInMonth(Date.now()),
          storedGb: 0,
          storedDaily: [],
          downloadBytes: 0,
          averageStoredGb: 0,
          capUsd,
          // The write-cap basis is a provisioned account's own (unchanged): the cap
          // line this endpoint reports still matches the cap enforceCap() stops
          // writes at (src/index.js capStateFor). The card on file is the account's
          // own stamp, read from the accounts row (drive#417); until it is really on
          // file there is no charge to report, so the honest label is "no charge
          // yet" and the page shows no bill. It is absent (false) for a caller that
          // names no card, so the check fails closed.
          cardAdded: true,
          cardOnFile: account.cardOnFile === true,
        });
  // The cap line rides on the response rather than inside usageSummary(): the
  // summary is money (numbers only, which is what the usage page's chart and
  // the invoice read), and building the line here is what lets the Go CLI print
  // the Worker's words instead of carrying its own copy of them.
  //
  // The upload line rides beside it for the same reason (drive issue #308): the
  // page renders a string the Worker assembled from the one word table, so no
  // surface ships a second spelling of "Uploading 3 files" or a second byte
  // formatter. A queue is checked on the way in by uploadProgress(), which
  // throws on a value that is not a queue, so a broken report fails the read
  // rather than printing a plausible line about bytes nobody counted.
  const uploadLine = upload === null ? null : uploadProgress(upload).label;
  // The month rides on the answer finished: the instant, not a name, because
  // the page writes the month's name in the browser's own words and a date
  // rendered on the server is a UTC date (drive#559).
  const body = { ...empty, monthIso, capLine: capLine(empty.cap), uploadLine, balanceLine };
  return new Response(JSON.stringify(body), { status: 200, headers: USAGE_HEADERS });
}

const QUOTE_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

function quoteSizeError() {
  return new Response(JSON.stringify({ error: failureMessage("quote-size") }), {
    status: 400,
    headers: QUOTE_HEADERS,
  });
}

/**
 * Handles GET /api/quote, the public savings calculator (drive issue #14).
 * `tb` is a size in TB held all month; `gb` is the same size in GB. Exactly
 * one of the two. The numbers are quoteForStoredTb(), which is monthBillCents
 * plus the maximum, so a later price edit moves the calculator with the
 * invoice. Any other method is 405. A size the quote cannot use is 400 with
 * the message table's quote-size words, never a stack.
 * @param {Request} request
 */
export function handleQuoteRequest(request) {
  if (request.method !== "GET") {
    return new Response("Method not allowed. GET this endpoint with tb or gb.", {
      status: 405,
      headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const url = new URL(request.url);
  const tbRaw = url.searchParams.get("tb");
  const gbRaw = url.searchParams.get("gb");
  let raw = null;
  if (tbRaw !== null && gbRaw === null) {
    raw = tbRaw;
  } else if (gbRaw !== null && tbRaw === null) {
    raw = gbRaw;
  }
  if (raw === null || raw.trim() === "") {
    return quoteSizeError();
  }
  const parsed = Number(raw);
  const tb = tbRaw !== null ? parsed : parsed / GB_PER_TB;
  try {
    const quote = quoteForStoredTb(tb);
    return new Response(JSON.stringify(quote), { status: 200, headers: QUOTE_HEADERS });
  } catch (err) {
    if (err instanceof TypeError) {
      return quoteSizeError();
    }
    throw err;
  }
}
