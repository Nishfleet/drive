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
  FIRST_RUN_COMMAND,
  FIRST_RUN_STEPS,
  INSTALL_LINES,
  POLL_INTERVAL_MS,
  STATUS_ENDPOINT,
  SYNC_ERROR_NOTIFICATION,
  syncStatus,
  UPLOAD_LABEL,
  uploadProgress,
} from "./status.js";
// The pending-close banner is one shared file. The other signed-in pages load
// it with <script type="module" src="/close-banner.js">. This page already
// loads one module, and lighthouserc.json allows only one script resource, so
// the banner ships inside this bundle instead of as a second request.
import "../public/close-banner.js";

/**
 * The one command a new person runs, as the page shows it.
 * @returns {string}
 */
export function installCommand() {
  return FIRST_RUN_COMMAND;
}

/**
 * The install line for each system, in the module's order: one pasted line per
 * OS, above the command, so the page answers "how do I get it" before it asks
 * the reader to paste anything. Each row is checked here rather than trusted,
 * because a row that is not a single line is a row the page cannot render as
 * one pasted line. The rows are an argument with the module's own as the
 * default, so a page reads its table and a test can hand the check a bad row.
 * @param {ReadonlyArray<{os: string, line: string}>} [rows]
 * @returns {{os: string, line: string}[]}
 */
export function installLines(rows = INSTALL_LINES) {
  return rows.map((row, index) => {
    if (typeof row.os !== "string" || row.os.trim() === "") {
      throw new TypeError(
        `install line ${index} needs a named system, got ${JSON.stringify(row.os)}`,
      );
    }
    if (typeof row.line !== "string") {
      throw new TypeError(
        `install line ${index} needs an os and a line, got ${JSON.stringify(row)}`,
      );
    }
    if (/\s/.test(row.line.trim()) === false || /[\r\n]/.test(row.line)) {
      throw new TypeError(
        `install line ${index} must be one pasted line with no line break, got ${JSON.stringify(row.line)}`,
      );
    }
    return { os: row.os, line: row.line };
  });
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
 * @param {unknown} state
 * @returns {{what: string, next: string}}
 */
export function connectionLine(state) {
  const entry =
    typeof state === "string" && Object.hasOwn(CONNECTION_COPY, state)
      ? CONNECTION_COPY[/** @type {keyof typeof CONNECTION_COPY} */ (state)]
      : undefined;
  if (!entry) {
    throw new TypeError(
      `no connection copy for "${String(state)}"; add it to CONNECTION_COPY in src/status.js`,
    );
  }
  return { what: entry.what, next: entry.next };
}

/**
 * Every state the line can show, in the module's order, so the page can
 * render all three arms before the first poll answers.
 * @returns {Array<"waiting"|"connected"|"unreachable">}
 */
export function connectionStates() {
  // The keys are the module's own three states; the annotation is the union
  // the rest of the page switches on, which the page and this list must agree
  // on or a rendered line would have no arm to show.
  return /** @type {Array<"waiting"|"connected"|"unreachable">} */ (Object.keys(CONNECTION_COPY));
}

/**
 * The walk-through, one entry per step, in the module's order. The `<h3>` and
 * `<p>` around them are the page's structure; the words are the module's.
 * @returns {{title: string, body: string}[]}
 */
export function stepLines() {
  return FIRST_RUN_STEPS.map((step, index) => {
    if (typeof step.title !== "string" || typeof step.body !== "string") {
      throw new TypeError(`step ${index} needs a title and a body, got ${JSON.stringify(step)}`);
    }
    return { title: step.title, body: step.body };
  });
}

/**
 * The empty-state words for one screen, so "nothing here" never stands alone.
 * @param {unknown} screen
 * @returns {{what: string, next: string}}
 */
export function emptyState(screen) {
  const entry =
    typeof screen === "string" && Object.hasOwn(EMPTY_STATES, screen)
      ? EMPTY_STATES[/** @type {keyof typeof EMPTY_STATES} */ (screen)]
      : undefined;
  if (!entry) {
    throw new TypeError(
      `no empty state for "${String(screen)}"; add it to EMPTY_STATES in src/status.js`,
    );
  }
  return { what: entry.what, next: entry.next };
}

/**
 * The upload-progress line for a queue, assembled by the module from the
 * module's own fragments, so this page and `drive status` print one line.
 * @param {{uploadedBytes: number, totalBytes: number, files?: number, paused?: boolean}} upload
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
 * A device as the status poll and the page's rows read it: the fields below
 * name the ones the renderers touch, and the rest of a row is not read here.
 * @typedef {{id?: string, name?: string, kind?: string, lastSyncAt?: string|Date|null, lastSeenAt?: string|Date|undefined, pendingBytes?: number|null, syncError?: string|null}} DeviceRow
 */

/**
 * The whole poll payload, as the page's render() reads it.
 * @typedef {{state?: string, devices?: DeviceRow[], upload?: {uploadedBytes: number, totalBytes: number, files?: number, paused?: boolean}|null}} StatusPayload
 */

/**
 * One device's sync state, from the module's own table and its own window, so
 * the page's cell cannot read "Synced" for a queue that has been quiet.
 * @param {DeviceRow} device
 * @returns {{state: string, label: string, detail: string|null}}
 */
export function deviceSyncState(device) {
  return syncStatus(device, Date.now());
}

/**
 * The page's state cell: the label alone, or the label and the detail. The
 * em dash joining them is the page's own punctuation, so it is applied here
 * and never lands in the module's words.
 * @param {unknown} status
 * @returns {string}
 */
export function stateCellText(status) {
  if (typeof status !== "object" || status === null) {
    throw new TypeError(`stateCellText needs { label, detail }, got ${JSON.stringify(status)}`);
  }
  const cell = /** @type {{label?: unknown, detail?: unknown}} */ (status);
  if (typeof cell.label !== "string") {
    throw new TypeError(`stateCellText needs { label, detail }, got ${JSON.stringify(status)}`);
  }
  if (cell.detail === null || cell.detail === undefined) {
    return cell.label;
  }
  return `${cell.label} — ${cell.detail}`;
}

// The module's words for a device that has never synced, resolved once, so the
// Last-sync column and the State column cannot say two different things.
const NO_SYNC_LABEL = syncStatus({}, 0).label;

/**
 * The age of a timestamp in milliseconds, or null when it cannot be read. A
 * device row that carries an unreadable date is reported, not thrown: the row
 * is a report, and the page's own poll failure is the `unreachable` state,
 * not a device's.
 * @param {string|number|Date|null|undefined} value
 * @param {unknown} now
 * @returns {number|null}
 */
export function ageMs(value, now = Date.now()) {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError(`ageMs needs now as a number, got ${String(now)}`);
  }
  // A Date's own epoch value; Date.parse takes the string form, and an absent
  // value is as unreadable as a broken one: both report the row as unreadable.
  const time =
    typeof value === "number"
      ? value
      : value instanceof Date
        ? value.getTime()
        : value === null || value === undefined
          ? Number.NaN
          : Date.parse(value);
  if (!Number.isFinite(time)) {
    return null;
  }
  return now - time;
}

/**
 * The Last-sync cell's words: the date a device last synced, or the module's
 * own "no syncs yet" label, so a device that has never synced says so rather
 * than showing a blank cell. Unparseable dates take the same label: a row is a
 * report, and the page's own poll failure is the `unreachable` state, not a
 * device's.
 * @param {{lastSyncAt?: string|number|Date|null}} device
 * @returns {string}
 */
export function lastSyncText(device) {
  if (!device.lastSyncAt) {
    return NO_SYNC_LABEL;
  }
  const time = new Date(device.lastSyncAt);
  if (Number.isNaN(time.getTime())) {
    return NO_SYNC_LABEL;
  }
  return time.toLocaleString();
}

/**
 * The connection state a poll response's status code maps to. A 401 is the
 * account gate (issue #45): the browser has no signed-in account yet, which
 * on this page is the waiting state — the Mac has not signed in — and the
 * waiting line names the real next step. It is never `unreachable`: the
 * service answered. Any other non-ok status is.
 * @param {unknown} status
 * @returns {"waiting"|"unreachable"}
 */
export function connectionStateForStatus(status) {
  if (!Number.isInteger(status)) {
    throw new TypeError(`connectionStateForStatus needs a status code, got ${String(status)}`);
  }
  return status === 401 ? "waiting" : "unreachable";
}

/**
 * Whether a poll payload means the Mac has connected: a device signed in
 * inside the module's window, or the service's own `connected` state. The
 * page stops its timer when this is true.
 * @param {unknown} payload
 * @param {number} now
 * @returns {boolean}
 */
export function isConnected(payload, now = Date.now()) {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError(`isConnected needs a payload object, got ${String(payload)}`);
  }
  const body = /** @type {{state?: unknown, devices?: unknown}} */ (payload);
  if (body.state === "connected") {
    return true;
  }
  const devices = Array.isArray(body.devices) ? body.devices : [];
  return devices.some(
    /** @param {DeviceRow} device */
    (device) => {
      const age = ageMs(device.lastSeenAt, now);
      return age !== null && age <= CONNECTED_WINDOW_MS;
    },
  );
}

// ---- The bottom half: the page wiring the builders above. ----

// Every element the wiring touches, named once. A missing element is a real
// error: `required()` throws rather than letting the page half-render, because
// a blank section is the drift this change exists to remove.
/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function required(id) {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`the first-run page shell is missing #${id}`);
  }
  return el;
}

/**
 * @param {string} tag
 * @param {string|null} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
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
  for (const [id, screen] of /** @type {Array<[string, "devices"|"activity"]>} */ ([
    ["devices-empty", "devices"],
    ["activity-empty", "activity"],
  ])) {
    const { what, next } = emptyState(screen);
    required(id).replaceChildren(element("p", "what", what), element("p", "next", next));
  }
}

function renderCommand() {
  required("install-command").textContent = installCommand();
}

// One row per system, each a system name and the single line to paste for it.
// textContent throughout, like every other builder here: nothing from the
// module is ever interpolated into innerHTML.
function renderInstallLines() {
  const rows = installLines().map((row) => {
    const li = document.createElement("li");
    li.appendChild(element("span", "os", row.os));
    li.appendChild(element("code", null, row.line));
    return li;
  });
  required("install-lines").replaceChildren(...rows);
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

/**
 * @param {"waiting"|"connected"|"unreachable"} state
 * @returns {void}
 */
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

/**
 * @param {DeviceRow} device
 * @returns {HTMLTableRowElement}
 */
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

/**
 * @param {DeviceRow} device
 * @returns {void}
 */
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
/**
 * @param {DeviceRow[]} devices
 * @returns {void}
 */
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

/**
 * @param {StatusPayload} payload
 * @returns {void}
 */
function render(payload) {
  const devices = Array.isArray(payload.devices) ? payload.devices : [];

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

  if (isConnected(payload)) {
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

/** @type {number|null} the poll interval, or null once the page is connected */
let timer = null;

async function poll() {
  let response;
  try {
    response = await fetch(statusEndpoint(), {
      headers: { accept: "application/json" },
    });
  } catch (_error) {
    showConnection("unreachable");
    return;
  }
  if (!response.ok) {
    // A 401 is the waiting state, not an unreachable service: the account
    // gate answered, so the service is up. connectionStateForStatus owns the
    // mapping and both arms are states this page renders.
    showConnection(connectionStateForStatus(response.status));
    return;
  }
  let payload;
  try {
    payload = await response.json();
  } catch (_error) {
    showConnection("unreachable");
    return;
  }
  if (typeof payload !== "object" || payload === null) {
    showConnection("unreachable");
    return;
  }
  try {
    render(payload);
  } catch {
    // Every fetch and every body read above is guarded, and so is the render:
    // this poll runs on a timer and on every tab that comes back, so a payload
    // this page cannot draw has one home, and it is the unreachable state the
    // user already knows. A rejection out of here would be an unhandled one.
    showConnection("unreachable");
  }
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
    } catch (_error) {
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
  renderInstallLines();
  renderCommand();
  renderConnection();
  wireCopyButton();

  // poll() owns its own failures: every fetch and every body read is guarded
  // and renders the unreachable state, so it cannot reject. The `void` says
  // that out loud for the linter (drive issue #92) and keeps it true.
  void poll();
  timer = window.setInterval(() => void poll(), pollIntervalMs());
  document.addEventListener("visibilitychange", () => {
    // A tab in the background has the browser's own cadence; check the moment
    // it comes back so the line is never stale on return.
    if (document.visibilityState === "visible" && timer !== null) {
      void poll();
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
