// Split out of src/share-routes.js (drive#617) to keep it under 800 lines; behaviour is unchanged.

import {
  accountFirstChargedAt,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
  preChargeUploadBlocked,
} from "../core/abuse-guards.js";
import { preChargeStoredBytes, safeFileName, validatePath } from "../core/files.js";
import { fairUseRefuseResponse, joinPath } from "../core/files-handlers.js";
import { scopeStore } from "../core/files-scope.js";
import { json } from "../core/http.js";
import { balanceCents } from "../core/ledger.js";
import { failureMessage } from "../core/messages.js";
import { clientIpKey, enforceEdgeLimits } from "../core/rate-limit.js";
import { notifySecurityEvent, sessionLabel } from "../core/security-event.js";
import { isMalwareBody } from "./malware.js";
import {
  linkIsOpen,
  MALWARE_NOTICE_QUIET_MS,
  REQUEST_FILE_MAX_BYTES,
  REQUEST_NAME_MAX_LENGTH,
  REQUEST_TOTAL_MAX_BYTES,
  validateToken,
} from "./share.js";
import { capStateFor, methodNotAllowed, ownerEmailFor, serverFailure } from "./share-store.js";

/** @typedef {import("./share-routes.js").RequestRecord} RequestRecord */
/** @typedef {import("./share-routes.js").LinkStore} LinkStore */

/**
 * The upload itself: POST /api/request/upload?k=<token>&name=<file name>, the
 * request body is the file. The name is cleaned by the same function
 * /api/files/upload uses, so a dropped file cannot name a path, and the bytes
 * are written to the file through the same FileStore — which is why a file
 * dropped here shows up on the owner's drive at its next listing. The write
 * goes through scopeStore(files, the request row's account), so a dropped
 * file lands inside the owner's prefix and nowhere else.
 *
 * Size and rate (drive issue #208): the per-file ceiling and the link's own
 * total are checked from Content-Length before the body is stored, and the
 * two stock rate-limit bindings (per IP and per token) run before the lookup,
 * so a refused upload costs no write. Uploaded bytes then count on the
 * request row and against the owner's spending cap — the same capStatus()
 * resolver the owner's own uploads use.
 * @param {Request} request
 * @param {import("../core/files.js").FileStore} files a FileStore
 * @param {LinkStore} links
 * @param {unknown} capState
 * @param {{fairUseRefuse?: boolean, fairUseForUpload?: (accountId: string, uploadBytes: number) => Promise<{wouldRefuse: boolean, line: {copy: string}}|null>, onFairUseError?: (error: unknown) => void, now?: number, ipLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}, linkLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}, db: D1Database|null, prepaidPause?: boolean, owner?: unknown, email?: unknown, mailFrom?: string, size30DayUnpaid?: (accountId: string, extraBytes: number) => Promise<boolean>}} options db is a required key: undefined throws after the limiters, so a new call site cannot lose the known-bad half without a sound; null is the deliberate no-database call the in-memory list half serves
 */
export async function handleRequestUploadRequest(request, files, links, capState, options) {
  const now = options.now ?? Date.now();
  if (request.method !== "POST") {
    return methodNotAllowed("POST", "POST a file to upload it.");
  }
  if (typeof capState !== "function") {
    throw new TypeError(`handleRequestUploadRequest needs a cap resolver, got ${String(capState)}`);
  }
  const url = new URL(request.url);
  const checked = validateToken(url.searchParams.get("k"));
  if (checked.error) {
    return json({ error: failureMessage("link-not-found") }, 404);
  }
  const limited = await enforceEdgeLimits(
    [
      {
        binding: options.ipLimiter,
        key: clientIpKey(request, "request-upload"),
        name: "REQUEST_UPLOAD_RATE_LIMITER",
      },
      {
        binding: options.linkLimiter,
        key: checked.token,
        name: "REQUEST_UPLOAD_LINK_RATE_LIMITER",
      },
    ],
    "request-upload",
  );
  if (limited) {
    return limited;
  }
  if (options.db === undefined) {
    // The same gate the mint branch carries (drive issue #826): the
    // known-bad check and the prepaid-balance guard both read through
    // options.db, and a caller that omits the key would silently run the
    // drop with neither. null is the deliberate no-database call the
    // in-memory list half serves; undefined is a bug. The limiters are
    // answered first, so a request the edge refuses keeps its answer even
    // on a half-configured deployment.
    throw new TypeError(
      "handleRequestUploadRequest is missing options.db (a wiring TypeError, not a runtime failure); pass null when a call has no database",
    );
  }
  const name = url.searchParams.get("name") || "";
  if (!name) {
    return json({ error: failureMessage("upload-needs-name") }, 400);
  }
  // The name cap (drive issue #549): the name must stay under the same length
  // the owner's own Files page lives with, checked before the body is read or
  // a byte is reserved.
  if (safeFileName(name).length > REQUEST_NAME_MAX_LENGTH) {
    return json({ error: failureMessage("upload-name-too-long") }, 400);
  }
  const record = await links.requests.get(checked.token);
  if (record === null || !linkIsOpen(record, now)) {
    return json({ error: failureMessage("link-not-found") }, 404);
  }
  // The same path rule /api/files applies, run on the joined name before the
  // body is read (drive issue #549, ref #518): a dropped file cannot name a
  // path the owner's own upload would refuse.
  const path = joinPath(record.folder, name);
  const pathChecked = validatePath(path);
  if (pathChecked.error) {
    return json({ error: pathChecked.error }, 400);
  }
  if ((await capStateFor(capState, record.accountId)) === "read_only") {
    // The owner's cap is the owner's rule; a stranger gets the table's words
    // and no write happens. Nothing is deleted, here or at the cap.
    return json({ error: failureMessage("upload-paused-at-cap") }, 403);
  }
  if (
    options.db &&
    options.prepaidPause &&
    (await balanceCents(options.db, record.accountId)) <= 0
  ) {
    // The owner's prepaid balance is empty (drive#586). The stranger cannot
    // top up someone else's drive, so they are told who can act, and the body
    // is never read.
    return json({ error: failureMessage("upload-paused-balance") }, 403);
  }
  const sized = await takeUploadBody(request, record);
  if (sized.error !== undefined) {
    return json({ error: sized.error }, 413);
  }
  const paused = await fairUseRefuseResponse({ id: record.accountId }, sized.bytes, options);
  if (paused) {
    return paused;
  }
  // sized.body is the Uint8Array takeUploadBody already copied from the
  // request, so hashing it does not consume the bytes writeIfAbsent stores.
  if (await isMalwareBody(options.db, sized.body)) {
    // A known-bad body dropped through a public upload link tells the link's
    // owner, not the stranger (drive issue #826): the resolver read happens
    // here, on the refusal, so the owner's address only reaches the mailer.
    // The quiet window (drive issue #826): a stranger who holds the link
    // can repeat a known-bad POST at the link limiter's pace, and a notice
    // per POST is an inbox anyone with the link can flood. The first notice
    // a link sends stamps the row (migrations/drive/0043); repeats inside
    // the window answer the same 403 and mail nothing; when the window
    // reopens the next refusal mails a fresh notice. The stamp follows the
    // mail, never the refusal, so an owner address that is missing stays
    // unstamped and the loud log below keeps repeating until it is fixed.
    // The mint half does not need this: the actor there is the signed-in
    // owner, who can only flood the address they already own.
    if (
      record.malwareNoticeAt === null ||
      now - record.malwareNoticeAt >= MALWARE_NOTICE_QUIET_MS
    ) {
      const ownerEmail = await ownerEmailFor(options.owner, record.accountId, record.token);
      if (ownerEmail === "") {
        // Loud, and named: without this line a misbound resolver or an account row
        // with no address turns off the notification half of this refusal with
        // nothing an operator can read. core/security-event.js logs that it
        // skipped too, but that line names no link, and a notice nobody can act
        // on is the failure worth seeing.
        console.error(
          `drive share: no owner address to notify for a refused upload through /s/${record.token}`,
        );
      }
      const notice = await notifySecurityEvent({
        email: options.email,
        mailFrom: options.mailFrom,
        to: ownerEmail,
        event: "malware-refused",
        deviceName: sessionLabel(request),
        happenedAt: new Date(now).toISOString(),
        detail: `An upload through /s/${record.token} was refused for a file on the known-bad list.`,
      });
      if (notice.sent) {
        await links.requests.stampMalwareNotice(record.token, now);
      }
    }
    return json({ error: failureMessage("malware-refused") }, 403);
  }
  if (
    options.size30DayUnpaid &&
    options.prepaidPause &&
    sized.bytes > 0 &&
    (await options.size30DayUnpaid(record.accountId, sized.bytes))
  ) {
    return json({ error: failureMessage("upload-paused-balance") }, 403);
  }
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  // The request row names the owner, so that is the prefix the write lands
  // under — the same scopeStore /api/files/upload writes through. The guard
  // reads the same store, so this is built before it.
  const scoped = scopeStore(files, { id: record.accountId, name: "" });
  if (options.db) {
    // The owner's 1 TB pre-charge limit, judged on bytes actually read, and
    // branch copies count too (drive#800) through the same shared read.
    const firstChargedAt = await accountFirstChargedAt(options.db, record.accountId);
    const stored = await preChargeStoredBytes(options.db, scoped, record.accountId, firstChargedAt);
    const blocked = preChargeUploadBlocked({
      firstChargedAt,
      storedBytes: stored,
      incomingBytes: Math.max(sized.bytes, stored >= PRE_CHARGE_STORAGE_LIMIT_BYTES ? 1 : 0),
    });
    if (blocked !== null) {
      return json({ error: blocked }, 403);
    }
  }
  // This stat is the ordinary-duplicate answer: a drop of a name that is
  // already stored gets the same 409 on every backend, before any bytes are
  // reserved or written. It is NOT the race answer — the gap between this
  // check and the write below is where drive#644's race lived, two uploads
  // both seeing a free name and both landing. The create-only write is what
  // decides the winner; on a backend whose PUT honors If-None-Match the
  // race closes in the storage itself, and on one that does not, this
  // pre-check still catches every duplicate that is not mid-race. The one
  // observable a non-honoring backend leaves open: a true mid-race pair both
  // answer 201, both reservations stay counted (conservative — the link
  // fills sooner, never past its cap), and the last PUT's bytes stand, which
  // the provider's hide-not-delete versioning keeps recoverable.
  if ((await scoped.stat(path)) !== null) {
    return json({ error: failureMessage("upload-name-taken") }, 409);
  }
  const reserved = await links.requests.addUpload(checked.token, sized.bytes);
  if (!reserved) {
    return json({ error: failureMessage("upload-link-full") }, 413);
  }
  // The create-only write, not a bare write: two uploads that got past the
  // check above within the same instant cannot both win — the store itself
  // decides whether the key was still free when the bytes arrived. The bytes
  // are reserved first so a stranger cannot outrun the link total; a lost
  // race or a failed write releases them, the same release either way.
  let won;
  try {
    // sized.body is a Uint8Array (or empty). FileStore.writeIfAbsent already
    // accepts any BodyInit: the memory store does `new Response(body)
    // .arrayBuffer()`, and the S3 stand-in PUTs the same body fetch accepts.
    won = await scoped.writeIfAbsent(path, sized.body, contentType);
  } catch (cause) {
    await links.requests.releaseUpload(checked.token, sized.bytes);
    return serverFailure(`storing an uploaded file: ${String(cause)}`);
  }
  if (!won) {
    // The name was taken while this upload was in flight: the winner's bytes
    // stand, this upload stored nothing, and its reservation comes back. A
    // release that itself fails is a 500 with the cause logged, not a clean
    // 409 that hides a counter now reading fuller than the link's truth.
    try {
      await links.requests.releaseUpload(checked.token, sized.bytes);
    } catch (cause) {
      // No token in the log: it is a stranger's capability, and the log
      // outlives the link. The folder and the drop's size name the event.
      return serverFailure(
        `releasing a lost-race reservation for a ${sized.bytes}-byte drop into ${record.folder}: ${String(cause)}`,
      );
    }
    return json({ error: failureMessage("upload-name-taken") }, 409);
  }
  try {
    await links.requests.recordArrival(checked.token, safeFileName(name), sized.bytes);
  } catch (cause) {
    // The file is stored, so a digest that cannot be queued must not fail the
    // stranger's upload. It is logged, not swallowed: a later drop appends to
    // the same row, so a transient failure can lose at most this arrival's
    // digest line, and the operator sees which drop it was.
    console.error(
      `drive share: recording an upload arrival for a ${sized.bytes}-byte drop into ${record.folder}: ${String(cause)}`,
    );
  }
  return json({ ok: true, path, name: safeFileName(name) }, 201);
}

/**
 * The size we can know without storing: Content-Length against the per-file
 * ceiling and the bytes this link has left, then the stream counted up to the
 * same ceiling, the two layers src/waitlist.js already uses. A declared size
 * over either cap is refused without reading; a request that declares nothing
 * (or a smaller size than it actually sends) is stopped at the same limit
 * before any write. Either miss is a 413 and no write.
 * @param {Request} request
 * @param {RequestRecord} record
 * @returns {Promise<{bytes: number, body: BodyInit, error?: undefined}|{error: string, bytes?: undefined, body?: undefined}>}
 */
async function takeUploadBody(request, record) {
  const used = Number.isFinite(record.uploadBytes) ? record.uploadBytes : 0;
  const max = Number.isFinite(record.maxBytes) ? record.maxBytes : REQUEST_TOTAL_MAX_BYTES;
  const remaining = max - used;
  if (remaining <= 0) {
    return { error: failureMessage("upload-link-full") };
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > REQUEST_FILE_MAX_BYTES) {
      return { error: failureMessage("body-too-large") };
    }
    if (length > remaining) {
      return { error: failureMessage("upload-link-full") };
    }
  }
  const stream = request.body;
  if (stream === null) {
    return { bytes: 0, body: new Uint8Array(0) };
  }
  const reader = stream.getReader();
  const cap = Math.min(REQUEST_FILE_MAX_BYTES, remaining);
  let buf = new Uint8Array(Math.min(8192, cap));
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const next = total + value.byteLength;
    if (next > REQUEST_FILE_MAX_BYTES) {
      await reader.cancel();
      return { error: failureMessage("body-too-large") };
    }
    if (next > remaining) {
      await reader.cancel();
      return { error: failureMessage("upload-link-full") };
    }
    if (next > buf.byteLength) {
      const grown = new Uint8Array(Math.min(cap, Math.max(next, buf.byteLength * 2)));
      grown.set(buf.subarray(0, total));
      buf = grown;
    }
    buf.set(value, total);
    total = next;
  }
  return { bytes: total, body: total === buf.byteLength ? buf : buf.subarray(0, total) };
}
