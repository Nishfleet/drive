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
import { failureMessage } from "./messages.js";
import { readSessionCookie } from "./accounts.js";

// The one command a new person runs after sign-up. build-spec.md "One-command
// setup": `drive init` signs you in, mounts the drive and connects every agent
// tool it finds. Kept here so the page, the CLI and the docs cannot disagree
// about what the one command is.
export const INSTALL_COMMAND = "drive init";

// What the page walks through, in order. The CLI is not shipped yet
// (cmd/drive lands with build step 2), so the first two steps describe what
// `drive init` does rather than a second install path.
export const FIRST_RUN_STEPS = Object.freeze([
  {
    title: "Run the command",
    body: `Paste ${INSTALL_COMMAND} into the terminal on the Mac you want the drive on.`,
  },
  {
    title: "Sign in in the browser",
    body: "The browser opens on this page. Approve the code the terminal shows, and come back here.",
  },
  {
    title: "Watch it connect",
    body: "This page flips to connected the moment your Mac signs in. Nothing to refresh.",
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
export const CONNECTION_COPY = Object.freeze({
  waiting: {
    what: "Waiting for this Mac to sign in.",
    next: `Run ${INSTALL_COMMAND} in your terminal. This page updates on its own.`,
  },
  connected: {
    what: "Connected. Your drive is mounted on this Mac.",
    next: "Save a file in the drive folder and it uploads a few seconds later.",
  },
  unreachable: {
    what: "Cannot reach the drive service right now.",
    next: "Leave this page open. It keeps checking and flips to connected on its own.",
  },
});

// Every empty screen says what to do first (issue #32). One entry per surface
// the first-run page renders today; the rest of the v1 screens
// (build-spec.md "Screens") add their entry when they are built, so the table
// never holds a line nothing reads.
export const EMPTY_STATES = Object.freeze({
  devices: {
    what: "No other devices yet.",
    next: "Run drive init on another Mac, then sign in.",
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
  title: "Drive could not sync a file",
  body: "Open the drive page to see which file and what to do next.",
});

/**
 * @param {number|Date|string} value
 * @param {string} field the field name the error carries
 * @returns {number} epoch milliseconds
 */
function millis(value, field) {
  // A number is already epoch milliseconds (Date.now() is the default for
  // `now`); a string is an ISO timestamp; a Date is its epoch value.
  const time =
    typeof value === "number"
      ? value
      : value instanceof Date
        ? value.getTime()
        : Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new TypeError(
      `status needs ${field} as a date or ISO string, got ${String(value)}`,
    );
  }
  return time;
}

/**
 * The first-run state of a device, for the connection line and the Devices
 * list. `error` is the poll's own failure (set by the page), never the
 * device's: an unreachable service must not read as "waiting on you".
 * @param {{lastSeenAt?: string|Date|null, name?: string|null, error?: string|null}} device
 * @param {number|Date} now
 */
export function connectionStatus(device, now = Date.now()) {
  if (typeof device !== "object" || device === null) {
    throw new TypeError(`connectionStatus needs a device object, got ${String(device)}`);
  }
  if (device.error) {
    return { state: "unreachable", ...CONNECTION_COPY.unreachable };
  }
  if (!device.lastSeenAt) {
    return { state: "waiting", ...CONNECTION_COPY.waiting };
  }
  const lastSeen = millis(device.lastSeenAt, "lastSeenAt");
  const age = millis(now, "now") - lastSeen;
  if (age <= CONNECTED_WINDOW_MS) {
    return { state: "connected", ...CONNECTION_COPY.connected };
  }
  return { state: "waiting", ...CONNECTION_COPY.waiting };
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
    return { state: "error", label: "Sync error", detail: String(device.syncError) };
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
export const UPLOAD_LABEL = Object.freeze({
  upToDate: "Up to date",
  oneFile: "Uploading 1 file",
  manyFiles: "Uploading {files} files",
  noCount: "Uploading",
  progress: "{uploaded} of {total} ({percent}%)",
});

/**
 * Upload progress for `drive status` and the page's activity line: how much of
 * the queue has gone up. Zero total means nothing is waiting, which is a
 * complete state ("Up to date"), not an error and not a division by zero.
 * @param {{uploadedBytes: number, totalBytes: number, files?: number}} upload
 */
export function uploadProgress(upload) {
  if (typeof upload !== "object" || upload === null) {
    throw new TypeError(`uploadProgress needs an upload object, got ${String(upload)}`);
  }
  const { uploadedBytes, totalBytes } = upload;
  if (!Number.isFinite(uploadedBytes) || uploadedBytes < 0) {
    throw new TypeError(`uploadedBytes must be 0 or more, got ${uploadedBytes}`);
  }
  if (!Number.isFinite(totalBytes) || totalBytes < 0) {
    throw new TypeError(`totalBytes must be 0 or more, got ${totalBytes}`);
  }
  if (totalBytes === 0) {
    return { percent: 100, label: UPLOAD_LABEL.upToDate };
  }
  if (uploadedBytes > totalBytes) {
    throw new RangeError(
      `uploadedBytes (${uploadedBytes}) cannot pass totalBytes (${totalBytes})`,
    );
  }
  const percent = Math.round((uploadedBytes / totalBytes) * 100);
  // `files` is optional on the payload, so it is read into a local: the count
  // is null unless it is a positive integer, and the label below switches on
  // that null rather than on a missing field.
  const count = upload.files;
  const files = typeof count === "number" && Number.isInteger(count) && count > 0 ? count : null;
  const head =
    files === null
      ? UPLOAD_LABEL.noCount
      : files === 1
        ? UPLOAD_LABEL.oneFile
        : UPLOAD_LABEL.manyFiles.replace("{files}", String(files));
  const detail = UPLOAD_LABEL.progress
    .replace("{uploaded}", formatBytes(uploadedBytes))
    .replace("{total}", formatBytes(totalBytes))
    .replace("{percent}", String(percent));
  return { percent, label: `${head}: ${detail}` };
}

const STATUS_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * The signed-in account a request carries, or null when the request is signed
 * out (build step 9, drive#10). The session is a cookie the sign-in screen
 * mints and the account store validates: `POST /api/signin` proves an address
 * with a one-time code and hands back a session token, and every account route
 * is scoped to the account that token names.
 *
 * A cookie the browser chose is not a session: the token is looked up by its
 * SHA-256 digest in the store that minted it, so a made-up value, a forgotten
 * one and an expired one all answer null, and a request that cannot prove an
 * account never reads one's files (issue #45, north star: Safe).
 *
 * It is async because validating a token is a digest, and a digest is async.
 * Every caller awaits it, so the swap point has exactly one shape: an account
 * or null, never a promise of one.
 * @param {Request} request
 * @param {{accountForSession: (token: string|null) => Promise<{id: string, name: string, email: string}|null>}} store
 * @returns {Promise<{id: string, name: string, email: string}|null>}
 */
export async function signedInAccount(request, store) {
  const token = readSessionCookie(request);
  if (token === null) {
    // No session presented: signed out, which is the honest answer.
    return null;
  }
  if (!store) {
    // A cookie is presented but no store is bound to validate it, so it proves
    // nothing and stays signed out rather than trusting a value the browser
    // chose. This is the same closed door the sign-in route takes, and it is
    // what a deployment with no accounts store answers.
    return null;
  }
  return store.accountForSession(token);
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
 * The account is a required argument and never read from a request that
 * cannot prove one (issue #45, north star: Safe): `signedInAccount()` is null
 * for every caller until the sign-in flow lands, so the endpoint answers 401
 * and the message table's `unauthorized` words, never device data. The 401 is
 * shared with the other account routes through unauthorizedResponse() above
 * (drive issue #73).
 * @param {Request} request
 * @param {{id: string, name: string}|null} account the signed-in account, or null when signed out
 */
export function handleFirstRunStatusRequest(request, account) {
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
  return new Response(
    JSON.stringify({ state: "waiting", devices: [] }),
    { status: 200, headers: STATUS_HEADERS },
  );
}

/**
 * Bytes as a person reads them: one decimal under 10, none above, so a queue
 * of 1.2 GB and a queue of 12 GB both stay one short line.
 * @param {number} bytes
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new TypeError(`formatBytes needs 0 or more bytes, got ${bytes}`);
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const shown = unit === 0 ? String(value) : value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${shown} ${units[unit]}`;
}
