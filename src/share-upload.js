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
    throw new TypeError(
      "handleRequestUploadRequest is missing options.db (a wiring TypeError, not a runtime failure); pass null when a call has no database",
    );
  }
  const name = url.searchParams.get("name") || "";
  if (!name) {
    return json({ error: failureMessage("upload-needs-name") }, 400);
  }
  if (safeFileName(name).length > REQUEST_NAME_MAX_LENGTH) {
    return json({ error: failureMessage("upload-name-too-long") }, 400);
  }
  const record = await links.requests.get(checked.token);
  if (record === null || !linkIsOpen(record, now)) {
    return json({ error: failureMessage("link-not-found") }, 404);
  }
  const path = joinPath(record.folder, name);
  const pathChecked = validatePath(path);
  if (pathChecked.error) {
    return json({ error: pathChecked.error }, 400);
  }
  if ((await capStateFor(capState, record.accountId)) === "read_only") {
    return json({ error: failureMessage("upload-paused-at-cap") }, 403);
  }
  if (
    options.db &&
    options.prepaidPause &&
    (await balanceCents(options.db, record.accountId)) <= 0
  ) {
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
  if (await isMalwareBody(options.db, sized.body)) {
    if (
      record.malwareNoticeAt === null ||
      now - record.malwareNoticeAt >= MALWARE_NOTICE_QUIET_MS
    ) {
      const ownerEmail = await ownerEmailFor(options.owner, record.accountId, record.token);
      if (ownerEmail === "") {
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
  const scoped = scopeStore(files, { id: record.accountId, name: "" });
  if (options.db) {
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
  if ((await scoped.stat(path)) !== null) {
    return json({ error: failureMessage("upload-name-taken") }, 409);
  }
  const reserved = await links.requests.addUpload(checked.token, sized.bytes);
  if (!reserved) {
    return json({ error: failureMessage("upload-link-full") }, 413);
  }
  let won;
  try {
    won = await scoped.writeIfAbsent(path, sized.body, contentType);
  } catch (cause) {
    await links.requests.releaseUpload(checked.token, sized.bytes);
    return serverFailure(`storing an uploaded file: ${String(cause)}`);
  }
  if (!won) {
    try {
      await links.requests.releaseUpload(checked.token, sized.bytes);
    } catch (cause) {
      return serverFailure(
        `releasing a lost-race reservation for a ${sized.bytes}-byte drop into ${record.folder}: ${String(cause)}`,
      );
    }
    return json({ error: failureMessage("upload-name-taken") }, 409);
  }
  try {
    await links.requests.recordArrival(checked.token, safeFileName(name), sized.bytes);
  } catch (cause) {
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
