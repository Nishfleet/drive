// Agent undo: the one-click rewind (drive issue #13, build step 11's undo
// half). "Make 'let an AI loose on your files, undo it in one click' a
// headline feature."
//
// A rewind is a branch discarded, and nothing here re-does the work
// src/branches.js already does. That module owns the branch lifecycle: the
// server-side copy, the snapshot, the diff, the approve, and the discard that
// removes an agent's copy and leaves the original untouched. The planner for
// this issue was explicit about the risk — "if rewind data doesn't exist, file
// the gap rather than invent a parallel mechanism" — and it does exist: the
// snapshot is the exact set of files the agent changed, and `discardBranch` is
// the exact one call that throws that work away. So a rewind is that call, plus
// the three things the issue asks for around it:
//
//   1. The screen shows what the agent changed before anything is touched, so
//      the button is a decision and not a leap of faith. The list is the
//      branch's own live diff (src/branches.js `diffBranch`), so it cannot
//      drift from what a discard would actually remove.
//   2. The 30-day window, and it is enforced on the server rather than by
//      hiding a button: a branch older than the window answers that it cannot
//      be rewound, so a caller who ignores the page cannot rewind it either.
//      The window is the drive's own (core/files.js RECENTLY_DELETED_DAYS, the
//      same 30 days the 30-day undo promises), read from there so the two
//      cannot disagree about how long a rewind lasts.
//   3. Who changed what, from the same row the rewind reads: the key on the
//      branch is who made the change, and the same value answers the activity
//      list's "changed by <agent or person>" (issue #13's third comment, "same
//      log the undo reads; no second store").
//
// The route is /api/rewind* behind the same account gate as every other read
// that names files (src/index.js `signedInAccount()`), and every read and write
// is scoped to the signed-in account's own rows and prefix, so one account can
// never read or rewind another's branch — the same isolation the branches
// module already has, and the gate test/account-gate.test.mjs walks.

import { RECENTLY_DELETED_DAYS } from "../core/files.js";
import { json } from "../core/http.js";
import { failureMessage } from "../core/messages.js";
import { unauthorizedResponse } from "../core/status.js";
import {
  diffBranch,
  discardBranch,
  listBranches,
  readSnapshot,
  readSnapshotObject,
  resumeBranchJob,
} from "./branches.js";

/** The route family the rewind screen and the CLI read. */
export const REWIND_ENDPOINT = "/api/rewind";

/** How long a rewind stays available, in days. Read from the drive's own
 * 30-day undo window (core/files.js) rather than declared here, so the screen's
 * promise and Recently deleted's promise are the same number. */
export const REWIND_WINDOW_DAYS = RECENTLY_DELETED_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string} message
 * @param {number} status
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function plain(message, status, headers = {}) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

// rewind.js used to read a JSON body from the rewind routes; nothing has wired
// one since the rewind screen moved its input to the query string, and
// src/branches.js owns the reader for the one route that still takes a body.
// Removed by the drive#92 lint pass rather than renamed: a linter-clean unused
// function is still unused, and the note is here so the next reader stops
// looking for the helper they half remember.

/**
 * What a rewind of this branch would undo, as the screen shows it: the files
 * the agent added, changed and removed, and whether the window still allows
 * it. The file list is the branch's own live diff, so the screen's promise and
 * the discard's effect are the same computation, read at the same moment — a
 * screen cannot promise three files and a rewind throw away five.
 *
 * `changedBy` is the key on the branch row (issue #13's third comment), so the
 * screen says whose work this is and the activity list reads the same value.
 *
 * The window is decided here and not only in the page: a branch whose age is
 * past the window reports `canRewind: false` and the route below refuses the
 * rewind, so the limit is the server's and not a hidden button.
 *
 * @typedef {{name: string, sourcePrefix: string, state: string, changedBy:
 *   string, createdAt: string, ageDays: number, windowDays: number,
 *   restorableUntil: string, canRewind: boolean,
 *   unavailableReason: "window-closed"|"already-closed"|null,
 *   files: {added: string[], changed: string[], removed: string[], count: number},
 *   progress: {kind: string, done: number, total: number}}} RewindPreview
 *
 * @param {import("./branches.js").FileStore} store a scoped store
 * @param {import("./branches.js").Branch & {changed: number}} branch a branch row as `listBranches` returns
 * @param {number} now epoch milliseconds, injected so the tests pin the clock
 * @param {import("./branches.js").SnapshotStore} snapshots the KV snapshot store;
 *   required because the leftover column is no longer a source (drive#329)
 * @returns {Promise<RewindPreview>}
 */
export async function rewindPreview(store, branch, now, snapshots) {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError(`rewindPreview needs a clock, got ${String(now)}`);
  }
  if (!snapshots) {
    throw new TypeError("rewindPreview needs the branch snapshot store");
  }
  const createdAt = Date.parse(branch.createdAt);
  if (!Number.isFinite(createdAt)) {
    throw new TypeError(
      `a branch needs a createdAt a clock can read, got ${String(branch.createdAt)}`,
    );
  }
  const ageDays = Math.max(0, (now - createdAt) / DAY_MS);
  const withinWindow = ageDays <= REWIND_WINDOW_DAYS;
  // A closed branch has nothing to undo: its work was already approved into
  // the original or already thrown away, so there is no copy to rewind and the
  // screen says so rather than offering a button that would do nothing.
  const open = branch.state === "open";
  // The diff is the live one, the same read the discard's own listFiles walk
  // covers, so a preview taken a moment before the rewind is the list the
  // rewind acts on. A closed branch still gets its count read from the row so
  // the screen can say "already closed" with a number, without walking a copy
  // that is gone.
  // The branch row from `listBranches` carries a pointer, not the snapshot's
  // JSON (drive#252), so a preview resolves this one branch's snapshot through
  // the same reader every other diff uses before it walks the copy. A closed
  // branch needs none: its count is on the row.
  const diff = open
    ? await diffBranch(store, {
        ...branch,
        snapshot: await readSnapshot(snapshots, branch.snapshotKey),
      })
    : null;
  const files = diff
    ? Object.freeze({
        added: diff.added,
        changed: diff.changed,
        removed: diff.removed,
        count: diff.added.length + diff.changed.length + diff.removed.length,
      })
    : Object.freeze({ added: [], changed: [], removed: [], count: branch.changed ?? 0 });
  return Object.freeze({
    name: branch.name,
    sourcePrefix: branch.sourcePrefix,
    state: branch.state,
    changedBy: branch.changedBy ?? "",
    createdAt: branch.createdAt,
    ageDays: Math.floor(ageDays),
    windowDays: REWIND_WINDOW_DAYS,
    restorableUntil: new Date(createdAt + REWIND_WINDOW_DAYS * DAY_MS).toISOString(),
    // Two reasons a rewind is unavailable, and the screen says which: the
    // window closed, or the work is already settled. Both are answers, not
    // failures — the screen renders them, so the two reasons stay separate
    // rather than collapsing into one "no".
    canRewind: open && withinWindow,
    unavailableReason: open ? (withinWindow ? null : "window-closed") : "already-closed",
    files,
    progress: {
      kind: branch.jobKind ?? "",
      done: branch.jobDone ?? 0,
      total: branch.jobTotal ?? 0,
    },
  });
}

/**
 * The one read of a branch row the rewind path needs, scoped to the signed-in
 * account exactly as src/branches.js scopes its own. `listBranches` is read
 * rather than a second query, so the rewind cannot reach a branch the list
 * would not show and a branch of another account is "not found", never
 * "forbidden" — the same answer `drive branches` gives.
 * @param {D1Database} db
 * @param {import("./branches.js").SnapshotStore} snapshots the KV snapshot store
 * @param {import("./branches.js").FileStore} store a scoped store
 * @param {{id: string}} account
 * @param {string} name
 */
export async function rewindBranchRow(db, snapshots, store, account, name) {
  const branch = (await listBranches(db, snapshots, store, account)).find(
    (row) => row.name === name,
  );
  return branch ?? null;
}

/**
 * The one-click rewind: the branch's copy is discarded and the original is left
 * exactly as it is. The window is checked first, so a branch past 30 days
 * answers the same sentence the screen showed rather than quietly removing work
 * whose old versions are gone.
 *
 * This is `discardBranch` and nothing else. It is not a re-implementation: the
 * discard already records each file before removing it and already never names
 * the original, and calling it here is what keeps "rewind" and `drive discard`
 * from ever meaning two different things to the same branch.
 *
 * @param {D1Database} db
 * @param {import("./branches.js").SnapshotStore} snapshots the KV snapshot store
 * @param {import("./branches.js").FileStore} store a scoped store
 * @param {{id: string}} account
 * @param {string} name
 * @param {number} now epoch milliseconds
 * @param {{send?: Function, sendBatch?: Function}|null} [queue]
 * @returns {Promise<{error: string, status: number, rewind?: RewindPreview}
 *   |import("./branches.js").BranchJobResult>}
 */
export async function rewindBranch(db, snapshots, store, account, name, now, queue = null) {
  const branch = await rewindBranchRow(db, snapshots, store, account, name);
  if (!branch) {
    return { error: failureMessage("branch-not-found"), status: 404 };
  }
  // A rewind that is already running resumes from its own cursor, before any
  // of the checks below (drive#766). The preview that guards a fresh rewind
  // needs an open branch, so a stuck `rewinding` row answered "that branch is
  // not open" for as long as it was stuck, and there was no way to finish it.
  if (branch.state === "rewinding" && branch.jobKind === "rewind") {
    return resumeBranchJob(db, snapshots, store, account, branch, queue, "rewind");
  }
  if ((await readSnapshotObject(snapshots, branch.snapshotKey)) === null) {
    console.error?.(`rewind refused unavailable snapshot for row ${branch.id}`);
    return { error: failureMessage("unexpected"), status: 500 };
  }
  const preview = await rewindPreview(store, branch, now, snapshots);
  if (!preview.canRewind) {
    const key =
      preview.unavailableReason === "window-closed" ? "rewind-window-closed" : "branch-not-open";
    return { error: failureMessage(key), status: 409, name, rewind: preview };
  }
  const result = await discardBranch(db, snapshots, store, account, name, {
    kind: "rewind",
    queue,
  });
  // `result` is a union; the failure arm is the one carrying a status, and
  // `"error" in result` is its discriminator and narrows the success arm.
  if ("error" in result) {
    return result;
  }
  return {
    name: result.name,
    state: result.state,
    rewound: preview.files.count,
    changedBy: preview.changedBy,
    progress: result.progress,
  };
}

/**
 * The /api/rewind handlers. The account gate is in front of it (src/index.js),
 * so no account is a 401 with no data, before the store or the database is
 * touched. The routes are:
 *
 *   GET  /api/rewind                     every branch that can still be rewound
 *   GET  /api/rewind/<name>              what a rewind of that branch would undo
 *   POST /api/rewind/<name>              do it
 *
 * @param {Request} request
 * @param {D1Database} db
 * @param {import("./branches.js").SnapshotStore|null} snapshots the KV snapshot
 *   store; a request with no namespace is a 503, because the legacy column a
 *   branch could fall back to is gone (drive#329)
 * @param {import("./branches.js").FileStore|null} store a scoped store
 * @param {{id: string}|null} account
 * @param {() => number} now
 * @param {{send?: Function, sendBatch?: Function}|null} [queue]
 */
export async function handleRewindRequest(
  request,
  db,
  snapshots,
  store,
  account,
  now = () => Date.now(),
  queue = null,
) {
  if (!account) {
    return unauthorizedResponse();
  }
  if (!db || !store) {
    return json({ error: failureMessage("unexpected") }, 503);
  }
  if (!snapshots) {
    // A rewind names the files it would undo by diffing against the branch's
    // snapshot, and that snapshot has exactly one source now, so a missing
    // namespace is the "a dependency the drive cannot serve without" answer and
    // not a rewind that reports nothing changed.
    console.error?.("rewind: BRANCH_SNAPSHOTS is not bound");
    return json({ error: failureMessage("storage-down") }, 503);
  }
  const url = new URL(request.url);
  const rest = url.pathname.slice(REWIND_ENDPOINT.length).replace(/\/$/, "");
  const at = now();
  if (rest === "") {
    if (request.method !== "GET") {
      return plain("Method not allowed. GET the branches you can rewind.", 405, {
        allow: "GET",
      });
    }
    // The list is built from the same previews the single-branch read returns,
    // so the screen's list and its detail cannot disagree about what a rewind
    // would undo or whether one is still possible.
    const previews = [];
    for (const branch of await listBranches(db, snapshots, store, account)) {
      previews.push(await rewindPreview(store, branch, at, snapshots));
    }
    return json({ rewinds: previews });
  }
  let name;
  try {
    name = decodeURIComponent(rest.replace(/^\//, ""));
  } catch {
    return json({ error: "That branch name is not valid." }, 400);
  }
  if (name === "") {
    return json({ error: "Not found." }, 404);
  }
  const branch = await rewindBranchRow(db, snapshots, store, account, name);
  if (!branch) {
    return json({ error: failureMessage("branch-not-found") }, 404);
  }
  if (request.method === "GET") {
    return json({ rewind: await rewindPreview(store, branch, at, snapshots) });
  }
  if (request.method === "POST") {
    const result = await rewindBranch(db, snapshots, store, account, name, at, queue);
    if ("error" in result) {
      return json(result, result.status);
    }
    return json(result, 202);
  }
  return plain("Method not allowed. GET the rewind, or POST it.", 405, { allow: "GET, POST" });
}
