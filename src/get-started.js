// The first-run page's renderer (drive issue #70). The copy and the arithmetic
// come from src/status.js and src/messages.js — the same source the CLI, the
// api Worker and the tests read — so this page holds no second copy of a
// sentence, a window or a label for anything to drift from.
//
// Two halves, in this order. The top half is pure: module data in, the exact
// strings the page shows out, with no DOM anywhere, so `node --test` can
// import it directly and assert the words without a bundler or a DOM shim.
// The bottom half wires those strings to the page: it builds the markup the
// shell leaves empty and drives the poll. A `<script type="module">` is
// deferred, so the wiring runs after the shell's markup exists.
//
// Every word that reaches the page comes from the module through a builder
// above, and lands with textContent — nothing from a module is ever
// interpolated into innerHTML.
import {
  CONNECTED_WINDOW_MS,
  CONNECTION_COPY,
  EMPTY_STATES,
  FIRST_RUN_STEPS,
  INSTALL_COMMAND,
  POLL_INTERVAL_MS,
  STATUS_ENDPOINT,
  SYNC_ERROR_NOTIFICATION,
  UPLOAD_LABEL,
  syncStatus,
  uploadProgress,
} from "./status.js";

/**
 * The one command a new person runs, as the page shows it.
 * @returns {string}
 */
export function installCommand() {
  return INSTALL_COMMAND;
}

/**
 * The endpoint the page polls: the module's path, not a copy of it.
 * @returns {string}
 */
export function statusEndpoint() {
  return STATUS_ENDPOINT;
}

/**
 * How long the page waits between polls, in milliseconds.
 * @returns {number}
 */
export function pollIntervalMs() {
  return POLL_INTERVAL_MS;
}

/**
 * The connection line for one state: the module's `what` and `next`, in that
 * order, so the live line and the CLI's words are the same words.
 * @param {"waiting"|"connected"|"unreachable"} state
 * @returns {{what: string, next: string}}
 */
export function connectionLine(state) {
  const entry = CONNECTION_COPY[state];
  if (!entry) {
    throw new TypeError(
      `no connection copy for "${state}"; add it to CONNECTION_COPY in src/status.js`,
    );
  }
  return { what: entry.what, next: entry.next };
}

/**
 * Every state the line can show, in the module's order, so the page can
 * render all three arms before the first poll answers.
 * @returns {"waiting"|"connected"|"unreachable"[]}
 */
export function connectionStates() {
  return Object.keys(CONNECTION_COPY);
}

/**
 * The walk-through, one entry per step, in the module's order. The `<h3>` and
 * `<p>` around them are the page's structure; the words are the module's.
 * @returns {{title: string, body: string}[]}
 */
export function stepLines() {
  return FIRST_RUN_STEPS.map((step, index) => {
    if (typeof step.title !== "string" || typeof step.body !== "string") {
      throw new TypeError(
        `step ${index} needs a title and a body, got ${JSON.stringify(step)}`,
      );
    }
    return { title: step.title, body: step.body };
  });
}

/**
 * The empty-state words for one screen, so "nothing here" never stands alone.
 * @param {"devices"|"activity"} screen
 * @returns {{what: string, next: string}}
 */
export function emptyState(screen) {
  const entry = EMPTY_STATES[screen];
  if (!entry) {
    throw new TypeError(
      `no empty state for "${screen}"; add it to EMPTY_STATES in src/status.js`,
    );
  }
  return { what: entry.what, next: entry.next };
}

/**
 * The upload-progress line for a queue, assembled by the module from the
 * module's own fragments, so this page and `drive status` print one line.
 * @param {{uploadedBytes: number, totalBytes: number, files?: number}} upload
 * @returns {string}
 */
export function uploadLine(upload) {
  return uploadProgress(upload).label;
}

/**
 * The upload fragments as the page reads them, one entry per fragment.
 * @returns {Record<string, string>}
 */
export function uploadFragments() {
  return { ...UPLOAD_LABEL };
}

/**
 * The desktop notification's words, the module's, not a second copy.
 * @returns {{title: string, body: string}}
 */
export function syncErrorNotification() {
  return {
    title: SYNC_ERROR_NOTIFICATION.title,
    body: SYNC_ERROR_NOTIFICATION.body,
  };
}

/**
 * One device's sync state, from the module's own table and its own window, so
 * the page's cell cannot read "Synced" for a queue that has been quiet.
 * @param {object} device
 * @returns {{state: string, label: string, detail: string|null}}
 */
export function deviceSyncState(device) {
  return syncStatus(device, Date.now());
}

/**
 * The page's state cell: the label alone, or the label and the detail. The
 * em dash joining them is the page's own punctuation, so it is applied here
 * and never lands in the module's words.
 * @param {{label: string, detail: string|null}} status
 * @returns {string}
 */
export function stateCellText(status) {
  if (!status || typeof status.label !== "string") {
    throw new TypeError(`stateCellText needs { label, detail }, got ${JSON.stringify(status)}`);
  }
  if (status.detail === null || status.detail === undefined) {
    return status.label;
  }
  return `${status.label} — ${status.detail}`;
}

// ---- The bottom half: the page wiring the builders above. ----

// Every element the wiring touches, named once. A missing element is a real
// error: `required()` throws rather than letting the page half-render, because
// a blank section is the drift this change exists to remove.
function required(id) {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`the first-run page shell is missing #${id}`);
  }
  return el;
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (text) {
    el.textContent = text;
  }
  return el;
}

// The shell ships the three steps' list empty and the two empty states and the
// live line with no text: the words arrive from the module here, so the HTML
// carries structure and src/status.js carries copy and there is no third copy
// to keep in step with either.
function renderSteps() {
  const list = required("steps");
  const items = stepLines().map((step) => {
    const li = document.createElement("li");
    li.appendChild(element("h3", null, step.title));
    li.appendChild(element("p", null, step.body));
    return li;
  });
  list.replaceChildren(...items);
}

function renderEmptyStates() {
  for (const [id, screen] of [
    ["devices-empty", "devices"],
    ["activity-empty", "activity"],
  ]) {
    const { what, next } = emptyState(screen);
    required(id).replaceChildren(element("p", "what", what), element("p", "next", next));
  }
}

function renderCommand() {
  required("install-command").textContent = installCommand();
}

// The live line: all three arms are rendered up front, so a `say()` is a
// switch between text that is already on the page, never a lookup that can
// come back empty and leave a blank line.
function renderConnection() {
  const host = required("connection");
  const lines = connectionStates().map((state) => {
    const { what, next } = connectionLine(state);
    const line = element("div", "line");
    line.dataset.state = state;
    line.appendChild(element("p", "what", what));
    line.appendChild(element("p", "next", next));
    return line;
  });
  host.replaceChildren(...lines);
  showConnection("waiting");
}

function showConnection(state) {
  const host = required("connection");
  const current = host.querySelector(`.line[data-state="${state}"]`);
  if (current === null) {
    throw new TypeError(`the page rendered no line for the "${state}" state`);
  }
  host.dataset.state = state;
  for (const line of host.children) {
    // `hidden` on the other two, never display:none by hand: [hidden] is what
    // a reader agent and the UA stylesheet already honour.
    line.toggleAttribute("hidden", line !== current);
  }
}

// The age of a timestamp, or null when it cannot be read. A device row that
// carries an unreadable date is shown as "No syncs yet" rather than as
// "NaN": the row is a report, and the poll's own failure is the page's
// `unreachable` state, not a device's.
function ageMs(value) {
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) {
    return null;
  }
  return Date.now() - time;
}

function lastSyncText(device) {
  if (!device.lastSeenAt && !device.lastSyncAt) {
    return "";
  }
  const time = new Date(device.lastSyncAt);
  if (Number.isNaN(time.getTime())) {
    return "";
  }
  return time.toLocaleString();
}

function deviceRow(device) {
  const sync = deviceSyncState(device);
  const tr = document.createElement("tr");
  const cells = [
    element("td", null, device.name || "This Mac"),
    element("td", null, device.kind || "device"),
    element("td", null, lastSyncText(device)),
  ];
  const stateCell = element("td", "state", stateCellText(sync));
  stateCell.dataset.state = sync.state;
  cells.push(stateCell);
  tr.replaceChildren(...cells);
  return tr;
}

// One desktop notification per sync error, not one per poll. The error is
// already on the page; the notification is for the tab you are not looking at.
const notified = new Set();

function notifySyncError(device) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }
  const key = String(device.id || device.name);
  if (notified.has(key)) {
    return;
  }
  notified.add(key);
  const { title, body } = syncErrorNotification();
  new Notification(title, { body });
}

// Ask for desktop notifications the first time an error appears on the page,
// never before: the permission prompt is not the first thing a new person
// meets. Declined or dismissed is not a failure — the error already shows on
// the page, so there is nothing to retry.
function maybeAskToNotify(devices) {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "default" ||
    !devices.some((device) => Boolean(device.syncError))
  ) {
    return;
  }
  Notification.requestPermission().then((permission) => {
    if (permission !== "granted") {
      // The error already shows on the page; nothing to retry.
      return;
    }
  });
}

function render(payload) {
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  const connected = devices.some((device) => {
    const age = ageMs(device.lastSeenAt);
    return age !== null && age <= CONNECTED_WINDOW_MS;
  });

  required("devices-body").replaceChildren(...devices.map(deviceRow));
  const table = required("devices");
  const devicesEmpty = required("devices-empty");
  const activityEmpty = required("activity-empty");
  const activityProgress = required("activity-progress");
  const activityProgressLabel = required("activity-progress-label");
  table.hidden = devices.length === 0;
  devicesEmpty.hidden = devices.length > 0;
  const synced = devices.some((device) => Boolean(device.lastSyncAt));
  activityEmpty.hidden = synced || Boolean(payload.upload);
  activityProgress.hidden = !payload.upload;
  if (payload.upload) {
    activityProgressLabel.textContent = uploadLine(payload.upload);
  }

  for (const device of devices) {
    if (device.syncError) {
      notifySyncError(device);
    }
  }
  maybeAskToNotify(devices);

  if (connected || payload.state === "connected") {
    showConnection("connected");
    // Nothing left to watch: the page is done and stops asking.
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    return;
  }
  showConnection("waiting");
}

let timer = null;

async function poll() {
  let response;
  try {
    response = await fetch(statusEndpoint(), {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    showConnection("unreachable");
    return;
  }
  if (!response.ok) {
    // 401 is the account gate (drive issue #45): this browser has no signed-in
    // account yet, which on this page is exactly the waiting state — the Mac
    // has not signed in — and the words on the line name the real next step.
    // It is never "unreachable": the service answered. Any other status is.
    showConnection(response.status === 401 ? "waiting" : "unreachable");
    return;
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    showConnection("unreachable");
    return;
  }
  if (typeof payload !== "object" || payload === null) {
    showConnection("unreachable");
    return;
  }
  render(payload);
}

// Copy has to work on a plain http page too, where the async clipboard API is
// not there, so the textarea path is the one that always works. Either way the
// note says what happened, so a failed copy is never silent.
function wireCopyButton() {
  const button = required("copy-command");
  const note = required("copy-note");
  button.addEventListener("click", async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(installCommand());
      } else {
        const scratch = document.createElement("textarea");
        scratch.value = installCommand();
        scratch.setAttribute("readonly", "");
        scratch.style.position = "fixed";
        scratch.style.left = "-9999px";
        document.body.appendChild(scratch);
        scratch.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(scratch);
        if (!copied) {
          throw new Error("copy command rejected");
        }
      }
      note.textContent = "Copied. Paste it into your terminal.";
      button.textContent = "Copied";
    } catch (error) {
      note.textContent = "Could not copy it for you. Select the command and copy it by hand.";
      button.textContent = "Copy";
    }
    window.setTimeout(() => {
      button.textContent = "Copy";
      note.textContent = "";
    }, 4000);
  });
}

function start() {
  renderSteps();
  renderEmptyStates();
  renderCommand();
  renderConnection();
  wireCopyButton();

  poll();
  timer = window.setInterval(poll, pollIntervalMs());
  document.addEventListener("visibilitychange", () => {
    // A tab in the background has the browser's own cadence; check the moment
    // it comes back so the line is never stale on return.
    if (document.visibilityState === "visible" && timer !== null) {
      poll();
    }
  });
}

// The shell loads this file with `<script type="module">`, which runs after
// the document is parsed, so the wiring starts here and the page needs no
// load event of its own. `node --test` imports this same file for its pure
// builders and has no document, so the wiring runs only where the DOM is.
if (typeof document !== "undefined") {
  start();
}
