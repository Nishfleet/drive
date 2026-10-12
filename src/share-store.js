// Split out of src/share.js (drive#617) to keep it under 800 lines; behaviour is unchanged.

import { sendEmail } from "../core/email-send.js";
import { safeFileName } from "../core/files.js";
import { json } from "../core/http.js";
import { failureMessage } from "../core/messages.js";
import { formatBytes } from "../core/status.js";
import { DAY_MS } from "../core/units.js";
import {
  DEFAULT_LINK_DAYS,
  DIGEST_MIN_INTERVAL_MS,
  folderDisplayName,
  LINK_RETENTION_DAYS,
  linkExpiry,
  REMOVE_CHUNK,
  REQUEST_COLUMNS,
  REQUEST_MAX_FILES,
  REQUEST_TOTAL_MAX_BYTES,
  SHARE_COLUMNS,
  toRequestRecord,
  toShareRecord,
} from "./share.js";

/** @typedef {import("./share.js").ShareRecord} ShareRecord */
/** @typedef {import("./share.js").RequestRecord} RequestRecord */
/** @typedef {import("./share.js").LinkStore} LinkStore */

/**
 * The link store over the customer database: the `shares` and
 * `upload_requests` rows of migrations/drive/0006_share_links.sql, through the
 * same D1 statements and the same `account_id = ?1` scoping the rest of the
 * drive's D1 code uses (src/search.js, src/branches.js). There is one store
 * and one table per record, so a link minted on one Worker instance resolves
 * on any other and survives a deploy (issue #207).
 *
 * The accountId is bound into every owner-facing statement rather than checked
 * by the handler, so a token belonging to another account is not found: the
 * owner route answers the same 404 for "not yours" as for "never existed" and
 * a signed-in account can never turn off another account's link (issue #73's
 * isolation gate). The only statement that does not name an account is the
 * logged-out lookup by token, which is the token being the whole proof.
 *
 * `db` is required: a deployment with no DRIVE_DB cannot stand behind a link
 * (src/health.js keeps the binding on its required list), and a store that
 * quietly answered from a Map is the bug this replaced.
 * @param {D1Database} db
 * @returns {LinkStore}
 */
export function createD1LinkStore(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError(`createD1LinkStore needs a D1 database, got ${String(db)}`);
  }
  /**
   * @param {string} sql
   * @param {unknown[]} values
   */
  const one = async (sql, values) =>
    db
      .prepare(sql)
      .bind(...values)
      .first();
  /**
   * @param {string} sql
   * @param {unknown[]} values
   */
  const many = async (sql, values) => {
    const result = await db
      .prepare(sql)
      .bind(...values)
      .all();
    return result?.results ?? [];
  };

  return {
    shares: {
      async create(record) {
        // A token collision is a 2^128 accident, and the primary key is what
        // makes it visible rather than silently overwriting somebody's link.
        await db
          .prepare(
            `INSERT INTO shares (${SHARE_COLUMNS}) ` +
              "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
          )
          .bind(
            record.token,
            record.accountId,
            record.path,
            record.name,
            record.createdAt,
            record.expiresAt,
            record.revokedAt,
            record.downloadCount,
            record.downloadBytes,
            record.maxDownloadBytes,
            record.etag ?? "",
          )
          .run();
        return { ...record };
      },
      async get(token) {
        const row = await one(`SELECT ${SHARE_COLUMNS} FROM shares WHERE token = ?1`, [token]);
        return row === null || row === undefined ? null : toShareRecord(row);
      },
      async list(accountId) {
        const rows = await many(
          `SELECT ${SHARE_COLUMNS} FROM shares WHERE account_id = ?1 ORDER BY created_at DESC`,
          [accountId],
        );
        return rows.map(toShareRecord);
      },
      async countOpen(accountId, now) {
        const row = await one(
          "SELECT COUNT(*) AS n FROM shares " +
            "WHERE account_id = ?1 AND revoked_at IS NULL AND expires_at > ?2",
          [accountId, now],
        );
        return Number(row?.n ?? 0);
      },
      async revoke(token, accountId, at) {
        // A second revoke is the same answer, and the first time stands: the
        // owner's list must not re-date a revocation that already happened.
        // COALESCE keeps the existing value when the row is already revoked,
        // and the WHERE clause is what makes another account's token a miss.
        // The ?N run in textual ascending order — the new value is in the SET
        // clause, which textually precedes the WHERE — so binding by number
        // (D1) and binding positionally (the repo's node:sqlite test adapter)
        // agree on the same statement.
        const row = await one(
          `UPDATE shares SET revoked_at = COALESCE(revoked_at, ?1) ` +
            "WHERE token = ?2 AND account_id = ?3 " +
            `RETURNING ${SHARE_COLUMNS}`,
          [at, token, accountId],
        );
        return row === null || row === undefined ? null : toShareRecord(row);
      },
      async addDownload(token, bytes) {
        const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
        // The reservation and the per-link byte cap are the same statement
        // (drive issue #549): two concurrent downloads that would together
        // pass the cap cannot both succeed, because the WHERE clause sees the
        // other's increment. A NULL cap is a link minted before the cap
        // existed: it keeps serving. A miss is an unknown token or a full
        // link, and the route refuses both. ?1 and ?3 are the same size, so
        // each placeholder number appears once in textual order for the
        // node:sqlite test adapter (the same rule the upload reservation
        // follows).
        const row = await one(
          "UPDATE shares SET download_count = download_count + 1, " +
            "download_bytes = download_bytes + ?1 " +
            "WHERE token = ?2 AND (max_download_bytes IS NULL OR download_bytes + ?3 <= max_download_bytes) " +
            `RETURNING ${SHARE_COLUMNS}`,
          [size, token, size],
        );
        return row === null || row === undefined ? null : toShareRecord(row);
      },
    },
    requests: {
      async create(record) {
        await db
          .prepare(
            `INSERT INTO upload_requests (${REQUEST_COLUMNS}) ` +
              "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
          )
          .bind(
            record.token,
            record.accountId,
            record.folder,
            record.createdAt,
            record.expiresAt,
            record.revokedAt,
            record.uploadCount,
            record.uploadBytes,
            record.maxBytes,
            record.maxFiles,
            record.digestAt ?? null,
            record.pendingUploads ?? "[]",
            record.malwareNoticeAt ?? null,
          )
          .run();
        return { ...record };
      },
      async get(token) {
        const row = await one(`SELECT ${REQUEST_COLUMNS} FROM upload_requests WHERE token = ?1`, [
          token,
        ]);
        return row === null || row === undefined ? null : toRequestRecord(row);
      },
      async list(accountId) {
        const rows = await many(
          `SELECT ${REQUEST_COLUMNS} FROM upload_requests WHERE account_id = ?1 ORDER BY created_at DESC`,
          [accountId],
        );
        return rows.map(toRequestRecord);
      },
      async countOpen(accountId, now) {
        const row = await one(
          "SELECT COUNT(*) AS n FROM upload_requests " +
            "WHERE account_id = ?1 AND revoked_at IS NULL AND expires_at > ?2",
          [accountId, now],
        );
        return Number(row?.n ?? 0);
      },
      async revoke(token, accountId, at) {
        const row = await one(
          `UPDATE upload_requests SET revoked_at = COALESCE(revoked_at, ?1) ` +
            "WHERE token = ?2 AND account_id = ?3 " +
            `RETURNING ${REQUEST_COLUMNS}`,
          [at, token, accountId],
        );
        return row === null || row === undefined ? null : toRequestRecord(row);
      },
      async addUpload(token, bytes) {
        const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
        // One statement is the reservation: two concurrent uploads that would
        // together pass the link total cannot both succeed, because the
        // WHERE clause sees the other's increment. A miss is a full link,
        // and the handler writes nothing (issue #208).
        // ?1 and ?3 are the same size: D1 binds by number, the node:sqlite
        // test adapter binds positionally after stripping digits, so each
        // placeholder number appears once in textual order (the same rule
        // the revoke statement already follows).
        const row = await one(
          "UPDATE upload_requests SET upload_count = upload_count + 1, " +
            "upload_bytes = upload_bytes + ?1 " +
            "WHERE token = ?2 AND upload_bytes + ?3 <= max_bytes AND upload_count < max_files " +
            `RETURNING ${REQUEST_COLUMNS}`,
          [size, token, size],
        );
        return row === null || row === undefined ? null : toRequestRecord(row);
      },
      async releaseUpload(token, bytes) {
        const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
        const row = await one(
          "UPDATE upload_requests SET upload_count = MAX(upload_count - 1, 0), " +
            "upload_bytes = MAX(upload_bytes - ?1, 0) " +
            "WHERE token = ?2 " +
            `RETURNING ${REQUEST_COLUMNS}`,
          [size, token],
        );
        return row === null || row === undefined ? null : toRequestRecord(row);
      },
      async recordArrival(token, name, bytes) {
        const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
        // The arrival is appended in the same shape the digest reads back
        // (drive issue #684). ?1 is the byte count and ?2 the stored name, in
        // that textual order, so each placeholder number appears once and in
        // ascending order for the node:sqlite test adapter. json_insert's
        // `$[#]` appends, and D1's SQLite carries JSON1, so this is one
        // statement with no read-modify-write race on the row.
        const row = await one(
          "UPDATE upload_requests SET pending_uploads = " +
            "json_insert(pending_uploads, '$[#]', json_object('bytes', ?1, 'name', ?2)) " +
            "WHERE token = ?3 " +
            `RETURNING ${REQUEST_COLUMNS}`,
          [size, safeFileName(name), token],
        );
        return row === null || row === undefined ? null : toRequestRecord(row);
      },
      async markDigestSent(token, at, count) {
        // The clear walks the front of the array in chunks: json_remove's
        // argument list is bounded by SQLITE_MAX_FUNCTION_ARG (127 stock), so
        // a queue deeper than one chunk cannot be handed a single call. The
        // chunks and the stamp go in one D1 batch, which is a transaction, so
        // a failure part-way leaves the whole queue and the old stamp in
        // place, and the next run mails the same list once instead of mailing
        // the half a torn clear left behind.
        //
        // The clear removes only the arrivals the digest actually read,
        // from the front of the array, so an upload accepted during the send
        // window stays queued for the next run instead of being wiped unseen
        // (drive issue #684). json_remove reads the column's old value, unlike
        // a correlated subquery in SET. A count of zero is the drain for a
        // row the digest could not read at all: parseArrivals already decided
        // it holds no arrivals, and json_remove refuses a value that is not
        // JSON, so the drain writes the empty list outright rather than
        // walking the row and failing on it every night.
        const statements = [];
        if (count === 0) {
          statements.push(
            db
              .prepare("UPDATE upload_requests SET pending_uploads = '[]' WHERE token = ?1")
              .bind(token),
          );
        }
        const clearCount = count === 0 ? 0 : Math.max(1, Math.floor(count));
        for (let removed = 0; removed < clearCount; removed += REMOVE_CHUNK) {
          const take = Math.min(REMOVE_CHUNK, clearCount - removed);
          const paths = Array.from({ length: take }, () => "'$[0]'").join(", ");
          statements.push(
            db
              .prepare(
                `UPDATE upload_requests SET pending_uploads = ` +
                  `json_remove(pending_uploads, ${paths}) WHERE token = ?1`,
              )
              .bind(token),
          );
        }
        statements.push(
          db.prepare("UPDATE upload_requests SET digest_at = ?1 WHERE token = ?2").bind(at, token),
        );
        await db.batch(statements);
        const row = await one(`SELECT ${REQUEST_COLUMNS} FROM upload_requests WHERE token = ?1`, [
          token,
        ]);
        return row === null || row === undefined ? null : toRequestRecord(row);
      },
      async listPendingDigests() {
        // Only rows carrying arrivals, so the nightly job walks the links that
        // have something to say and nothing else.
        const rows = await many(
          `SELECT ${REQUEST_COLUMNS} FROM upload_requests ` +
            "WHERE pending_uploads IS NOT NULL AND pending_uploads <> '[]' " +
            "ORDER BY created_at ASC",
          [],
        );
        return rows.map(toRequestRecord);
      },
      async stampMalwareNotice(token, at) {
        // The quiet window's write half (drive issue #826): the time of the
        // last notice actually sent, so the route mails a repeated known-bad
        // refusal only when this stamp is NULL or out of the window. The
        // stamp follows the mail, never the refusal, so an owner address
        // that is missing stays unstamped and the loud log keeps repeating.
        await db
          .prepare("UPDATE upload_requests SET malware_notice_at = ?1 WHERE token = ?2")
          .bind(at, token)
          .run();
      },
    },
  };
}

/**
 * Removes link rows that can never open again and are older than the
 * retention window (drive issue #549): expired and revoked rows are kept 90
 * days so the owner's list still shows what they did, then pruned. A row that
 * is still open is never touched, however old, so pruning cannot close a link
 * a stranger is still holding — the daily job only ever deletes what
 * linkState() already calls expired or revoked.
 *
 * Both tables are pruned in one call, each as one statement. A D1 statement
 * reports the rows it changed in `meta.changes`, so the returned counts are
 * the rows actually removed. The cutoff is computed once from `now`, so both
 * tables and every run agree on the boundary.
 * @param {D1Database} db
 * @param {number} now
 * @returns {Promise<{shares: number, requests: number}>}
 */
export async function purgeStaleLinks(db, now) {
  const cutoff = now - LINK_RETENTION_DAYS * DAY_MS;
  const shares = await db
    .prepare(
      "DELETE FROM shares WHERE (revoked_at IS NOT NULL OR expires_at <= ?1) " +
        "AND COALESCE(revoked_at, expires_at) <= ?2",
    )
    .bind(now, cutoff)
    .run();
  const requests = await db
    .prepare(
      "DELETE FROM upload_requests WHERE (revoked_at IS NOT NULL OR expires_at <= ?1) " +
        "AND COALESCE(revoked_at, expires_at) <= ?2",
    )
    .bind(now, cutoff)
    .run();
  return {
    shares: Number(shares?.meta?.changes ?? 0),
    requests: Number(requests?.meta?.changes ?? 0),
  };
}

/**
 * One arrival queue, as the request row stores it and the digest reads it
 * back. `name` is put through safeFileName, the same cleaner the upload used,
 * so a name in a digest cannot be one the upload route itself would refuse.
 *
 * `rawCount` is the stored array's own length, junk entries included. The
 * digest clears by position from the front of the array, so it must remove
 * rawCount entries to drop the junk ahead of a real arrival — otherwise a
 * junk entry shifts every later name one place and the next night's mail
 * repeats an arrival it already sent (drive issue #684).
 * @param {unknown} raw
 * @returns {{arrivals: Array<{name: string, bytes: number}>, rawCount: number}}
 */
function parseArrivals(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return { arrivals: [], rawCount: 0 };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A row that is not the JSON this store wrote is treated as no arrivals
    // rather than throwing: the digest is a notification, and one malformed
    // row must not stop every other link's mail.
    return { arrivals: [], rawCount: 0 };
  }
  if (!Array.isArray(parsed)) {
    return { arrivals: [], rawCount: 0 };
  }
  const entries = parsed
    .filter((entry) => entry !== null && typeof entry === "object")
    .map((entry) => {
      const e = /** @type {{name?: unknown, bytes?: unknown}} */ (entry);
      const size = Number(e.bytes);
      return {
        name: safeFileName(typeof e.name === "string" ? e.name : ""),
        bytes: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0,
      };
    });
  return { arrivals: entries, rawCount: parsed.length };
}

/**
 * The nightly per-link arrival digest (drive issue #684): one email to a
 * link's owner listing every file that arrived through it since the last
 * digest. `listPendingDigests` returns only rows carrying arrivals, so each
 * run mails each link at most once; `markDigestSent` clears the list and
 * stamps `digest_at` only after the send resolved, so a failed send leaves
 * the arrivals queued for the next run instead of dropping them.
 *
 * "One email per link per day" rests on the schedule and on a stamp, not on
 * the schedule alone: a link whose `digest_at` is younger than
 * DIGEST_MIN_INTERVAL_MS is not mailed even if its queue is not empty. A
 * deployment that ran the shared reconcile trip twice in a day would
 * otherwise mail the same link twice, and the second mail would list the
 * arrivals the first one had not cleared yet.
 *
 * A link whose owner has no address is logged and skipped, like the close
 * cron's no-email rows: it is not an error that should stop the other links'
 * mail. `email` and `mailFrom` are the deployment's own settings; a missing
 * MAIL_FROM is an empty string here and the caller logs it and does not call
 * this function at all, because a digest from a placeholder sender is worse
 * than no digest.
 * @param {D1Database} db
 * @param {{email: unknown, mailFrom: string, owner: (accountId: string) => Promise<{id: string, name?: string, email?: string}|null>, now: number}} input
 * @returns {Promise<{sent: number, skipped: number}>}
 */
export async function sendArrivalDigests(db, input) {
  if (typeof input?.mailFrom !== "string" || input.mailFrom.trim().length === 0) {
    throw new Error("an arrival digest needs the deployment's MAIL_FROM");
  }
  if (typeof input.owner !== "function") {
    throw new TypeError(`an arrival digest needs an owner resolver, got ${String(input.owner)}`);
  }
  const links = createD1LinkStore(db);
  const pending = await links.requests.listPendingDigests();
  let sent = 0;
  let skipped = 0;
  for (const record of pending) {
    // The stamp, not the schedule, is what bounds a link to one mail a day.
    if (record.digestAt !== null && input.now - record.digestAt < DIGEST_MIN_INTERVAL_MS) {
      continue;
    }
    try {
      const queue = parseArrivals(record.pendingUploads);
      if (queue.arrivals.length === 0) {
        // A row the digest query selected (its queue is not the empty
        // literal) but the parse found no arrivals in: malformed JSON, or an
        // array of nulls. It is logged and drained, because nothing but
        // recordArrival ever writes this column back, so re-listing it every
        // night would walk a queue that can never yield a mail. The raw
        // count is cleared, junk entries included, so the drain leaves
        // nothing behind either way.
        console.error(
          `upload digest: the link for account ${record.accountId} has an arrival queue that parses to nothing; clearing it`,
        );
        await links.requests.markDigestSent(record.token, input.now, queue.rawCount);
        skipped += 1;
        continue;
      }
      const owner = await input.owner(record.accountId);
      if (owner === null || typeof owner.email !== "string" || owner.email.trim().length === 0) {
        console.error(
          `upload digest: the link for account ${record.accountId} has arrivals but no owner address`,
        );
        skipped += 1;
        continue;
      }
      await sendEmail(input.email, {
        to: owner.email,
        from: input.mailFrom,
        kind: "upload-arrivals",
        data: {
          ownerName:
            typeof owner.name === "string" && owner.name.length > 0 ? owner.name : owner.email,
          folder: folderDisplayName(record.folder),
          arrivals: queue.arrivals.map((arrival) => ({
            name: arrival.name,
            sizeLabel: formatBytes(arrival.bytes),
          })),
        },
      });
      // Only the arrivals this digest read are cleared, so a drop accepted
      // during the send stays queued for the next run.
      await links.requests.markDigestSent(record.token, input.now, queue.rawCount);
      sent += 1;
    } catch (cause) {
      // One link's read or send must not hold every later link's mail. The
      // arrivals stay queued (markDigestSent only runs after the send), so a
      // transient failure is retried on the next nightly run.
      console.error(
        `upload digest: the link for account ${record.accountId} could not be mailed: ${String(cause)}`,
      );
      skipped += 1;
    }
  }
  return { sent, skipped };
}

// ---------------------------------------------------------------- minting

/**
 * The record for a new share. Kept separate from the handler so a test mints
 * links with a pinned token and clock, and so nothing but the store persists
 * it.
 *
 * @param {{accountId: string, path: string, now: number, token: string, days?: number, maxDownloadBytes?: number|null, etag?: string}} input
 * @returns {ShareRecord}
 */
export function newShareRecord({
  accountId,
  path,
  now,
  token,
  days = DEFAULT_LINK_DAYS,
  maxDownloadBytes = null,
  etag = "",
}) {
  return {
    token,
    accountId,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    createdAt: now,
    expiresAt: linkExpiry(now, days),
    revokedAt: null,
    downloadCount: 0,
    downloadBytes: 0,
    maxDownloadBytes,
    etag,
  };
}

/**
 * The record for a new upload request.
 *
 * @param {{accountId: string, folder: string, now: number, token: string, days?: number, maxBytes?: number, maxFiles?: number}} input
 * @returns {RequestRecord}
 */
export function newRequestRecord({
  accountId,
  folder,
  now,
  token,
  days = DEFAULT_LINK_DAYS,
  maxBytes = REQUEST_TOTAL_MAX_BYTES,
  maxFiles = REQUEST_MAX_FILES,
}) {
  return {
    token,
    accountId,
    folder,
    createdAt: now,
    expiresAt: linkExpiry(now, days),
    revokedAt: null,
    uploadCount: 0,
    uploadBytes: 0,
    maxBytes,
    maxFiles,
    digestAt: null,
    pendingUploads: "[]",
    // A minted link has never been noticed, so the quiet window reads null
    // and the first known-bad refusal mails (drive issue #826).
    malwareNoticeAt: null,
  };
}

// ---------------------------------------------------------------- handlers

/**
 * @param {string} message
 * @param {number} status
 * @param {Record<string, string>} [extraHeaders]
 */
export function plain(message, status, extraHeaders = {}) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

/**
 * @param {string} allowed
 * @param {string} action
 */
export function methodNotAllowed(allowed, action) {
  return plain(`Method not allowed. ${action}`, 405, { allow: allowed });
}

/**
 * The etag a share row stores: quotes and the weak prefix stripped so a
 * later read through the same store compares as one string. An empty
 * result means the store gave nothing to pin, and an old row that never
 * stored one keeps serving by path.
 *
 * @param {string|null|undefined} etag
 * @returns {string}
 */
export function storedShareEtag(etag) {
  if (typeof etag !== "string" || etag.length === 0) {
    return "";
  }
  return etag.replace(/^W\//, "").replace(/"/g, "");
}

/**
 * Whether a minted share's pin disagrees with the live object. An empty
 * minted pin is a row from before the column existed, so it is not a
 * change. A pinned row whose live object reports no etag counts as changed:
 * the link refuses rather than serve bytes it cannot match to the pin.
 *
 * @param {string|null|undefined} minted
 * @param {string|null|undefined} live
 * @returns {boolean}
 */
export function shareContentChanged(minted, live) {
  const pin = storedShareEtag(minted);
  if (pin === "") {
    return false;
  }
  return storedShareEtag(live) !== pin;
}

// A store or storage failure: the cause is logged with the route that hit it
// and never returned. Every share route here is reachable by a logged-out
// stranger holding one token, so an internal message (a binding name, a path,
// a query error) is never a thing to hand back; the caller gets the message
// table's generic words, which is the same answer any unexpected failure in
// the Worker gets (core/messages.js `unexpected`).
/**
 * @param {string} where
 */
export function serverFailure(where) {
  console.error(`drive share: ${where}`);
  return json({ error: failureMessage("unexpected") }, 500);
}

// One cap answer for both public upload routes: the resolver is called with
// the account that minted the token, and a state outside the two is a
// TypeError rather than a page that quietly opens. A caller that forgets the
// cap cannot serve a read-only drive, and a drive that is not at its cap is
// not refused by someone else's.
/**
 * @param {unknown} resolver
 * @param {string} accountId
 */
export async function capStateFor(resolver, accountId) {
  if (typeof resolver !== "function") {
    throw new TypeError(`a cap resolver must be a function, got ${String(resolver)}`);
  }
  const state = await resolver(accountId);
  if (state !== "active" && state !== "read_only") {
    throw new TypeError(`a cap resolver must answer "active" or "read_only", got ${String(state)}`);
  }
  return state;
}

/**
 * The account row that minted a link, read through the deployment's own account
 * resolver (the Better Auth `user` row). The resolver is read in one place so
 * the two reads a route needs — the display name a stranger sees, and the
 * address the notification goes to — cannot drift apart on what a missing,
 * non-function or throwing resolver means: both get null.
 * @param {unknown} resolver
 * @param {string} accountId
 * @param {string} [where] named in the throw log so a drop refusal and a
 *   public-page name lookup cannot be mixed up in the same line
 * @returns {Promise<{name?: unknown, email?: unknown}|null>}
 */
async function ownerRowFor(resolver, accountId, where = "") {
  if (typeof resolver !== "function") {
    return null;
  }
  let owner;
  try {
    owner = await resolver(accountId);
  } catch (cause) {
    console.error(
      where === ""
        ? `drive share: reading a link owner failed: ${String(cause)}`
        : `drive share: reading a link owner failed for ${where}: ${String(cause)}`,
    );
    return null;
  }
  if (owner === null || owner === undefined) {
    return null;
  }
  return /** @type {{name?: unknown, email?: unknown}} */ (owner);
}

/**
 * The display name of the account that minted a link, for the page a stranger
 * opens (drive issue #684). Only the row's own `name` is used: the address
 * is never shown to a stranger holding a link, so an account with no display
 * name leaves the page's owner line hidden. A missing or non-function resolver
 * and a resolver that throws both degrade to the empty string rather than
 * failing the public info route.
 * @param {unknown} resolver
 * @param {string} accountId
 * @returns {Promise<string>}
 */
export async function ownerNameFor(resolver, accountId) {
  const owner = await ownerRowFor(resolver, accountId);
  if (owner === null) {
    return "";
  }
  if (typeof owner.name !== "string") {
    return "";
  }
  const name = owner.name.trim();
  // A name is a display name, not a fallback address: a signup flow that
  // seeded `name` from the email would otherwise publish the address to a
  // stranger holding the link (drive issue #684). Anything that looks like an
  // address is left off the page, the same as a blank name.
  if (name.length === 0 || name.includes("@")) {
    return "";
  }
  return name;
}

/**
 * The address of the account that owns a link, for the security notification a
 * refused drop has to send (drive issue #826). Never rendered: it goes to the
 * mailer's `to` only, which is why the display-name rules above do not apply
 * here. An account row with no usable address resolves to the empty string,
 * the same "nobody to tell" core/security-event.js skips over.
 * @param {unknown} resolver
 * @param {string} accountId
 * @param {string} token the upload-request token, named in the throw log
 * @returns {Promise<string>}
 */
export async function ownerEmailFor(resolver, accountId, token) {
  const owner = await ownerRowFor(resolver, accountId, `a refused upload through /s/${token}`);
  if (owner === null || typeof owner.email !== "string") {
    return "";
  }
  return owner.email.trim();
}

/** The request's own origin: the links are absolute so they can be copied.
 *
 * @param {Request} request
 */
export function baseFromRequest(request) {
  return new URL(request.url).origin;
}

/**
 * Whether a folder exists to drop into. The FileStore interface has no stat,
 * but it has list(), and a folder is a row in its parent's listing, so the
 * answer comes from the same interface every other read uses. The root always
 * exists. This is the paved path: the Files page asks the same listing the
 * same way, so there is no second way to know a folder is there.
 * @param {import("../core/files.js").FileStore} files a FileStore
 * @param {string} path a validated folder path
 */
export async function folderExists(files, path) {
  if (path === "/") {
    return true;
  }
  const cut = path.lastIndexOf("/");
  const parent = cut === 0 ? "/" : path.slice(0, cut);
  const name = path.slice(cut + 1);
  const entries = await files.list(parent);
  return entries.some((entry) => entry.kind === "folder" && entry.name === name);
}
