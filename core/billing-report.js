/** @typedef {import("./billing.js").BillingConfig} BillingConfig */
import {
  BILLING_CONFIG,
  BYTES_PER_TB,
  billingConfig,
  checked,
  checkedBytes,
  dailyDrawMillicents,
  downloadCostUsd,
  formatUsd,
  GB_PER_TB,
  jsonBytes,
  MILLICENTS_PER_CENT,
  monthBillCents,
  payAfterFeeCents,
  quoteForStoredTb,
  refuseFoundingFields,
  SAVED_COPY,
  savingAllowed,
  storageConfig,
  USAGE_HISTORY_DAYS,
  wholeBytes,
} from "./billing.js";
import { failureMessage } from "./messages.js";
import { PRICE, STORAGE, storageCostCentsPerTbMonth, usualPlanMonthlyUsd } from "./pricing.js";
import { formatBytes, unauthorizedResponse, uploadProgress } from "./status.js";
import { BYTES_PER_GB } from "./units.js";

/**
 * The break-even size in bytes: what the account paid after the fee, divided
 * by our cost per byte. The division rounds up (ceil), so the customer gets
 * at most one extra byte of room — less than 1 MB — never a byte less.
 * @param {number} payAfterFee
 * @param {number} costCentsPerTb
 */
function breakEvenBytes(payAfterFee, costCentsPerTb) {
  if (costCentsPerTb <= 0 || !Number.isInteger(costCentsPerTb)) {
    throw new TypeError(
      `cost per TB must be a whole number of cents above 0, got ${String(costCentsPerTb)}`,
    );
  }
  const num = BigInt(payAfterFee) * BigInt(BYTES_PER_TB);
  const den = BigInt(costCentsPerTb);
  const limit = (num + den - 1n) / den;
  if (limit > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(
      `break-even bytes ${String(limit)} is past the safe integer range; the pause cannot guess a smaller limit`,
    );
  }
  return Number(limit);
}

/**
 * The fair-use upload limit in bytes for a size30 (drive#364): the larger of
 * the break-even size and (floorMultiple x size30). Built from monthBillCents()
 * — the one bill function — and the storage-provider config. No ratio or
 * percent literal lives here.
 * @param {{size30Bytes: unknown, config?: BillingConfig, storage?: typeof STORAGE}} input
 */
export function fairUseLimitBytes(input) {
  if (typeof input !== "object" || input === null) {
    throw new TypeError(`fairUseLimitBytes needs {size30Bytes}, got ${String(input)}`);
  }
  const size30Bytes = wholeBytes(input.size30Bytes, "size30Bytes");
  const storage = storageConfig(input.storage ?? STORAGE);
  if (storage.minimumStayDays === 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  const config = billingConfig(input.config ?? BILLING_CONFIG);
  const payCents = monthBillCents({
    size30Bytes,
    config,
  }).storageCents;
  const afterFee = payAfterFeeCents(payCents);
  const cost = storageCostCentsPerTbMonth(storage);
  const breakEven = breakEvenBytes(afterFee, cost);
  const floor = storage.fairUseFloorMultiple * size30Bytes;
  return Math.max(breakEven, floor);
}

/**
 * The three facts the refusal, the usage page and `drive status` all print,
 * from one check, so they cannot disagree (drive#364).
 * @param {{
 *   remainingBytes: number,
 *   allowed: boolean,
 *   opensAt: number,
 *   now?: number,
 * }} status
 */
export function fairUseLine(status) {
  if (typeof status !== "object" || status === null) {
    throw new TypeError(`fairUseLine needs a fairUseCheck result, got ${String(status)}`);
  }
  const remaining = wholeBytes(status.remainingBytes, "remainingBytes");
  const opensAt = wholeBytes(status.opensAt, "opensAt");
  const now = status.now === undefined ? opensAt : wholeBytes(status.now, "now");
  const room =
    remaining === 0 ? "No upload room left" : `${formatBytes(remaining)} of upload room left`;
  const date = fairUseDay(opensAt);
  const why = status.allowed
    ? "Young deletes still count toward the pause until they age out."
    : `Uploads pause because young deletes still count until ${date}.`;
  const opens =
    remaining === 0 && status.allowed
      ? "Another upload will not fit."
      : status.allowed && opensAt <= now
        ? "Uploads are open."
        : `Uploads open again on ${date}.`;
  return Object.freeze({
    remaining: `${room}.`,
    why,
    opens,
    copy: `${room}. ${why} ${opens}`,
  });
}

/**
 * @param {number} ms
 */
function fairUseDay(ms) {
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Whether this upload may go up (drive#364). The check is:
 *
 *   live + ghost + this upload  <=  limit(max(size30, live + this upload))
 *
 * Whole bytes only. Missing data is the caller's to fail open: this function
 * throws rather than guessing a size.
 *
 * @param {{
 *   liveBytes: unknown,
 *   ghostBytes: unknown,
 *   uploadBytes: unknown,
 *   size30Bytes: unknown,
 *   now: unknown,
 *   oldestGhostCreatedAt?: unknown,
 *   config?: BillingConfig,
 *   storage?: typeof STORAGE,
 * }} input
 */
export function fairUseCheck(input) {
  if (typeof input !== "object" || input === null) {
    throw new TypeError(`fairUseCheck needs a snapshot, got ${String(input)}`);
  }
  const liveBytes = wholeBytes(input.liveBytes, "liveBytes");
  const ghostBytes = wholeBytes(input.ghostBytes, "ghostBytes");
  const uploadBytes = wholeBytes(input.uploadBytes, "uploadBytes");
  const size30Bytes = wholeBytes(input.size30Bytes, "size30Bytes");
  const now = wholeBytes(input.now, "now");
  const storage = storageConfig(input.storage ?? STORAGE);
  const stayMs = storage.minimumStayDays * 24 * 60 * 60 * 1000;
  if (stayMs === 0) {
    const line = fairUseLine({
      remainingBytes: Number.MAX_SAFE_INTEGER,
      allowed: true,
      opensAt: now,
      now,
    });
    return Object.freeze({
      allowed: true,
      wouldRefuse: false,
      usedBytes: liveBytes + uploadBytes,
      limitBytes: Number.MAX_SAFE_INTEGER,
      remainingBytes: Number.MAX_SAFE_INTEGER,
      opensAt: now,
      line,
    });
  }
  const effectiveSize30 = Math.max(size30Bytes, liveBytes + uploadBytes);
  const limitBytes = fairUseLimitBytes({
    size30Bytes: effectiveSize30,
    config: input.config,
    storage,
  });
  const usedBytes = liveBytes + ghostBytes + uploadBytes;
  const allowed = usedBytes <= limitBytes;
  const remainingBytes = Math.max(0, limitBytes - usedBytes);
  let opensAt = now;
  if (!allowed) {
    const oldest =
      input.oldestGhostCreatedAt === undefined || input.oldestGhostCreatedAt === null
        ? now
        : wholeBytes(input.oldestGhostCreatedAt, "oldestGhostCreatedAt");
    opensAt = oldest + stayMs;
  }
  const line = fairUseLine({ remainingBytes, allowed, opensAt, now });
  return Object.freeze({
    allowed,
    wouldRefuse: !allowed,
    usedBytes,
    limitBytes,
    remainingBytes,
    opensAt,
    line,
  });
}

/**
 * The "you saved $X" line (drive#463), from a monthBillCents() result:
 *   - against our maximum: a capped month (metered over the maximum) saved
 *     metered - storage, copy "Our maximum saved you $X."; otherwise the
 *     storage bill sits under the maximum by maximum - storage, copy "You
 *     saved $X against our maximum.";
 *   - against the usual 1 TB plan for the same average size, when that plan
 *     costs more: "You saved $X against a usual 1 TB plan."
 * Both sentences ride in `copy`, one after the other. `null` means "no line to
 * show": an empty month (a $0 bill is not a saving against anything), no
 * saving at all, or a size30 of 1 TB and above, where drive#642 turned the
 * comparison against a usual plan negative and every cheaper-than claim off.
 *
 * The 1 TB floor is one shared answer (`savingAllowed`), read by
 * quoteForStoredTb too, so the calculator and this line cannot disagree about
 * where a saving may be quoted.
 * @param {unknown} bill a monthBillCents() result
 * @param {number|bigint} size30Bytes the same size30 the bill was worked from
 * @returns {{usd: number, planUsd: number, copy: string}|null}
 */
export function savedLine(bill, size30Bytes) {
  if (typeof bill !== "object" || bill === null) {
    throw new TypeError(`savedLine needs a monthBillCents result, got ${String(bill)}`);
  }
  const fields =
    /** @type {{meteredCents?: unknown, maximumCents?: unknown, storageCents?: unknown}} */ (bill);
  const metered = checked(fields.meteredCents, "bill.meteredCents");
  const maximum = checked(fields.maximumCents, "bill.maximumCents");
  const storage = checked(fields.storageCents, "bill.storageCents");
  const bytes = checkedBytes(size30Bytes, "size30Bytes");
  const size30Tb = Number(bytes) / (GB_PER_TB * BYTES_PER_GB);
  if (storage === 0 || !savingAllowed(bytes)) {
    return null;
  }
  const capped = metered > maximum;
  const savedCents = Math.max(0, (capped ? metered : maximum) - storage);
  const planCents = Math.max(0, Math.round(usualPlanMonthlyUsd(size30Tb) * 100) - storage);
  if (savedCents === 0 && planCents === 0) {
    return null;
  }
  const sentences = [];
  if (savedCents > 0) {
    const amount = formatUsd(savedCents / 100);
    sentences.push((capped ? SAVED_COPY.capped : SAVED_COPY.uncapped).replace("{amount}", amount));
  }
  if (planCents > 0) {
    sentences.push(
      SAVED_COPY.plan
        .replace("{amount}", formatUsd(planCents / 100))
        .replace("{plan}", PRICE.usualPlan.label),
    );
  }
  return Object.freeze({
    usd: savedCents / 100,
    planUsd: planCents / 100,
    copy: sentences.join(" "),
  });
}

/**
 * The bill so far, compared with the cap, and whether the drive is read-only.
 * The cap counts the total of monthBillCents() — the storage line, min(metered
 * so far, maximum), plus the download line — not the raw meter, so the cap can
 * never pass what the invoice will be, and a month of downloads alone reaches
 * the cap the way a month of storage does (drive#496). At the cap the api
 * Worker deletes each write-capable key and mints read-only ones; the CLI
 * restarts the mount. Nothing is deleted.
 * @param {unknown} size30Bytes size30 in bytes
 * @param {unknown} capUsd the account's cap in dollars
 * @param {BillingConfig} [config=BILLING_CONFIG]
 * @param {{downloadBytes?: number}} [downloads] the month's download bytes;
 *   omitted is a storage-only month
 * @returns {{capUsd: number, countedUsd: number, remainingUsd: number, state: "active"|"read_only"}}
 */
export function capStatus(size30Bytes, capUsd, config = BILLING_CONFIG, downloads = {}) {
  const bytes = checkedBytes(size30Bytes, "size30Bytes");
  const cap = checked(capUsd, "capUsd");
  const counted =
    monthBillCents({
      size30Bytes: bytes,
      downloadBytes: downloads.downloadBytes ?? 0,
      config: billingConfig(config),
    }).totalCents / 100;
  const atCap = counted > cap;
  return Object.freeze({
    capUsd: cap,
    countedUsd: counted,
    remainingUsd: Math.max(0, cap - counted),
    state: atCap ? "read_only" : "active",
  });
}

/**
 * The cap line `drive status` prints for the spending cap, one per state. The
 * numbers come straight from a capStatus() result, so the CLI cannot print a
 * line the invoice would not match; the capped-drive sentence is the message
 * table's `cap-reached` entry verbatim, so the page, the CLI and the api cannot
 * each write their own version of the same news (docs/build-spec.md,
 * "Every failure path maps to one plain message with one next step").
 *
 * The CLI is Go and cannot import this module, so the line travels in the
 * /api/usage response (see handleUsageRequest) and `drive status` prints it as
 * it arrives.
 * @param {unknown} cap a capStatus() result
 * @returns {string}
 */
export function capLine(cap) {
  if (typeof cap !== "object" || cap === null) {
    throw new TypeError(`capLine needs a capStatus result, got ${String(cap)}`);
  }
  const fields =
    /** @type {{state?: unknown, capUsd?: unknown, countedUsd?: unknown, remainingUsd?: unknown}} */ (
      cap
    );
  if (fields.state !== "active" && fields.state !== "read_only") {
    throw new TypeError(
      `capLine needs a cap whose state is "active" or "read_only", got ${String(fields.state)}`,
    );
  }
  const capUsd = checked(fields.capUsd, "cap.capUsd");
  const countedUsd = checked(fields.countedUsd, "cap.countedUsd");
  const remainingUsd = checked(fields.remainingUsd, "cap.remainingUsd");
  if (fields.state === "active") {
    return `Cap ${formatUsd(capUsd)}: ${formatUsd(countedUsd)} counted this month, ${formatUsd(remainingUsd)} left.`;
  }
  return (
    failureMessage("cap-reached") +
    `\nCap ${formatUsd(capUsd)} reached: ${formatUsd(countedUsd)} counted this month. ` +
    "Uploads waiting in the cache stay on this Mac and go up once the cap is raised."
  );
}

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
    /** @type {{size30Bytes?: unknown, size30ReachedDay?: unknown, size30DropsOutDay?: unknown, todayDrawMillicents?: unknown, gbMinutes?: unknown, monthMinutes?: unknown, peakGb?: unknown, storedGb?: unknown, storedDaily?: unknown, downloadBytes?: unknown, averageStoredGb?: unknown, capUsd?: unknown, cardAdded?: unknown, cardOnFile?: unknown}} */ (
      usage
    );
  if (fields.peakGb !== undefined) {
    throw new TypeError(
      "usage.peakGb is no longer part of the bill (drive#642): the charge follows size30",
    );
  }
  if (fields.gbMinutes !== undefined) {
    throw new TypeError(
      "usage.gbMinutes is no longer part of the bill (drive#642): the charge follows usage.size30Bytes",
    );
  }
  refuseFoundingFields(usage, "usage");
  if (fields.size30Bytes === undefined) {
    throw new TypeError("usage.size30Bytes is the bill (drive#642)");
  }
  const size30Bytes = checkedBytes(fields.size30Bytes, "usage.size30Bytes");
  const storedGb = checked(fields.storedGb, "usage.storedGb");
  const downloadBytes = checked(fields.downloadBytes, "usage.downloadBytes");
  const capUsd = checked(fields.capUsd, "usage.capUsd");
  const series = storedSeries(fields.storedDaily);
  const size30ReachedDay =
    fields.size30ReachedDay === undefined || fields.size30ReachedDay === null
      ? null
      : isDay(fields.size30ReachedDay)
        ? fields.size30ReachedDay
        : (() => {
            throw new TypeError(
              `usage.size30ReachedDay must be a real YYYY-MM-DD date, got ${String(fields.size30ReachedDay)}`,
            );
          })();
  const size30DropsOutDay =
    fields.size30DropsOutDay === undefined || fields.size30DropsOutDay === null
      ? null
      : isDay(fields.size30DropsOutDay)
        ? fields.size30DropsOutDay
        : (() => {
            throw new TypeError(
              `usage.size30DropsOutDay must be a real YYYY-MM-DD date, got ${String(fields.size30DropsOutDay)}`,
            );
          })();
  const todayDrawMillicents =
    fields.todayDrawMillicents === undefined
      ? dailyDrawMillicents(
          monthBillCents({ size30Bytes, downloadBytes, config }).totalMillicents,
          0,
        ).drawMillicents
      : checked(fields.todayDrawMillicents, "usage.todayDrawMillicents");
  const effectiveCap = fields.cardAdded ? capUsd : Math.min(capUsd, config.freeMonthlyUsd);
  const cardOnFile =
    fields.cardOnFile === undefined ? fields.cardAdded === true : fields.cardOnFile === true;
  const size30Gb = Number(size30Bytes) / BYTES_PER_GB;
  const downloads = downloadCostUsd(downloadBytes, size30Gb, config);
  const bill = monthBillCents({
    size30Bytes,
    downloadBytes,
    config,
  });
  return Object.freeze({
    size30Bytes: jsonBytes(size30Bytes),
    size30Gb,
    size30ReachedDay,
    size30DropsOutDay,
    todayDrawMillicents,
    storedGb,
    storedDaily: series,
    meteredUsd: bill.meteredCents / 100,
    maximumUsd: bill.maximumCents / 100,
    billUsd: bill.totalCents / 100,
    billCents: bill,
    saved: savedLine(bill, size30Bytes),
    downloads: Object.freeze({
      freeBytes: downloads.freeBytes,
      usedBytes: downloadBytes,
      billableBytes: downloads.billableBytes,
      usd: downloads.usd,
    }),
    cap: capStatus(size30Bytes, effectiveCap, config, {
      downloadBytes,
    }),
    labels: Object.freeze({
      storedNow: formatBytes(storedGb * BYTES_PER_GB),
      size30: formatBytes(size30Bytes),
      size30Reached: size30ReachedDay ?? "",
      size30DropsOut: size30DropsOutDay ?? "",
      todayDraw: formatUsd(todayDrawMillicents / MILLICENTS_PER_CENT / 100),
      downloads: `${formatBytes(downloadBytes)} of ${formatBytes(downloads.freeBytes)} free`,
      cost: cardOnFile ? formatUsd(bill.totalCents / 100) : PRICE.noChargeYet,
      cap: formatUsd(effectiveCap),
      accountCap: formatUsd(capUsd),
    }),
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
 * north star: Safe). The one gate is signedInAccount() in core/status.js, the
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
 * `UPLOAD_LABEL` in core/status.js, the one word table and the one byte
 * formatter, so the page sets a finished string and carries no second copy of
 * either. It is null when there is no queue to report — the queue is rclone's,
 * on the Mac, and the Worker has no device store yet — and a payload that is
 * not a queue is refused rather than rendered, so the line can never be a
 * default the drive did not ask for.
 * @param {Request} request
 * @param {{id: string, name: string, capUsd?: number, cardOnFile?: boolean, usage?: Record<string, unknown>|null, fairUse?: unknown, openPublicLinks?: number}|null} account the signed-in account, or null when signed out. `usage` is the
 *   month's own metered numbers, read by the route from the account store's
 *   `monthUsage` (drive#496); without it this answers the empty month.
 * @param {unknown} [upload] the live rclone upload queue, or null when there is none to report
 * @param {string|null} [balanceLine] the prepaid balance line (core/topup.js balanceLine, drive#586), or null when there is no balance store
 * @param {string} [monthIso] the month's own first instant as the Worker sends it ("2026-10-01T00:00:00.000Z"), from the one boundary the meter, the cap walk and the invoice read (src/index.js, core/meter.js monthStart). The caller owns the month so this module carries no second answer to what month the numbers belong to. It sits behind the two defaults above, so it is written `[monthIso]` and defaults to empty: a caller that leaves it out is refused below by name, the same as one that sends a day that is not an instant.
 */
export function handleUsageRequest(
  request,
  account,
  upload = null,
  balanceLine = null,
  monthIso = "",
) {
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
  if (typeof monthIso !== "string" || Number.isNaN(new Date(monthIso).getTime())) {
    throw new TypeError(
      `handleUsageRequest needs the month's first instant, got ${String(monthIso)}`,
    );
  }
  const metered = account.usage;
  const empty =
    metered !== null && typeof metered === "object"
      ? usageSummary(
          /** @type {Parameters<typeof usageSummary>[0]} */ (
            /** @type {Record<string, unknown>} */ (metered)
          ),
        )
      : usageSummary({
          size30Bytes: 0,
          storedGb: 0,
          storedDaily: [],
          downloadBytes: 0,
          capUsd,
          cardAdded: true,
          cardOnFile: account.cardOnFile === true,
        });
  const uploadLine = upload === null ? null : uploadProgress(upload).label;
  const fairUseLineText = fairUseLineFromAccount(account);
  const openPublicLinks =
    typeof account.openPublicLinks === "number" &&
    Number.isFinite(account.openPublicLinks) &&
    account.openPublicLinks >= 0
      ? Math.floor(account.openPublicLinks)
      : 0;
  const body = {
    ...empty,
    monthIso,
    capLine: capLine(empty.cap),
    uploadLine,
    balanceLine,
    fairUseLine: fairUseLineText,
    openPublicLinks,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: USAGE_HEADERS });
}

/**
 * The fair-use line the usage page and `drive status` print, from the same
 * check the upload path uses. Missing snapshot data is null, not a guessed
 * line: the page hides it, and a later read that can see the meter fills it.
 * @param {{fairUse?: unknown}} account
 */
function fairUseLineFromAccount(account) {
  const snapshot = account.fairUse;
  if (snapshot === undefined || snapshot === null) {
    return null;
  }
  if (typeof snapshot !== "object") {
    return null;
  }
  const fields =
    /** @type {{liveBytes?: unknown, ghostBytes?: unknown, size30Bytes?: unknown, oldestGhostCreatedAt?: unknown, now?: unknown}} */ (
      snapshot
    );
  if (
    !isWholeByteCount(fields.liveBytes) ||
    !isWholeByteCount(fields.ghostBytes) ||
    !isWholeByteCount(fields.size30Bytes)
  ) {
    return null;
  }
  const now = fields.now === undefined ? Date.now() : fields.now;
  if (!isWholeByteCount(now)) {
    return null;
  }
  const oldest = fields.oldestGhostCreatedAt;
  if (oldest !== undefined && oldest !== null && !isWholeByteCount(oldest)) {
    return null;
  }
  try {
    return fairUseCheck({
      liveBytes: fields.liveBytes,
      ghostBytes: fields.ghostBytes,
      uploadBytes: 0,
      size30Bytes: fields.size30Bytes,
      oldestGhostCreatedAt: oldest,
      now,
    }).line.copy;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function isWholeByteCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
