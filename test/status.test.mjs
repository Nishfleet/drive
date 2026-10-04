// Tests for first-run and sync status (drive issue #32). Two halves:
//
// 1. The logic in src/status.js: the one install command, the connection
//    state a device is in, its sync state, upload progress, and the words the
//    page says for each. Every branch, including the "waiting for you" and
//    "unreachable" ones the page must not confuse.
// 2. The first-run page's renderer, src/get-started.js: the page now renders
//    from these modules through it (issue #70), so the copy the page shows is
//    read by calling the builders rather than by grepping a shipped HTML file
//    for a sentence. The old drift tests are gone with the second copy of the
//    words they policed.
//
// The usage page's upload-progress line (drive issue #308) is pinned in
// test/usage.test.mjs, beside the rest of that page: GET /api/usage answers
// with the line the same word table assembles.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ageMs,
  connectionLine,
  connectionStateForStatus,
  connectionStates,
  deviceSyncState,
  emptyState,
  installCommand,
  installLines,
  isConnected,
  lastSyncText,
  pollIntervalMs,
  stateCellText,
  statusEndpoint,
  stepLines,
  syncErrorNotification,
  uploadFragments,
  uploadLine,
} from "../src/get-started.js";
import worker from "../src/index.js";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";
import {
  CONNECTED_WINDOW_MS,
  CONNECTION_COPY,
  connectionStatus,
  EMPTY_STATES,
  FIRST_RUN_STEPS,
  formatBytes,
  handleFirstRunStatusRequest,
  INSTALL_COMMAND,
  INSTALL_LINES,
  POLL_INTERVAL_MS,
  STATUS_ENDPOINT,
  SYNC_ERROR_NOTIFICATION,
  SYNCED_WINDOW_MS,
  signedInAccount,
  syncStatus,
  UPLOAD_LABEL,
  uploadProgress,
} from "../src/status.js";
import { createD1QueueStore, QUEUE_FRESHNESS_SECONDS } from "../workers/api/src/queues.js";
import { createTestAuth, signIn, TEST_SECRET } from "./harness.mjs";

/** The ExportedHandler type makes fetch optional and declares the runtime's
 * three arguments. Tests drive the Worker directly, so one wrapper supplies
 * the no-op execution context the platform would and keeps those facts out
 * of every call site; `worker.fetch` is optional and carries the runtime's
 * strict Request generic, which a `new Request(...)` literal cannot express.
 * @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>}
 */
const workerFetch =
  /** @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );

// The page's shell, read for the structure the module fills and the script tag
// that loads it. Its copy is not read here: there is no copy in it to drift.
const shell = readFileSync(new URL("../get-started.html", import.meta.url), "utf8");
const pricingPage = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const now = Date.parse("2026-09-30T12:00:00.000Z");
/** @param {number} ms */
const iso = (ms) => new Date(now - ms).toISOString();

test("the install command is drive init, and the steps walk through it", () => {
  // build-spec.md "One-command setup": `drive init` signs in, mounts the drive
  // and connects every agent tool it finds. The steps are the walk-through the
  // issue asks for, in order: run, approve, watch it flip.
  assert.equal(INSTALL_COMMAND, "drive init");
  assert.equal(FIRST_RUN_STEPS.length, 3);
  assert.match(FIRST_RUN_STEPS[0].body, /drive init/);
  assert.match(FIRST_RUN_STEPS[1].body, /Approve the code/);
  assert.match(FIRST_RUN_STEPS[2].body, /flips to connected/);
  for (const step of FIRST_RUN_STEPS) {
    assert.equal(typeof step.title, "string");
    assert.ok(step.title.length > 0, "every step needs a title");
    assert.equal(typeof step.body, "string");
    assert.ok(step.body.length > 0, "every step needs a sentence");
  }
});

test("the page leads with one pasted install line per system", () => {
  // drive issue #428: the get-started page and the docs lead with one line per
  // OS, so a new person reads what to paste before they are told where to paste
  // it. macOS first (the page's own subject), then the two Linux package
  // managers, and each row is a single line with no line break in it.
  assert.deepEqual(
    INSTALL_LINES.map((row) => row.os),
    ["macOS", "Linux, Debian or Ubuntu", "Linux, Fedora or RHEL"],
  );
  const systems = new Set();
  for (const row of INSTALL_LINES) {
    assert.ok(row.os.length > 0, "every install row needs the system it is for");
    assert.ok(!systems.has(row.os), `two rows for ${row.os} would be noise`);
    systems.add(row.os);
    assert.doesNotMatch(
      row.line,
      /[\r\n]/,
      `the install line for ${row.os} must be one pasted line`,
    );
    assert.match(
      row.line,
      /^(brew install|sudo apt install|sudo dnf install) \S+$/,
      `the install line for ${row.os} must be one package-manager invocation`,
    );
  }
  // The detail a line cannot carry (the tap, the module path, the Windows
  // installer name) belongs in the docs' "Other ways" section, so no customer
  // page shows an internal name. test/own-words.test.mjs walks the pages; this
  // is the same rule at the source of the page's copy.
  for (const row of INSTALL_LINES) {
    assert.doesNotMatch(row.line, /nishfleet/i, `the install line for ${row.os} must not name us`);
    assert.doesNotMatch(
      row.line,
      /launchd|\/tap\//,
      `the install line for ${row.os} must stay one line`,
    );
  }
});

test("the renderer hands the page one row per system", () => {
  assert.deepEqual(
    installLines(),
    INSTALL_LINES.map((row) => ({ os: row.os, line: row.line })),
  );
});

test("a row without a system name, or a line break in its line, cannot reach the page", () => {
  // The renderer checks each row rather than trusting the module (drive issue
  // #428): a blank os renders an unnamed box, a missing line renders an empty
  // command, and a line break in the line splits one pasted command across two.
  // All three are refused at the check, not on the page.
  assert.throws(
    () => installLines([{ os: "  ", line: "brew install drive" }]),
    /needs a named system/,
  );
  assert.throws(
    () => installLines([{ os: "macOS", line: "brew install\ndrive" }]),
    /must be one pasted line/,
  );
  assert.throws(
    () => installLines([{ os: "macOS", line: /** @type {any} */ (undefined) }]),
    /needs an os and a line/,
  );
  assert.throws(() => installLines([{ os: "macOS", line: "   " }]), /must be one pasted line/);
});

test("a device that has not signed in reads as waiting, not connected", () => {
  assert.equal(connectionStatus({}, now).state, "waiting");
  assert.equal(connectionStatus({ lastSeenAt: null }, now).state, "waiting");
  // A sign-in from an hour ago is not the sign-in the page is waiting for.
  assert.equal(connectionStatus({ lastSeenAt: iso(60 * 60 * 1000) }, now).state, "waiting");
});

test("a device inside the connected window flips the page to connected", () => {
  const status = connectionStatus({ lastSeenAt: iso(1000) }, now);
  assert.equal(status.state, "connected");
  assert.equal(status.what, CONNECTION_COPY.connected.what);
  assert.equal(status.next, CONNECTION_COPY.connected.next);
  // The window's edge belongs to connected, one millisecond past it does not.
  assert.equal(connectionStatus({ lastSeenAt: iso(CONNECTED_WINDOW_MS) }, now).state, "connected");
  assert.equal(
    connectionStatus({ lastSeenAt: iso(CONNECTED_WINDOW_MS + 1) }, now).state,
    "waiting",
  );
});

test("an unreachable service says so instead of blaming the person", () => {
  // The page sets `error` when its own poll fails. Reporting that as
  // "waiting" would tell someone to run the command again for no reason.
  const status = connectionStatus({ error: "fetch failed" }, now);
  assert.equal(status.state, "unreachable");
  assert.equal(status.what, CONNECTION_COPY.unreachable.what);
  assert.match(status.next, /keeps checking/);
});

test("a device date that cannot be read is a real error, not a silent wait", () => {
  assert.throws(() => connectionStatus({ lastSeenAt: "not-a-date" }, now), TypeError);
  assert.throws(() => connectionStatus(null, now), TypeError);
});

test("every connection state carries one what and one next", () => {
  assert.deepEqual(Object.keys(CONNECTION_COPY), ["waiting", "connected", "unreachable"]);
  for (const [name, entry] of Object.entries(CONNECTION_COPY)) {
    assert.equal(typeof entry.what, "string", `${name} needs a what`);
    assert.equal(typeof entry.next, "string", `${name} needs a next`);
    assert.match(entry.what, /\.$/, `${name}'s what is one sentence`);
    assert.match(entry.next, /\.$/, `${name}'s next is one sentence`);
  }
});

test("each sync state is named, with a sync error above everything", () => {
  assert.deepEqual(syncStatus({ syncError: "storage down" }, now), {
    state: "error",
    label: "Sync error",
    detail: "storage down",
  });
  assert.equal(syncStatus({ pendingBytes: 12 }, now).state, "syncing");
  assert.equal(syncStatus({ lastSyncAt: null }, now).state, "never");
  assert.equal(syncStatus({}, now).state, "never");
});

test("'Synced' only stays true inside the sync window", () => {
  const fresh = syncStatus({ lastSyncAt: iso(30 * 1000) }, now);
  assert.deepEqual(fresh, { state: "synced", label: "Synced", detail: null });
  // An hour of quiet is worth saying out loud rather than showing "Synced".
  const quiet = syncStatus({ lastSyncAt: iso(60 * 60 * 1000) }, now);
  assert.equal(quiet.state, "synced");
  assert.equal(quiet.detail, "Quiet for a while");
  assert.equal(
    syncStatus({ lastSyncAt: iso(SYNCED_WINDOW_MS + 1) }, now).detail,
    "Quiet for a while",
  );
  // A pending upload outranks a recent sync: the drive is still working.
  assert.equal(syncStatus({ lastSyncAt: iso(1000), pendingBytes: 4 }, now).state, "syncing");
});

test("upload progress reads as a person reads it", () => {
  assert.equal(
    uploadProgress({ uploadedBytes: 300_000_000, totalBytes: 1_200_000_000, files: 3 }).label,
    "Uploading 3 files: 300 MB of 1.2 GB (25%)",
  );
  assert.equal(
    uploadProgress({ uploadedBytes: 1, totalBytes: 2, files: 1 }).label,
    "Uploading 1 file: 1 B of 2 B (50%)",
  );
  // Nothing queued is complete, not a division by zero.
  assert.deepEqual(uploadProgress({ uploadedBytes: 0, totalBytes: 0 }), {
    percent: 100,
    label: "Up to date",
  });
  assert.equal(uploadProgress({ uploadedBytes: 10, totalBytes: 10 }).percent, 100);
});

test("upload progress rejects nonsense instead of reporting it as done", () => {
  assert.throws(() => uploadProgress({ uploadedBytes: -1, totalBytes: 5 }), TypeError);
  assert.throws(() => uploadProgress({ uploadedBytes: 1, totalBytes: -5 }), TypeError);
  assert.throws(() => uploadProgress({ uploadedBytes: 6, totalBytes: 5 }), RangeError);
  assert.throws(() => uploadProgress(null), TypeError);
  assert.throws(() => formatBytes(-1), TypeError);
});

// A paused queue is the same arithmetic stopped, and it must never read as an
// uploading one (drive issue #100). The page renders this through uploadLine,
// which is the same function `drive status` mirrors.
test("a paused queue says Paused and what is left, not Uploading", () => {
  assert.equal(
    uploadProgress({
      uploadedBytes: 300_000_000,
      totalBytes: 1_200_000_000,
      files: 3,
      paused: true,
    }).label,
    "Paused: 3 files waiting (900 MB left)",
  );
  assert.equal(
    uploadProgress({ uploadedBytes: 0, totalBytes: 60_000_000, files: 1, paused: true }).label,
    "Paused: 1 file waiting (60 MB left)",
  );
  // A queue with no file count still says Paused and what is left.
  assert.equal(
    uploadProgress({ uploadedBytes: 10, totalBytes: 100, paused: true }).label,
    "Paused: 90 B left",
  );
  // Paused with nothing queued is complete, not a division by zero and not a
  // second word for the same state.
  assert.deepEqual(uploadProgress({ uploadedBytes: 0, totalBytes: 0, paused: true }), {
    percent: 100,
    label: "Up to date",
  });
  // The page's line goes through the module's words, so the page shows the
  // pause word (src/get-started.js uploadLine).
  assert.match(
    uploadLine({ uploadedBytes: 0, totalBytes: 1024, files: 1, paused: true }),
    /^Paused/,
  );
  // A caller that always sets paused: false does not pause its own queue.
  assert.equal(
    uploadProgress({ uploadedBytes: 1, totalBytes: 2, files: 1, paused: false }).label,
    "Uploading 1 file: 1 B of 2 B (50%)",
  );
  // The paused and resumed words live in the one table the CLI also mirrors.
  assert.equal(UPLOAD_LABEL.paused, "Paused");
  assert.equal(UPLOAD_LABEL.resumed, "Resumed");
});

test("bytes stay one short line at both ends of the scale", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1_000), "1.0 KB");
  assert.equal(formatBytes(1_234_567_890), "1.2 GB");
  assert.equal(formatBytes(12_345_678_901), "12 GB");
});

test("every empty screen says what to do first", () => {
  // The issue's last bullet. One entry per empty screen this page renders, and
  // both fields are a sentence, so "nothing here" never appears on its own.
  assert.deepEqual(Object.keys(EMPTY_STATES), ["devices", "activity"]);
  for (const [name, entry] of Object.entries(EMPTY_STATES)) {
    assert.match(entry.what, /\.$/, `${name}'s what is one sentence`);
    assert.match(entry.next, /\.$/, `${name}'s next is one sentence`);
    assert.match(entry.next, /drive init|shows up/, `${name}'s next has an action`);
  }
});

test("the desktop notification is one sentence each way", () => {
  assert.match(SYNC_ERROR_NOTIFICATION.title, /sync/i);
  assert.ok(SYNC_ERROR_NOTIFICATION.body.endsWith("."));
  assert.equal(typeof SYNC_ERROR_NOTIFICATION.body, "string");
});

test("the status endpoint answers a signed-out account honestly", () => {
  // The account gate (drive issue #45): without a signed-in account there is
  // no device data to read, so the handler's own answer to a null account is
  // the 401 below. With an account it answers `waiting` with no devices, the
  // same shape the real store returns for an account with no devices yet.
  const response = handleFirstRunStatusRequest(
    new Request("https://drive.test/api/first-run-status"),
    null,
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  // A cookie session, so the challenge names the scheme sign-in mints.
  assert.equal(response.headers.get("www-authenticate"), "Cookie");
  return response.json().then((body) => {
    assert.deepEqual(body, { error: failureMessage("unauthorized") });
    assert.equal("devices" in body, false, "a signed-out poll must not read devices");
  });
});

test("a signed-in account reads waiting, and no device data leaks without one", async () => {
  const account = { id: "1", name: "Your drive" };
  const signedIn = handleFirstRunStatusRequest(
    new Request("https://drive.test/api/first-run-status"),
    account,
  );
  assert.equal(signedIn.status, 200);
  assert.deepEqual(await signedIn.json(), { state: "waiting", devices: [], upload: null });

  // The account is a required argument: a call that forgets it is the 401, not
  // an open endpoint, so a future route cannot accidentally serve anonymous.
  const forgot = handleFirstRunStatusRequest(
    new Request("https://drive.test/api/first-run-status"),
  );
  assert.equal(forgot.status, 401);
});

test("a request can only prove an account through a session Better Auth minted", async () => {
  // The sign-in flow has landed (build step 9, #10), so signedInAccount() is
  // no longer null for every caller — but it is still closed by default. With
  // no auth a cookie proves nothing, and a made-up one proves nothing either:
  // the token is verified against the database that minted it, so a value the
  // browser chose is not a session (north star: Safe).
  assert.equal(await signedInAccount(new Request("https://drive.test/api/first-run-status")), null);
  const madeUp = new Request("https://drive.test/api/first-run-status", {
    headers: { cookie: "__Secure-drive.session_token=made-up" },
  });
  const other = createTestAuth();
  assert.equal(await signedInAccount(madeUp, other.auth), null);
  assert.equal(await signedInAccount(madeUp, null), null, "no auth, no account");

  // The other half: a sign-in link mints a session and the auth holds it, so
  // the cookie the browser carries reads back as an account. The cookie is
  // only a session in the database that minted it — an instance over another
  // database refuses the same value (north star: Safe).
  const made = createTestAuth();
  const { cookie, account } = await signIn(made, "someone@example.com");
  const proved = await signedInAccount(
    new Request("https://drive.test/api/first-run-status", { headers: { cookie } }),
    made.auth,
  );
  assert.ok(proved);
  assert.equal(proved.email, "someone@example.com", "a minted session is an account");
  assert.equal(proved.id, account.id, "the session names the account that signed in");
  assert.equal(
    await signedInAccount(
      new Request("https://drive.test/api/first-run-status", { headers: { cookie } }),
      other.auth,
    ),
    null,
    "a session belongs to the database that minted it",
  );
});

test("the status payload carries the raw queue, the shape the page renders", async () => {
  // Drive issue #308, the first surface. `upload` is the raw queue, not a
  // finished line, because this endpoint feeds the first-run page's renderer,
  // which calls uploadLine() on it (drive issue #100). Today the Worker has no
  // device store, so no device has signed in and nothing is waiting: null is
  // that answer rather than an invented zero-byte queue, and the field is in
  // the payload rather than missing, so the renderer draws it the moment a
  // queue exists. A queue handed in passes through in exactly the shape
  // uploadProgress() accepts, and round-trips to the line the page shows.
  const signedIn = handleFirstRunStatusRequest(
    new Request("https://drive.test/api/first-run-status"),
    { id: "1", name: "Your drive" },
  );
  const body = await signedIn.json();
  assert.deepEqual(Object.keys(body), ["state", "devices", "upload"]);
  assert.equal(body.upload, null);

  const queue = { uploadedBytes: 300_000_000, totalBytes: 1_200_000_000, files: 3 };
  const carrying = await handleFirstRunStatusRequest(
    new Request("https://drive.test/api/first-run-status"),
    { id: "1", name: "Your drive" },
    queue,
  ).json();
  assert.deepEqual(carrying.upload, queue);
  assert.equal(uploadLine(carrying.upload), uploadProgress(queue).label);
  // The page's renderer reads the field under that one name.
  const source = readFileSync(new URL("../src/get-started.js", import.meta.url), "utf8");
  assert.match(source, /payload\.upload/);
});

test("the status endpoint names the one method it serves", () => {
  const response = handleFirstRunStatusRequest(
    new Request("https://drive.test/api/first-run-status", { method: "POST" }),
    { id: "1", name: "Your drive" },
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("the Worker routes the page's poll to the status handler", async () => {
  // The page's endpoint has to be reachable through the Worker, not only by
  // importing the module in a test: /api/* runs the Worker, so an unrouted
  // path would fall through to the assets and 404 on every poll. With no
  // sign-in flow yet the Worker's gate is closed, so the route answers 401.
  const env = { ASSETS: { fetch: () => new Response("asset", { status: 200 }) } };
  for (const path of ["/api/first-run-status", "/api/first-run-status/"]) {
    const response = await workerFetch(new Request(`https://drive.test${path}`), env);
    assert.equal(response.status, 401, `${path} must reach the handler`);
    assert.deepEqual(await response.json(), { error: failureMessage("unauthorized") });
  }
  // The waitlist route is untouched, and a stray path is still the asset 404.
  const asset = await workerFetch(new Request("https://drive.test/get-started"), env);
  assert.equal(asset.status, 200);
});

test("a signed-out person cannot describe or create the starter", async () => {
  // The starter's own page is a public asset, so the route behind it is what
  // protects the drive: the gate answers 401 for both methods, and the asset
  // layer never runs. This is the anonymous-401 proof this route needs, and
  // it walks Hono's real matcher rather than a factory per account-owning
  // route, so a new route that skips the gate fails here.
  const describe = await workerFetch(new Request("https://drive.test/api/starter"), {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
  });
  assert.equal(describe.status, 401, "a signed-out describe answers 401");
  assert.deepEqual(await describe.json(), { error: failureMessage("unauthorized") });

  const create = await workerFetch(
    new Request("https://drive.test/api/starter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create" }),
    }),
    { ASSETS: { fetch: () => new Response("asset", { status: 200 }) } },
  );
  assert.equal(create.status, 401, "a signed-out create answers 401");
  assert.deepEqual(await create.json(), { error: failureMessage("unauthorized") });
});

test("the pricing page links to the first-run page", () => {
  // The first-run page is what a person sees after sign-up; without a link it
  // is a page nothing reaches. The nav sits outside the waitlist form so it
  // never gets submitted with it.
  const link = pricingPage.indexOf('href="/get-started"');
  assert.ok(link > 0, "the pricing page must link to /get-started");
  const formEnd = pricingPage.indexOf("</form>");
  assert.ok(
    pricingPage.indexOf('<nav class="footer-nav"') > formEnd,
    "the get-started link must sit outside the waitlist form",
  );
});

test("the page's state cell shows the module's own sync state and words", () => {
  // The renderer calls syncStatus itself (deviceSyncState), so the page and
  // the CLI cannot name a state two ways. A fresh sync is "Synced"; an hour
  // of quiet adds the module's detail; an error keeps the device's text.
  assert.deepEqual(deviceSyncState({ syncError: "storage down" }), {
    state: "error",
    label: "Sync error",
    detail: "storage down",
  });
  assert.deepEqual(deviceSyncState({ pendingBytes: 3 }), {
    state: "syncing",
    label: "Uploading",
    detail: null,
  });
  assert.deepEqual(deviceSyncState({}), {
    state: "never",
    label: "No syncs yet",
    detail: null,
  });
  assert.deepEqual(deviceSyncState({ lastSyncAt: new Date(Date.now() - 30_000).toISOString() }), {
    state: "synced",
    label: "Synced",
    detail: null,
  });
  assert.equal(
    deviceSyncState({ lastSyncAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }).detail,
    "Quiet for a while",
  );
  // The cell text is the module's label, and only the join is the page's.
  assert.equal(
    stateCellText(deviceSyncState({ syncError: "storage down" })),
    "Sync error — storage down",
  );
  assert.equal(
    stateCellText(deviceSyncState({ lastSyncAt: new Date(Date.now() - 30_000).toISOString() })),
    "Synced",
  );
  assert.throws(() => stateCellText({ detail: "x" }), TypeError);
});

test("an unreadable device date is reported, never shown as a number", () => {
  // The row's age helper: null for a date the page cannot read, so the caller
  // reports the device rather than rendering NaN. A non-finite `now` is a
  // programmer error and throws, like every other builder here.
  assert.equal(ageMs("not-a-date", now), null);
  assert.equal(ageMs(null, now), null);
  assert.equal(ageMs(undefined, now), null);
  assert.equal(ageMs(new Date(now - 5000), now), 5000);
  assert.equal(ageMs(new Date(now - 5000).toISOString(), now), 5000);
  assert.equal(ageMs(now - 5000, now), 5000);
  assert.throws(() => ageMs("not-a-date", "nope"), TypeError);
});

test("the page's Devices table has a last-sync column and its empty states", () => {
  assert.match(shell, /<th scope="col">Last sync<\/th>/);
  for (const id of [
    "devices",
    "devices-body",
    "devices-empty",
    "activity-empty",
    "activity-progress",
  ]) {
    assert.ok(shell.includes(`id="${id}"`), `the shell must carry #${id}`);
  }
});

// The page's install block is the one place it names a system: the renderer
// fills #install-lines from the module, so a shell that carried one row's
// words itself would be a second copy of the module's words. The shell does
// carry one wordless row per system, because rows that appear only when the
// script runs push the steps below them down after first paint, and that
// layout shift broke the CLS budget (lighthouserc.json) on main.
test("the shell carries one wordless install row per system for the renderer to fill", () => {
  const list = shell.match(/<ul class="install" id="install-lines">([\s\S]*?)<\/ul>/);
  assert.ok(list, "the shell must carry #install-lines");
  const rows = list[1].replace(/<!--[\s\S]*?-->/g, "").match(/<li>[\s\S]*?<\/li>/g) ?? [];
  assert.equal(rows.length, INSTALL_LINES.length, "one placeholder row per system");
  for (const row of rows) {
    assert.equal(
      row,
      '<li><span class="os">&nbsp;</span><code>&nbsp;</code></li>',
      "a placeholder row has the rendered row's shape and no words",
    );
  }
  assert.match(
    readFileSync(new URL("../src/get-started.js", import.meta.url), "utf8"),
    /required\("install-lines"\)\.replaceChildren/,
    "the renderer must fill #install-lines from the module",
  );
});

test("the shell is structure only: the module's copy is not re-declared in it", () => {
  // The old gate policed a second copy of every sentence; this one fails if a
  // second copy is ever reintroduced. The shell carries structure and styles;
  // every word the page shows comes from src/status.js through the renderer.
  assert.ok(
    !shell.includes(INSTALL_COMMAND),
    "the shell must not carry the install command; the renderer writes it from the module",
  );
  for (const entry of Object.values(CONNECTION_COPY)) {
    assert.ok(!shell.includes(entry.what), `the shell must not carry "${entry.what}"`);
    assert.ok(!shell.includes(entry.next), `the shell must not carry "${entry.next}"`);
  }
  for (const entry of Object.values(EMPTY_STATES)) {
    assert.ok(!shell.includes(entry.what), `the shell must not carry "${entry.what}"`);
    assert.ok(!shell.includes(entry.next), `the shell must not carry "${entry.next}"`);
  }
  for (const step of FIRST_RUN_STEPS) {
    assert.ok(
      !shell.includes(step.body),
      `the shell must not carry the step text for "${step.title}"`,
    );
  }
  for (const row of INSTALL_LINES) {
    assert.ok(
      !shell.includes(row.line),
      `the shell must not carry the install line for ${row.os}; the renderer writes it from the module`,
    );
  }
  for (const fragment of Object.values(UPLOAD_LABEL)) {
    assert.ok(
      !shell.includes(fragment),
      `the shell must not carry the upload fragment "${fragment}"`,
    );
  }
  assert.ok(
    !shell.includes(SYNC_ERROR_NOTIFICATION.title),
    "the shell must not carry the notification title",
  );
  // The signed-out words are the API's (issue #45); the page maps a 401 to
  // its waiting line and never carries a copy of them.
  assert.ok(
    !shell.includes(FAILURE_MESSAGES.unauthorized.what),
    "the shell must not carry the API's signed-out words",
  );
});

test("the shell loads the renderer as a module and carries the copy button", () => {
  assert.match(shell, /<script type="module" src="\.\/src\/get-started\.js"><\/script>/);
  assert.match(shell, /<button type="button" id="copy-command">Copy<\/button>/);
  assert.match(shell, /<code id="install-command"><\/code>/);
  assert.match(shell, /<ul class="install" id="install-lines">/);
  assert.match(shell, /<ol class="steps" id="steps">/);
});

test("the renderer's wiring never lets a failed copy pass silently", () => {
  // Read from the module, not the page: this is the one copy of these words.
  const source = readFileSync(new URL("../src/get-started.js", import.meta.url), "utf8");
  assert.match(source, /clipboard\.writeText/);
  assert.match(source, /Could not copy it for you/);
  assert.match(source, /Copied\. Paste it into your terminal\./);
});

test("the renderer shows the module's words: command, steps, states, fragments", () => {
  // These are behavior assertions on the builders the page is built from, so
  // a page sentence can only change by changing the module it comes from.
  assert.equal(installCommand(), INSTALL_COMMAND);
  assert.equal(statusEndpoint(), STATUS_ENDPOINT);
  assert.equal(pollIntervalMs(), POLL_INTERVAL_MS);
  assert.deepEqual(
    stepLines(),
    FIRST_RUN_STEPS.map((s) => ({ title: s.title, body: s.body })),
  );
  assert.deepEqual(emptyState("devices"), EMPTY_STATES.devices);
  assert.deepEqual(emptyState("activity"), EMPTY_STATES.activity);
  assert.deepEqual(syncErrorNotification(), SYNC_ERROR_NOTIFICATION);
  assert.deepEqual(uploadFragments(), UPLOAD_LABEL);
  for (const state of connectionStates()) {
    assert.deepEqual(connectionLine(state), CONNECTION_COPY[state]);
  }
  assert.throws(() => connectionLine("no-such-state"), TypeError);
  assert.throws(() => emptyState("no-such-screen"), TypeError);
});

test("the renderer's upload line is the module's line", () => {
  assert.equal(
    uploadLine({ uploadedBytes: 300_000_000, totalBytes: 1_200_000_000, files: 3 }),
    uploadProgress({ uploadedBytes: 300_000_000, totalBytes: 1_200_000_000, files: 3 }).label,
  );
  assert.equal(
    uploadLine({ uploadedBytes: 0, totalBytes: 1, files: 1 }),
    "Uploading 1 file: 0 B of 1 B (0%)",
  );
  assert.equal(uploadLine({ uploadedBytes: 5, totalBytes: 10 }), "Uploading: 5 B of 10 B (50%)");
  assert.equal(uploadLine({ uploadedBytes: 0, totalBytes: 0 }), "Up to date");
});

test("a 401 is the waiting line, not an unreachable service", () => {
  // The account gate (issue #45) answers 401 until the sign-in lands, and this
  // page is where the sign-in lands, so a 401 IS the waiting state: the Mac
  // has not signed in, and the waiting line names the real next step.
  // Reporting it as "unreachable" would tell someone to wait on a service
  // that is answering. The mapping is a pure function over the response
  // status, and both arms are states the module's table defines, so a rename
  // cannot leave the line blank.
  assert.equal(connectionStateForStatus(401), "waiting");
  assert.equal(connectionStateForStatus(403), "unreachable");
  assert.equal(connectionStateForStatus(500), "unreachable");
  assert.equal(connectionStateForStatus(503), "unreachable");
  for (const status of [401, 403, 500, 503]) {
    assert.ok(
      connectionStates().includes(connectionStateForStatus(status)),
      `the renderer must define a line for the state a ${status} maps to`,
    );
  }
  assert.throws(() => connectionStateForStatus("401"), TypeError);
  assert.throws(() => connectionStateForStatus(null), TypeError);
});

test("the Last-sync cell says so, never blank, for a device with no sync", () => {
  // The row's date column, distinct from its state column: a device that has
  // never synced takes the module's own "no syncs yet" label, the same words
  // syncStatus reports for the `never` state. A blank cell would read as a
  // missing value rather than a device that has not synced.
  assert.equal(lastSyncText({}), "No syncs yet");
  assert.equal(lastSyncText({ lastSyncAt: null }), "No syncs yet");
  assert.equal(lastSyncText({ lastSyncAt: "not-a-date" }), "No syncs yet");
  // The words are the module's: the same label syncStatus produces, asserted
  // against the module rather than a copy in the renderer.
  assert.equal(lastSyncText({}), syncStatus({}, now).label);
  // A real date renders as a local time, not the module's fallback.
  const shown = lastSyncText({ lastSyncAt: new Date(now) });
  assert.notEqual(shown, "No syncs yet");
  assert.ok(shown.length > 0);
});

test("a signed-in Mac inside the window is connected, and the page stops asking", () => {
  // The decision the page acts on to stop polling, pinned behaviourally, then
  // the one thing about it that is wiring: the connected state clears its own
  // timer, because polling forever is a battery bug on the one screen a new
  // person leaves open.
  const fresh = new Date(now - 1000).toISOString();
  const stale = new Date(now - 60 * 60 * 1000).toISOString();
  assert.equal(isConnected({ state: "waiting", devices: [] }, now), false);
  assert.equal(
    isConnected({ devices: [{ lastSeenAt: fresh }] }, now),
    true,
    "a device inside the connected window flips the page to connected",
  );
  assert.equal(
    isConnected({ devices: [{ lastSeenAt: stale }] }, now),
    false,
    "a sign-in from an hour ago is not the sign-in the page is waiting for",
  );
  assert.equal(
    isConnected({ state: "connected", devices: [] }, now),
    true,
    "the service's own connected state is connected",
  );
  // The window's edge belongs to connected, one millisecond past it does not.
  assert.equal(
    isConnected(
      { devices: [{ lastSeenAt: new Date(now - CONNECTED_WINDOW_MS).toISOString() }] },
      now,
    ),
    true,
  );
  assert.equal(
    isConnected(
      { devices: [{ lastSeenAt: new Date(now - CONNECTED_WINDOW_MS - 1).toISOString() }] },
      now,
    ),
    false,
  );
  assert.throws(() => isConnected(null), TypeError);

  const source = readFileSync(new URL("../src/get-started.js", import.meta.url), "utf8");
  assert.match(source, /clearInterval\(timer\)/);
  assert.match(source, /isConnected\(payload\)/);
});

test("the page raises one desktop notification per sync error", () => {
  const source = readFileSync(new URL("../src/get-started.js", import.meta.url), "utf8");
  assert.match(source, /Notification\.permission !== "granted"/);
  assert.match(source, /notified\.has\(key\)/);
  // The permission is asked for only after an error is on the page, never on
  // load: every request sits inside the maybeAskToNotify function, none at
  // the module's top level.
  const functionStart = source.indexOf("function maybeAskToNotify");
  assert.ok(functionStart > 0, "the renderer must gate its notification prompt");
  for (const match of source.matchAll(/Notification\.requestPermission\(\)/g)) {
    assert.ok(match.index > functionStart, "the prompt is a function, not a load-time prompt");
  }
});

test("the Worker reads a device's reported queue into the status payload", async () => {
  // Drive issue #318 through the Worker's own route, not only through the
  // handler: a device reports its queue to the api Worker (POST /v1/queue) and
  // the first-run page's poll reads it back from the same row. The report is
  // written by the store the route uses, over the real migrations, and the
  // status route is driven through a signed-in session against the real app.
  const made = createTestAuth();
  const { cookie, account } = await signIn(made, "queue@example.com");
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: "https://drive.test",
  };
  // The Worker's own store, reading the wall clock the route reads, so a
  // report written here is live to the poll under test.
  const store = createD1QueueStore(made.db);
  const poll = () =>
    workerFetch(
      new Request("https://drive.test/api/first-run-status", { headers: { cookie } }),
      env,
    );

  // No device has reported yet: the honest null #308 answers.
  const before = await (await poll()).json();
  assert.equal(before.upload, null, "an account whose no device has reported has no queue");

  // One device reports its queue; the poll reads exactly that row.
  const queue = { files: 3, uploadedBytes: 300_000_000, totalBytes: 1_200_000_000, paused: false };
  assert.equal((await store.record(account.id, queue)).stored, true);
  const after = await (await poll()).json();
  assert.deepEqual(after.upload, queue, "the poll did not carry the device's own queue");
  assert.equal(uploadLine(after.upload), uploadProgress(queue).label);
  assert.equal(after.upload.paused, false);

  // A second account's report is never read as this one's.
  assert.equal((await store.record("acct_other", { ...queue, files: 1 })).stored, true);
  const stillThis = await (await poll()).json();
  assert.deepEqual(stillThis.upload, queue, "another account's report replaced this one");

  // A paused queue reads as paused, so the page says the bytes are not leaving
  // rather than showing a stalled "Uploading" count. The line is the word
  // table's own paused line (UPLOAD_LABEL.pausedLine) over the same arithmetic
  // uploadProgress() does, so the page and the CLI cannot spell it two ways.
  await made.db
    .prepare("UPDATE device_queues SET paused = 1 WHERE account_id = ?")
    .bind(account.id)
    .run();
  const paused = await (await poll()).json();
  assert.equal(paused.upload.paused, true);
  assert.ok(
    uploadLine(paused.upload).startsWith(UPLOAD_LABEL.paused),
    `paused line ${uploadLine(paused.upload)} does not lead with the paused word`,
  );
  assert.equal(uploadLine(paused.upload), uploadProgress(paused.upload).label);

  // A report the freshness window has passed reads as no queue to report
  // rather than as a stale one (the issue's staleness bullet). The row's clock
  // is aged directly, because a real mount going away is the only thing that
  // makes a report stale and there is no wall clock to wait out here.
  await made.db
    .prepare("UPDATE device_queues SET reported_at = ? WHERE account_id = ?")
    .bind(Math.floor(Date.now() / 1000) - QUEUE_FRESHNESS_SECONDS - 1, account.id)
    .run();
  const stale = await (await poll()).json();
  assert.equal(
    stale.upload,
    null,
    "a device that has not reported for a while still shows a queue",
  );
});
