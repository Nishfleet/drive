// First-run and sync status: the words and the arithmetic for "is it
// working?", kept in one place because three surfaces ask the same question
// (the first-run page, `drive status`, and the Devices list in
// docs/build-spec.md "Screens"). The page is a Vite entry at the repo root
// (issue #70): src/get-started.js imports this module and renders from it, so
// the page and the CLI read the same words and there is no second copy left
// to drift.
//
// Plain data and pure functions for the words and math; the one fetch handler
// at the bottom serves the page's poll and uses only the standard Response,
// which node --test provides.

import { sessionAccount } from "./auth.js";
import { INSTALL_LINES } from "./install-lines.js";
import { failureMessage, INSTALL_COMMAND, SIGN_IN_COMMAND } from "./messages.js";

// INSTALL_COMMAND is re-exported from the message table so the first-run page
// and the tests keep importing it from here. It mounts the drive and connects
// the agent tools. It does not sign anyone in: that is LOGIN_COMMAND.
export { INSTALL_COMMAND };

// The command that connects this machine to the account before `drive init`
// runs: it opens the browser, mints the machine's key and writes the storage
// settings, so init needs no pasted keys (drive issue #415). The string is the
// message table's SIGN_IN_COMMAND (drive#557), so the first-run page, the
// emails, the home page and every failure sentence name the same one command
// and none of them can point at `drive init`, which does not sign in.
export const LOGIN_COMMAND = SIGN_IN_COMMAND;

// The command that says what the drive on this machine is doing: whether it
// is mounted, what is waiting to upload and what the month has cost. It
// answers from the machine itself, so it is the line the page points at while
// the api Worker that stamps `devices.last_seen_at` is not deployed (drive
// #342) and the page cannot see a sign-in land on its own (drive #556).
export const STATUS_COMMAND = "drive status";

// The two lines the Get started box shows, in the order they run: log in,
// then set up. The install line for each system sits above the box
// (INSTALL_LINES), so the box only carries the drive's own commands.
export const FIRST_RUN_COMMAND = `${LOGIN_COMMAND}\n${INSTALL_COMMAND}`;

// The one line that puts the command on a machine, one row per system, shown
// above INSTALL_COMMAND so a new person sees what to paste before they are told
// what to paste it into (drive issue #428). Re-exported from install-lines.js,
// which is the one table test/packaging.test.mjs holds to .goreleaser.yaml
// (drive#509). A short `brew install drive` cannot resolve after a release.
export { INSTALL_LINES };

// What the page walks through, in order: log in, approve, check it works. The
// third step names STATUS_COMMAND rather than promising this page a flip,
// because until the api Worker lands (drive #342) nothing writes
// `devices.last_seen_at`, and a page that promises a flip it cannot make is a
// page someone keeps waiting at.
export const FIRST_RUN_STEPS = Object.freeze([
  {
    title: "Log in and set up",
    body: `Paste these two commands into the terminal on the Mac you want the drive on:\n${FIRST_RUN_COMMAND}`,
  },
  {
    title: "Sign in in the browser",
    body: "The browser opens on this page. Approve the code the terminal shows, and come back here.",
  },
  {
    title: "Check it works",
    body: `Run ${STATUS_COMMAND} on the machine. It says whether the drive is mounted and what is waiting to upload.`,
  },
]);

// Where the page reads the live state from. The path is the api Worker's job
// (build-spec.md "The pieces" item 3); this page only reads it, and the shape
// it reads is the same one the Devices screen renders.
export const STATUS_ENDPOINT = "/api/first-run-status";

// The page polls on this interval while it waits. Actually reading the value
// keeps the number in one place and lets the test pin it.
export const POLL_INTERVAL_MS = 3000;

// A device counts as connected when it has signed in inside this window. The
// window is not "recently active": the page is answering "did the sign-in
// land?", and a device that signed in an hour ago is not what the person is
// waiting for.
export const CONNECTED_WINDOW_MS = 2 * 60 * 1000;

// A device with no sync inside this window is not "synced": a save uploads a
// few seconds after close (docs/spec.md "How it works"), so a quarter of an
// hour of silence is worth saying out loud rather than papering over.
export const SYNCED_WINDOW_MS = 15 * 60 * 1000;

// The sentences the page shows for the live connection line. Static so the
// shipped page can carry them verbatim and the test can pin them.
//
// While the api Worker is not deployed (drive #342) the status route can read a
// device's `last_seen_at` but no device has one stamped yet, so the honest line
// for the two states that wait is STATUS_COMMAND, which answers from the
// machine. Nothing here promises this page a flip it cannot make (drive #556).
export const CONNECTION_COPY = Object.freeze({
  waiting: {
    what: "Waiting for this Mac to sign in.",
    next: `Run ${STATUS_COMMAND} on the machine to see whether the drive is mounted.`,
  },
  connected: {
    what: "Connected. Your drive is mounted on this Mac.",
    next: "Save a file in the drive folder and it uploads a few seconds later.",
  },
  unreachable: {
    what: "Cannot reach the drive service right now.",
    next: `Leave this page open. It keeps checking, and ${STATUS_COMMAND} on the machine says whether the drive is mounted.`,
  },
});

// Every empty screen says what to do first (issue #32). One entry per surface
// the first-run page renders today; the rest of the v1 screens
// (build-spec.md "Screens") add their entry when they are built, so the table
// never holds a line nothing reads.
export const EMPTY_STATES = Object.freeze({
  devices: {
    what: "No other devices yet.",
    next: "Run drive login on another Mac, then sign in.",
  },
  activity: {
    what: "Nothing has synced yet.",
    next: "The first save you make in the drive folder shows up here.",
  },
});

// The desktop notification for a sync error. The page raises it with the
// browser Notification API when the person has allowed notifications, and
// says nothing when they have not: the error is already on the page, so a
// denied permission is not a failure to report.
export const SYNC_ERROR_NOTIFICATION = Object.freeze({
  title: "Storagebun could not sync a file",
  body: "Open the drive page to see which file and what to do next.",
});

/**
 * @param {unknown} value
 * @param {string} field the field name the error carries
 * @returns {number} epoch milliseconds
 */
function millis(value, field) {
  const time =
    typeof value === "number"
      ? value
      : value instanceof Date
        ? value.getTime()
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
  if (!Number.isFinite(time)) {
    throw new TypeError(`status needs ${field} as a date or ISO string, got ${String(value)}`);
  }
  return time;
}

/**
 * The first-run state of a device, for the connection line and the Devices
 * list. `error` is the poll's own failure (set by the page), never the
 * device's: an unreachable service must not read as "waiting on you".
 * @param {unknown} device
 * @param {number|Date} now
 */
export function connectionStatus(device, now = Date.now()) {
  if (typeof device !== "object" || device === null) {
    throw new TypeError(`connectionStatus needs a device object, got ${String(device)}`);
  }
  const row = /** @type {{error?: unknown, lastSeenAt?: unknown}} */ (device);
  if (row.error) {
    return { state: "unreachable", ...CONNECTION_COPY.unreachable };
  }
  if (!row.lastSeenAt) {
    return { state: "waiting", ...CONNECTION_COPY.waiting };
  }
  const lastSeen = millis(row.lastSeenAt, "lastSeenAt");
  const age = millis(now, "now") - lastSeen;
  if (age <= CONNECTED_WINDOW_MS) {
    return { state: "connected", ...CONNECTION_COPY.connected };
  }
  return { state: "waiting", ...CONNECTION_COPY.waiting };
}

/**
 * The state the first-run poll answers for a whole account: connected when one
 * of the account's live devices signed in inside `CONNECTED_WINDOW_MS`, waiting
 * otherwise. The window is `connectionStatus`'s own and the rows are the ones
 * the route read, so the answer here, the page's own flip (src/get-started.js
 * `isConnected`) and the CLI's read of the same module cannot drift into two
 * answers for "did the sign-in land?".
 *
 * A row that is not an object, or whose clock cannot be read, is a TypeError
 * the same `connectionStatus` raises: a poll that cannot read a device is a bug
 * to see, not a "waiting" to show a person who has already signed in.
 * @param {unknown} devices
 * @param {number|Date} [now]
 * @returns {"connected"|"waiting"}
 */
export function firstRunState(devices, now = Date.now()) {
  if (devices === null || devices === undefined) {
    return "waiting";
  }
  if (!Array.isArray(devices)) {
    throw new TypeError(`firstRunState needs a list of device rows, got ${typeof devices}`);
  }
  for (const device of devices) {
    if (connectionStatus(device, now).state === "connected") {
      return "connected";
    }
  }
  return "waiting";
}

/**
 * One device's sync state for the Devices list: `synced`, `syncing` (a save
 * waiting to upload), `error`, or `never` (signed in, nothing synced yet).
 * @param {{lastSyncAt?: string|Date|null, pendingBytes?: number|null, syncError?: string|null}} device
 * @param {number|Date} now
 */
export function syncStatus(device, now = Date.now()) {
  if (typeof device !== "object" || device === null) {
    throw new TypeError(`syncStatus needs a device object, got ${String(device)}`);
  }
  if (typeof device.syncError === "string" && device.syncError !== "") {
    return {
      state: "error",
      label: "Sync error",
      detail: String(device.syncError),
    };
  }
  // `typeof … === "number"` rather than Number.isFinite: the field is
  // `number|null|undefined` and the question is whether a save is waiting, so
  // a null or absent count is the same answer as a non-finite one, and this
  // is the check that narrows the field for the comparison below.
  const pending = device.pendingBytes;
  if (typeof pending === "number" && Number.isFinite(pending) && pending > 0) {
    return { state: "syncing", label: "Uploading", detail: null };
  }
  if (!device.lastSyncAt) {
    return { state: "never", label: "No syncs yet", detail: null };
  }
  const lastSync = millis(device.lastSyncAt, "lastSyncAt");
  const age = millis(now, "now") - lastSync;
  if (age <= SYNCED_WINDOW_MS) {
    return { state: "synced", label: "Synced", detail: null };
  }
  return { state: "synced", label: "Synced", detail: "Quiet for a while" };
}

// The upload-progress line, as a table of fragments so the page can carry the
// same words it cannot import (`drive status` prints the assembled line).
// `paused` and `resumed` are the two states `drive pause` and `drive resume`
// name, printed by the status line and by the CLI's own command output; the Go
// CLI mirrors this table (cmd/drive/pause.go) and
// TestStatusWordsMatchThePageWords joins the two copies.
export const UPLOAD_LABEL = Object.freeze({
  upToDate: "Up to date",
  oneFile: "Uploading 1 file",
  manyFiles: "Uploading {files} files",
  noCount: "Uploading",
  progress: "{uploaded} of {total} ({percent}%)",
  // A paused queue is not a moving one. Its line names the state first and
  // then what is still waiting, so a person reads "Paused" and not
  // "Uploading" for bytes that are not leaving.
  paused: "Paused",
  resumed: "Resumed",
  pausedOne: "1 file waiting",
  pausedMany: "{files} files waiting",
  pausedLine: "Paused: {waiting} ({left} left)",
  // The other half of a mixed account (drive issue #865): one device uploading
  // while another is paused. {uploading} is the moving half's own line and
  // {paused} the held half's, both spelled from the fragments above.
  mixedLine: "{uploading}; {paused}",
  // Why a queued file has not gone up yet (drive issue #107). `drive status`
  // prints these; the page carries the same fragments so the two copies cannot
  // drift. Disk-full uses FAILURE_MESSAGES["disk-cache-full"] instead.
  waitingWhy: "They are waiting to upload.",
  waitingUnmounted: "They are waiting because the drive is not mounted.",
  waitingUnmountedNext: "They will upload when the drive is mounted again.",
});

/**
 * Upload progress for `drive status` and the page's activity line: how much of
 * the queue has gone up. Zero total means nothing is waiting, which is a
 * complete state ("Up to date"), not an error and not a division by zero.
 *
 * A `paused` upload is the same arithmetic in a stopped state (drive issue
 * #100): the label leads with the pause word and the bytes still to send, so a
 * paused drive never reads as an uploading one. An explicit `paused: false`
 * behaves like an absent flag, so a caller that always sets the field does not
 * pause its own queue.
 *
 * A queue that carries a paused half beside the moving one (drive issue #865,
 * `pausedFiles` on the payload) is neither stopped nor fully moving: the line
 * leads with the uploading half's own words, then names the paused half with
 * its own count. One uploading device beside one paused device on one account
 * is the case this exists for, and the queue store (core/queues.js
 * `sumLiveQueues`) is what keeps the two halves apart.
 * @param {unknown} upload
 */
export function uploadProgress(upload) {
  if (typeof upload !== "object" || upload === null) {
    throw new TypeError(`uploadProgress needs an upload object, got ${String(upload)}`);
  }
  const fields =
    /** @type {{uploadedBytes?: unknown, totalBytes?: unknown, files?: unknown, paused?: unknown}} */ (
      upload
    );
  const uploaded = fields.uploadedBytes;
  const total = fields.totalBytes;
  if (typeof uploaded !== "number" || !Number.isFinite(uploaded) || uploaded < 0) {
    throw new TypeError(`uploadedBytes must be 0 or more, got ${uploaded}`);
  }
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    throw new TypeError(`totalBytes must be 0 or more, got ${total}`);
  }
  if (total === 0) {
    return { percent: 100, label: withHeldQueue(UPLOAD_LABEL.upToDate, fields) };
  }
  if (uploaded > total) {
    throw new RangeError(`uploadedBytes (${uploaded}) cannot pass totalBytes (${total})`);
  }
  const percent = Math.round((uploaded / total) * 100);
  // `files` is optional on the payload, so it is read into a local: the count
  // is null unless it is a positive integer, and the label below switches on
  // that null rather than on a missing field.
  const count = fields.files;
  const files = typeof count === "number" && Number.isInteger(count) && count > 0 ? count : null;
  // The pause is the same arithmetic in a stopped state, read off the payload
  // the same defensive way: only a literal true pauses, so `paused: false` and
  // an absent flag both leave the uploading line alone.
  if (fields.paused === true) {
    return { percent, label: pausedLabel(uploaded, total, files) };
  }
  const head = uploadHead(files);
  const detail = UPLOAD_LABEL.progress
    .replace("{uploaded}", formatBytes(uploaded))
    .replace("{total}", formatBytes(total))
    .replace("{percent}", String(percent));
  const uploading = `${head}: ${detail}`;
  return { percent, label: withHeldQueue(uploading, fields) };
}

/**
 * The head a queue leads with: its file count in the one table's own words.
 * The count is null unless it is a positive integer, so a payload with no
 * count leads with the bare "Uploading".
 * @param {number|null} files
 * @returns {string}
 */
function uploadHead(files) {
  if (files === null) {
    return UPLOAD_LABEL.noCount;
  }
  return files === 1
    ? UPLOAD_LABEL.oneFile
    : UPLOAD_LABEL.manyFiles.replace("{files}", String(files));
}

/**
 * The line for a queue nothing is leaving from: the pause word first, then
 * what is still waiting, so a person reads "Paused" and not "Uploading" for
 * bytes that are not moving.
 * @param {number} uploaded
 * @param {number} total
 * @param {number|null} files
 * @returns {string}
 */
function pausedLabel(uploaded, total, files) {
  const left = formatBytes(total - uploaded);
  const waiting =
    files === null
      ? null
      : files === 1
        ? UPLOAD_LABEL.pausedOne
        : UPLOAD_LABEL.pausedMany.replace("{files}", String(files));
  return waiting === null
    ? `${UPLOAD_LABEL.paused}: ${left} left`
    : UPLOAD_LABEL.pausedLine.replace("{waiting}", waiting).replace("{left}", left);
}

/**
 * The pause a mixed account carries beside its moving bytes, in the one table's
 * own words (drive issue #865). The held half is read defensively the way the
 * queue's own numbers are: a half the payload cannot describe as a queue is no
 * clause at all, so the line is the uploading half's own rather than one with
 * a hole in it. A half that is holding nothing is no clause either.
 * @param {string} uploading the moving half's own line
 * @param {Record<string, unknown>} fields the queue payload, already checked
 * @returns {string}
 */
function withHeldQueue(uploading, fields) {
  const held = heldLabel(fields);
  return held === null
    ? uploading
    : UPLOAD_LABEL.mixedLine.replace("{uploading}", uploading).replace("{paused}", held);
}

/**
 * The paused half of a mixed queue as its own line, or null when the payload
 * carries none. It is read by the same rules as the queue itself (drive issue
 * #865): a count that is not a positive whole number is no count, so the half
 * is named by its bytes alone the way a standalone queue is, and a byte pair
 * that cannot be a queue drops the clause rather than naming an impossible
 * half. A paused device with zero-byte files (files > 0, totalBytes = 0) is
 * still named, because the person sees "X files waiting" even when bytes are
 * zero.
 * @param {Record<string, unknown>} fields
 * @returns {string|null}
 */
function heldLabel(fields) {
  const count = fields.pausedFiles;
  const files = typeof count === "number" && Number.isInteger(count) && count > 0 ? count : null;
  const uploadedBytes = byteCount(fields.pausedUploadedBytes);
  const totalBytes = byteCount(fields.pausedTotalBytes);
  if (uploadedBytes === null || totalBytes === null || uploadedBytes > totalBytes) {
    return null;
  }
  return pausedLabel(uploadedBytes, totalBytes, files);
}

/**
 * A byte count read off a payload, or null when the payload carries none that
 * is one: a whole number, 0 or more. A line is never built from a value that
 * is not a count, so a queue whose numbers are not numbers keeps its words to
 * what is known.
 * @param {unknown} value
 * @returns {number|null}
 */
function byteCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

const STATUS_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * The signed-in account a request carries, or null when the request is signed
 * out. The session is a cookie Better Auth signed and the customer database
 * (DRIVE_DB) holds: `POST /api/signin` mails a single-use link, following it
 * mints a session, and every account route is scoped to the account that
 * session names.
 *
 * A cookie the browser chose is not a session: the token is verified against
 * the database that minted it, so a made-up value, a forgotten one, an expired
 * one and a revoked one all answer null, and a request that cannot prove an
 * account never reads one's files (issue #45, north star: Safe).
 *
 * `store` is a falsy value rather than an auth instance, so a test can hand
 * this the closed door and prove the gate denies by default.
 * @param {Request} request
 * @param {{api: {getSession: (options: {headers: Headers}) => Promise<{user: {id: string, name: string, email: string}} | null>}}|null|undefined} [store]
 * @returns {Promise<{id: string, name: string, email: string}|null>}
 */
export async function signedInAccount(request, store) {
  return sessionAccount(request, store ?? null);
}

/**
 * The 401 every account route answers when the request cannot prove an
 * account: the message table's one sign-in message, the cookie challenge the
 * sign-in flow will answer, and no data of any kind. It lives here because
 * this module owns the account gate (signedInAccount below), and the files and
 * usage handlers answer with the same shape rather than writing their own
 * (drive issue #73, north star: Safe).
 * @returns {Response}
 */
export function unauthorizedResponse() {
  return new Response(JSON.stringify({ error: failureMessage("unauthorized") }), {
    status: 401,
    // A cookie session, so the challenge names the scheme the sign-in flow
    // mints rather than a bearer token it does not use.
    headers: { ...STATUS_HEADERS, "www-authenticate": "Cookie" },
  });
}

/**
 * Handles GET /api/first-run-status, the page's poll. It answers with the
 * signed-in account's device state; until the api Worker's device store lands
 * (build-spec.md data model `devices`, built with #22/#2), no device can have
 * signed in, so a signed-in account gets `waiting` with an empty device list —
 * the same shape the real store returns for a signed-in account with no
 * devices yet.
 *
 * `upload` is the live rclone upload queue, in the one shape `uploadProgress()`
 * and the first-run page's `uploadLine()` read:
 * `{uploadedBytes, totalBytes, files?, paused?}`. It is null when there is no
 * queue to report. The queue is rclone's, on the Mac, so the Worker can only
 * report one once the device store lands: an account with no signed-in device
 * has nothing waiting, and null is that answer rather than an invented zero
 * that would read as a live queue of no bytes. The field ships with the payload
 * now (drive issue #308) so both pages read one shape, and it is an argument
 * to the handler rather than a value written here, so the store that fills it
 * is one line at the call site and the payload shape does not change when it
 * lands.
 * The account is a required argument and never read from a request that
 * cannot prove one (issue #45, north star: Safe): `signedInAccount()` is null
 * for every caller until the sign-in flow lands, so the endpoint answers 401
 * and the message table's `unauthorized` words, never device data. The 401 is
 * shared with the other account routes through unauthorizedResponse() above
 * (drive issue #73).
 * @param {Request} request
 * @param {{id: string, name: string}|null} [account] the signed-in account, or null when signed out
 * @param {unknown} [upload] the live rclone upload queue, or null when there is none to report
 * @param {unknown[]} [devices] the account's live device rows, or the empty list
 *   when none has signed in
 */
export function handleFirstRunStatusRequest(request, account, upload = null, devices = []) {
  // The gate comes before the method check, so an anonymous request is told
  // only that it is not signed in and never which methods this route has.
  if (!account) {
    return unauthorizedResponse();
  }
  if (request.method !== "GET") {
    return new Response("Method not allowed. GET this endpoint for drive status.", {
      status: 405,
      headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
    });
  }
  // `upload` is the raw queue, not a finished line: this endpoint feeds the
  // first-run page's renderer, which calls uploadLine() on it (drive issue
  // #100). The value is the shape uploadProgress() accepts, and the renderer's
  // own guard turns a payload it cannot draw into its unreachable state, so no
  // second check is written here.
  // A device that cannot be read is loud here, not silent: `firstRunState`
  // turns a clock it cannot read into a TypeError, so a payload row that is
  // not a device row fails the request instead of answering "waiting" to an
  // account whose machine has signed in.
  return new Response(
    JSON.stringify({
      state: firstRunState(devices),
      devices: [...devices],
      upload,
    }),
    {
      status: 200,
      headers: STATUS_HEADERS,
    },
  );
}

/**
 * Bytes as a person reads them: one decimal under 10, none above, so a queue
 * of 1.2 GB and a queue of 12 GB both stay one short line.
 * @param {unknown} bytes
 */
export function formatBytes(bytes) {
  /** @type {bigint} */
  let asBig;
  if (typeof bytes === "bigint") {
    if (bytes < 0n) {
      throw new TypeError(`formatBytes needs 0 or more bytes, got ${bytes}`);
    }
    asBig = bytes;
  } else if (typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0) {
    asBig = BigInt(Math.round(bytes));
  } else {
    throw new TypeError(`formatBytes needs 0 or more bytes, got ${bytes}`);
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  let divisor = 1n;
  while (asBig >= divisor * 1000n && unit < units.length - 1) {
    divisor *= 1000n;
    unit += 1;
  }
  if (unit === 0) {
    return `${asBig} B`;
  }
  const tenths = (asBig * 10n + divisor / 2n) / divisor;
  if (tenths < 100n) {
    return `${tenths / 10n}.${tenths % 10n} ${units[unit]}`;
  }
  return `${(asBig + divisor / 2n) / divisor} ${units[unit]}`;
}
