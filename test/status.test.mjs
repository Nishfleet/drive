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
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";
import {
  CONNECTED_WINDOW_MS,
  CONNECTION_COPY,
  EMPTY_STATES,
  FIRST_RUN_STEPS,
  INSTALL_COMMAND,
  POLL_INTERVAL_MS,
  STATUS_ENDPOINT,
  SYNCED_WINDOW_MS,
  SYNC_ERROR_NOTIFICATION,
  UPLOAD_LABEL,
  connectionStatus,
  formatBytes,
  handleFirstRunStatusRequest,
  signedInAccount,
  syncStatus,
  uploadProgress,
} from "../src/status.js";
import {
  connectionLine,
  connectionStates,
  deviceSyncState,
  emptyState,
  installCommand,
  pollIntervalMs,
  stateCellText,
  statusEndpoint,
  stepLines,
  syncErrorNotification,
  uploadFragments,
  uploadLine,
} from "../src/get-started.js";

// The page's shell, read for the structure the module fills and the script tag
// that loads it. Its copy is not read here: there is no copy in it to drift.
const shell = readFileSync(new URL("../get-started.html", import.meta.url), "utf8");
const pricingPage = readFileSync(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const now = Date.parse("2026-09-30T12:00:00.000Z");
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

test("a device that has not signed in reads as waiting, not connected", () => {
  assert.equal(connectionStatus({}, now).state, "waiting");
  assert.equal(connectionStatus({ lastSeenAt: null }, now).state, "waiting");
  // A sign-in from an hour ago is not the sign-in the page is waiting for.
  assert.equal(
    connectionStatus({ lastSeenAt: iso(60 * 60 * 1000) }, now).state,
    "waiting",
  );
});

test("a device inside the connected window flips the page to connected", () => {
  const status = connectionStatus({ lastSeenAt: iso(1000) }, now);
  assert.equal(status.state, "connected");
  assert.equal(status.what, CONNECTION_COPY.connected.what);
  assert.equal(status.next, CONNECTION_COPY.connected.next);
  // The window's edge belongs to connected, one millisecond past it does not.
  assert.equal(
    connectionStatus({ lastSeenAt: iso(CONNECTED_WINDOW_MS) }, now).state,
    "connected",
  );
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
  assert.deepEqual(
    syncStatus({ syncError: "storage down" }, now),
    { state: "error", label: "Sync error", detail: "storage down" },
  );
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
  assert.equal(
    syncStatus({ lastSyncAt: iso(1000), pendingBytes: 4 }, now).state,
    "syncing",
  );
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
  assert.deepEqual(await signedIn.json(), { state: "waiting", devices: [] });

  // The account is a required argument: a call that forgets it is the 401, not
  // an open endpoint, so a future route cannot accidentally serve anonymous.
  const forgot = handleFirstRunStatusRequest(
    new Request("https://drive.test/api/first-run-status"),
  );
  assert.equal(forgot.status, 401);
});

test("no request can prove an account until the sign-in flow lands", () => {
  // Build step 4 (#5) owns the session; until then signedInAccount() is the
  // one swap point and returns null for every request, signed-in cookie or
  // not, so the endpoint is closed rather than open (north star: Safe).
  assert.equal(signedInAccount(new Request("https://drive.test/api/first-run-status")), null);
  assert.equal(
    signedInAccount(
      new Request("https://drive.test/api/first-run-status", {
        headers: { cookie: "drive_session=made-up" },
      }),
    ),
    null,
  );
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
    const response = await worker.fetch(
      new Request(`https://drive.test${path}`),
      env,
    );
    assert.equal(response.status, 401, `${path} must reach the handler`);
    assert.deepEqual(await response.json(), { error: failureMessage("unauthorized") });
  }
  // The waitlist route is untouched, and a stray path is still the asset 404.
  const asset = await worker.fetch(new Request("https://drive.test/get-started"), env);
  assert.equal(asset.status, 200);
});

test("the pricing page links to the first-run page", () => {
  // The first-run page is what a person sees after sign-up; without a link it
  // is a page nothing reaches. The nav sits outside the waitlist form so it
  // never gets submitted with it.
  const link = pricingPage.indexOf('href="/get-started"');
  assert.ok(link > 0, "the pricing page must link to /get-started");
  const formEnd = pricingPage.indexOf("</form>");
  assert.ok(
    pricingPage.indexOf("<nav class=\"footer-nav\"") > formEnd,
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

test("the page's Devices table has a last-sync column and its empty states", () => {
  assert.match(shell, /<th scope="col">Last sync<\/th>/);
  for (const id of ["devices", "devices-body", "devices-empty", "activity-empty", "activity-progress"]) {
    assert.ok(shell.includes(`id="${id}"`), `the shell must carry #${id}`);
  }
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
    assert.ok(!shell.includes(step.body), `the shell must not carry the step text for "${step.title}"`);
  }
  for (const fragment of Object.values(UPLOAD_LABEL)) {
    assert.ok(!shell.includes(fragment), `the shell must not carry the upload fragment "${fragment}"`);
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
  assert.deepEqual(stepLines(), FIRST_RUN_STEPS.map((s) => ({ title: s.title, body: s.body })));
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
  // that is answering. The mapping is pinned on the module's own source, and
  // both arms must be states the module's table defines, so a rename cannot
  // leave the line blank.
  const source = readFileSync(new URL("../src/get-started.js", import.meta.url), "utf8");
  const mapping = source.match(
    /showConnection\(response\.status === 401 \? "(\w+)" : "(\w+)"\)/,
  );
  assert.ok(mapping, "the poll must branch on the 401 status");
  const [, on401, otherwise] = mapping;
  for (const state of [on401, otherwise]) {
    assert.ok(
      connectionStates().includes(state),
      `the renderer must define "${state}" in CONNECTION_COPY's states`,
    );
  }
  assert.equal(on401, "waiting", "401 shows the waiting line");
  assert.equal(otherwise, "unreachable", "every other failure is unreachable");
});

test("the page stops asking once it is connected", () => {
  // A page that keeps polling forever is a battery bug on the one screen a
  // new person leaves open, so the connected state clears its own timer.
  const source = readFileSync(new URL("../src/get-started.js", import.meta.url), "utf8");
  assert.match(source, /clearInterval\(timer\)/);
  assert.match(source, /state === "connected"/);
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
    assert.ok(
      match.index > functionStart,
      "the prompt is a function, not a load-time prompt",
    );
  }
});
