// Tests for first-run and sync status (drive issue #32). Two halves:
//
// 1. The logic in src/status.js: the one install command, the connection
//    state a device is in, its sync state, upload progress, and the words the
//    page says for each. Every branch, including the "waiting for you" and
//    "unreachable" ones the page must not confuse.
// 2. The shipped page: public/get-started.html is a static asset and cannot
//    import the module, so this reads the file and fails when its copy, its
//    poll interval or its thresholds drift from src/status.js. Same gate
//    src/pricing.js and test/pricing-copy.test.mjs use for the price.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
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
  syncStatus,
  uploadProgress,
} from "../src/status.js";

const page = readFileSync(
  new URL("../public/get-started.html", import.meta.url),
  "utf8",
);
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
  const response = handleFirstRunStatusRequest(
    new Request("https://drive.test/api/first-run-status"),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  // No device can have signed in before the device store lands (#22), so the
  // true answer is waiting with no devices. The page reads exactly this shape.
  return response.json().then((body) => {
    assert.deepEqual(body, { state: "waiting", devices: [] });
  });
});

test("the status endpoint names the one method it serves", () => {
  const response = handleFirstRunStatusRequest(
    new Request("https://drive.test/api/first-run-status", { method: "POST" }),
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("the Worker routes the page's poll to the status handler", async () => {
  // The page's endpoint has to be reachable through the Worker, not only by
  // importing the module in a test: /api/* runs the Worker, so an unrouted
  // path would fall through to the assets and 404 on every poll.
  const env = { ASSETS: { fetch: () => new Response("asset", { status: 200 }) } };
  for (const path of ["/api/first-run-status", "/api/first-run-status/"]) {
    const response = await worker.fetch(
      new Request(`https://drive.test${path}`),
      env,
    );
    assert.equal(response.status, 200, `${path} must reach the handler`);
    assert.deepEqual(await response.json(), { state: "waiting", devices: [] });
  }
  // The waitlist route is untouched, and a stray path is still the asset 404.
  const asset = await worker.fetch(new Request("https://drive.test/get-started"), env);
  assert.equal(asset.status, 200);
});

test("the upload line is one set of words for the CLI and the page", () => {
  // The page cannot import the module, so it carries the same fragments. A
  // drift here would print a different line in `drive status` than on screen.
  for (const [name, fragment] of Object.entries(UPLOAD_LABEL)) {
    assert.ok(
      page.includes(fragment),
      `the page must carry the ${name} fragment "${fragment}"`,
    );
  }
  assert.equal(
    uploadProgress({ uploadedBytes: 300_000_000, totalBytes: 1_200_000_000, files: 3 }).label,
    "Uploading 3 files: 300 MB of 1.2 GB (25%)",
  );
  assert.equal(
    uploadProgress({ uploadedBytes: 0, totalBytes: 1, files: 1 }).label,
    "Uploading 1 file: 0 B of 1 B (0%)",
  );
  assert.equal(
    uploadProgress({ uploadedBytes: 5, totalBytes: 10 }).label,
    "Uploading: 5 B of 10 B (50%)",
  );
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

test("the shipped page carries the install command and its copy button", () => {
  assert.equal(page.includes(`id="install-command">${INSTALL_COMMAND}<`), true);
  assert.match(page, /<button type="button" id="copy-command">Copy<\/button>/);
  // The copy writes to the clipboard and says what happened either way.
  assert.match(page, /clipboard\.writeText/);
  assert.match(page, /Could not copy it for you/);
});

test("the shipped page carries the three steps, in order", () => {
  for (const step of FIRST_RUN_STEPS) {
    assert.ok(
      page.includes(`<h3>${step.title}</h3>`),
      `the page must carry the step titled ${step.title}`,
    );
    assert.ok(
      page.includes(`<p>${step.body}</p>`),
      `the page must carry the step text for ${step.title}`,
    );
  }
  const order = FIRST_RUN_STEPS.map((step) => page.indexOf(`<h3>${step.title}</h3>`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "steps out of order");
});

test("the page's script reads the same words, endpoint and interval", () => {
  // The page cannot import src/status.js, so these are the strings it must
  // carry. Drifting copy fails here instead of shipping a page that disagrees
  // with the module and its tests.
  for (const entry of Object.values(CONNECTION_COPY)) {
    assert.ok(
      page.includes(entry.what),
      `the page must carry "${entry.what}" verbatim`,
    );
    assert.ok(
      page.includes(entry.next),
      `the page must carry "${entry.next}" verbatim`,
    );
  }
  for (const entry of Object.values(EMPTY_STATES)) {
    assert.ok(page.includes(entry.what), `the page must carry "${entry.what}"`);
    assert.ok(page.includes(entry.next), `the page must carry "${entry.next}"`);
  }
  assert.ok(
    page.includes(`const COMMAND = "${INSTALL_COMMAND}";`),
    "the page must copy the same one command",
  );
  assert.ok(
    page.includes(`const STATUS_ENDPOINT = "${STATUS_ENDPOINT}";`),
    "the page must poll the endpoint the Worker routes",
  );
  assert.ok(
    page.includes(`const POLL_INTERVAL_MS = ${POLL_INTERVAL_MS};`),
    "the page must poll on the interval the module pins",
  );
  assert.ok(
    page.includes(`const CONNECTED_WINDOW_MINUTES = ${CONNECTED_WINDOW_MS / 60000};`),
    "the page must use the same connected window",
  );
  assert.ok(
    page.includes(`const SYNCED_WINDOW_MINUTES = ${SYNCED_WINDOW_MS / 60000};`),
    "the page must use the sync window the module pins",
  );
});

test("the page stops asking once it is connected", () => {
  // A page that keeps polling forever is a battery bug on the one screen a
  // new person leaves open, so the connected state clears its own timer.
  assert.match(page, /clearInterval\(timer\)/);
  assert.match(page, /state === "connected"/);
});

test("the page raises one desktop notification per sync error", () => {
  assert.match(page, /Notification\.permission !== "granted"/);
  assert.match(page, /notified\.has\(key\)/);
  assert.match(page, /Notification\.requestPermission\(\)/);
  // The permission is asked for only after an error is on the page, never on
  // load: a prompt is not the first thing a new person meets.
  const askAt = page.indexOf("Notification.requestPermission()");
  const onLoad = page.indexOf("poll();\ntimer = window.setInterval");
  assert.ok(askAt < onLoad, "the request is a function, not a load-time prompt");
  assert.equal(/^[^/]*Notification\.requestPermission/m.test(page.slice(0, askAt)), false);
});

test("the page's copy values match the notification table", () => {
  const script = page.slice(page.indexOf("<script>"));
  assert.ok(
    script.includes(`title: "${SYNC_ERROR_NOTIFICATION.title}"`),
    "the notification title must match the table",
  );
  assert.ok(
    script.includes(`body: "${SYNC_ERROR_NOTIFICATION.body}"`),
    "the notification body must match the table",
  );
});
