// Branches (drive issue #8, build step 7): an instant copy of a folder for an
// agent to work in, with its own key limited to that copy, and a way to approve
// the work back into the original or throw it away.
//
// This module is the branch lifecycle as plain logic over two things the drive
// already has:
//
//   * the FileStore (src/files.js), for the copy and for the file listings the
//     diff compares, and
//   * the `branches` table (migration 0003), for the branch's state
//     (`open` / `approved` / `discarded`), and
//   * the snapshot store (a KV namespace, `BRANCH_SNAPSHOTS`, migration 0012),
//     for the `{size, etag, modified}` snapshot taken at branch time — one
//     entry per file, held out of the row so a branch of tens of thousands of
//     files lands (drive#252, the phase 2 of drive#157);
//
// The copy is a server-side copy (`FileStore.copy`): S3's CopyObject on the
// real store, so a branch never streams the bytes through the Worker. The
// snapshot is one entry per file, `{size, etag, modified}` at branch time, so
// an approve can tell a file the agent changed from one the original changed
// under it — the done-when's "an approve where the original changed after
// branching stops and names the file". The snapshot lives in KV, and the row
// carries a pointer to its key and its byte length; a row written before
// migration 0012 has an empty pointer, and `readSnapshot` no longer falls back
// to the legacy `branches.snapshot` column (drive#329), so the only place a
// snapshot lives is the namespace. The namespace is a required binding
// (`BRANCH_SNAPSHOTS` in src/health.js `REQUIRED_BINDINGS`, already on that
// list before this change), so a store is always present and a row with an
// empty pointer reads as empty rather than from a column nothing writes any
// more.
//
// Two rules make that safe:
//
//   * the drive root and the `.branches` folder itself cannot be branched
//     (a copy must never walk into the copy it is making), and
//   * approve re-reads each file it is about to overwrite and records each
//     file it did copy back before the next one, so a failure or a person's
//     edit part-way through stops the run and a retry resumes from where it
//     left off instead of wedging the branch.
//
// The route is /api/branches* (docs/api.md): GET lists an account's branches,
// POST makes one, and GET/POST on /<name> reads the diff, applies it, or
// throws it away. Every route needs the signed-in account, exactly like every
// other drive read that names files (src/index.js gates it with

import {
  approveBranch,
  createBranch,
  discardBranch,
  getBranch,
  listBranches,
} from "./branch-rows.js";
import { diffBranch } from "./branch-snapshots.js";
import { BRANCHES_PATH, scopeStore } from "./files.js";
import { failureMessage } from "./messages.js";
import { unauthorizedResponse } from "./status.js";
export const BRANCHES_ENDPOINT = "/api/branches";
/** The drive path branches live under — taken from files.js so there is one
 * definition of where branches live (the `.branches` folder), not two.
 */
export const BRANCHES_ROOT = BRANCHES_PATH;

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * @param {unknown} body
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

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

/**
 * The body of a POST as an object, or the one sentence to send back. A branch
 * request is a JSON object and nothing else; a form or an array is a 400. The
 * sentence is the table's, so a branch refuses the same request in the same
 * words as the file and sign-in routes (drive#158).
 * @param {Request} request
 */
async function readJsonBody(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: failureMessage("json-object-needed") };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: failureMessage("json-object-needed") };
  }
  return { body };
}

// ---------------------------------------------------------------- the route

/**
 * The /api/branches* handlers. The account gate is in front of it
 * (src/index.js): no account is a 401 with no data, before the store or the
 * database is touched. The routes are:
 *
 *   GET    /api/branches              list this account's branches
 *   POST   /api/branches              {folder, name} — make a branch
 *   GET    /api/branches/<name>       the branch's diff
 *   POST   /api/branches/<name>/approve   copy it back
 *   POST   /api/branches/<name>/discard   throw it away
 *
 * @param {Request} request
 * @param {unknown} db the branches table
 * @param {SnapshotStore|null} snapshots the KV snapshot store; a request with
 *   no namespace is a 503, because the legacy column a branch could fall back
 *   to is gone (drive#329) and the health check already reports the missing
 *   binding by name
 * @param {import("./files.js").FileStore|null} store the shared, unscoped store
 * @param {{id: string, name: string}|null} account the signed-in account
 * @param {() => number} now
 */
export async function handleBranchesRequest(
  request,
  db,
  snapshots,
  store,
  account,
  now = () => Date.now(),
) {
  if (!account) {
    return unauthorizedResponse();
  }
  if (!db || !store) {
    return json({ error: failureMessage("unexpected") }, 503);
  }
  if (!snapshots) {
    // The snapshot is the whole of a branch's diff and there is no second
    // source for it any more, so this is the same "a dependency the drive
    // cannot serve without" answer the 503 above is, not an empty branch list.
    console.error?.("branches: BRANCH_SNAPSHOTS is not bound");
    return json({ error: failureMessage("storage-down") }, 503);
  }
  const database = /** @type {D1Database} */ (db);
  const scoped = scopeStore(store, account);
  const url = new URL(request.url);
  const rest = url.pathname.slice(BRANCHES_ENDPOINT.length).replace(/\/$/, "");
  if (rest === "") {
    if (request.method === "GET") {
      const branches = (await listBranches(database, snapshots, scoped, account)).map(
        ({ snapshot, id, ...summary }) => {
          void snapshot;
          void id;
          return summary;
        },
      );
      return json({ branches });
    }
    if (request.method === "POST") {
      const read = await readJsonBody(request);
      if (read.error) {
        return json({ error: read.error }, 400);
      }
      const result = await createBranch(database, snapshots, scoped, account, read.body, now);
      if (result.error) {
        return json(result, result.status);
      }
      return json({ branch: result }, 201);
    }
    return plain("Method not allowed. GET the list or POST a new branch.", 405, {
      allow: "GET, POST",
    });
  }
  // A branch name is decoded here where a malformed escape is a 400 rather
  // than an uncaught URIError (the same rule the api Worker's router follows,
  // docs/api.md).
  let name;
  const tail = rest.replace(/^\//, "");
  const [rawName, action, ...extra] = tail.split("/");
  // A third segment is a URL this route family does not have (an approve is
  // /api/branches/<name>/approve), never a way to act anyway.
  if (extra.length > 0) {
    return json({ error: failureMessage("branch-path-unknown") }, 404);
  }
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return json({ error: "That branch name is not valid." }, 400);
  }
  if (!action) {
    if (request.method !== "GET") {
      return plain("Method not allowed. GET the branch's diff.", 405, { allow: "GET" });
    }
    const branch = await getBranch(database, snapshots, account, name);
    if (!branch) {
      return json({ error: failureMessage("branch-not-found") }, 404);
    }
    // A closed branch has had its copies applied back (approve) or removed
    // (discard), so diffing its now-empty prefix against the snapshot would
    // report every file as removed — a wrong answer where the honest one is
    // that there is nothing pending. Open branches diff as before; the state
    // is always in the answer so the caller can tell.
    const diff =
      branch.state === "open"
        ? await diffBranch(scoped, branch)
        : { added: [], changed: [], removed: [], sourceChanged: [] };
    return json({
      branch: {
        name,
        sourcePrefix: branch.sourcePrefix,
        state: branch.state,
        changedBy: branch.changedBy,
        snapshotKey: branch.snapshotKey,
        snapshotBytes: branch.snapshotBytes,
      },
      diff,
    });
  }
  if (action === "approve" || action === "discard") {
    if (request.method !== "POST") {
      return plain(`Method not allowed. POST the branch to ${action} it.`, 405, {
        allow: "POST",
      });
    }
    const result =
      action === "approve"
        ? await approveBranch(database, snapshots, scoped, account, name)
        : await discardBranch(database, snapshots, scoped, account, name);
    if ("error" in result) {
      return json(result, result.status);
    }
    return json(result);
  }
  return json({ error: "Not found." }, 404);
}

export {
  approveBranch,
  BRANCH_COLUMNS,
  createBranch,
  discardBranch,
  getBranch,
  listBranches,
  removePrefixFiles,
  saveSnapshot,
  toBranch,
} from "./branch-rows.js";
// The snapshot walk and the branches table live in src/branch-snapshots.js
// and src/branch-rows.js now (drive issue #617, no behaviour change); they
// are re-exported from here because this was the one module every importer
// read them from.
export {
  copyFolder,
  createKvSnapshotStore,
  createMemorySnapshotStore,
  diffBranch,
  fileFingerprint,
  fingerprint,
  folderState,
  listFiles,
  parseSnapshotObject,
  readSnapshot,
  readSnapshotObject,
  relativePath,
  sameFile,
  snapshotKey,
} from "./branch-snapshots.js";

/** @typedef {import("./files.js").FileStore} FileStore */
/** @typedef {import("./branch-snapshots.js").Fingerprint} Fingerprint */
/** @typedef {import("./branch-snapshots.js").Branch} Branch */
/** @typedef {import("./branch-snapshots.js").SnapshotStore} SnapshotStore */
