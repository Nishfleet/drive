import { drivePathFromKey } from "../core/files-scope.js";
import { BodyTooLargeError, json, readLimitedBody } from "../core/http.js";
import { bucketForAccount } from "../core/keyprovider.js";
import { recordEvent, validateEvent } from "../core/meter-events.js";
import {
  looksLikeNotificationRecord,
  notificationRecord,
  notificationRecords,
} from "../core/meter-usage.js";
import { verifyWebhook } from "../core/topup.js";
import { sendObjectJobs } from "./meter-jobs.js";

/** The second door on the same intake, signed the way a provider's own events
 * can be. Public: the signature is the whole proof, and no session exists to
 * authenticate one. */
export const SIGNED_STORAGE_EVENTS_PATH = "/api/storage-events/signed";

/** The same bound the open intake reads a body with, so a caller cannot use
 * the signed door to post a body the token door would refuse. */
const SIGNED_EVENT_BODY_BYTES = 256 * 1024;

/**
 * The bucket a notification record names, or null when it names none.
 *
 * Two shapes carry it: a record with a `bucket` field of its own, and the S3
 * notification's `s3.bucket.name`, the shape core/event-routes.js parses. The
 * caller already flattened a `Records` envelope through `notificationRecords`,
 * so this reader sees one record, not the envelope.
 * @param {Record<string, unknown>} record
 * @returns {string|null}
 */
function bucketOfRecord(record) {
  if (typeof record.bucket === "string" && record.bucket !== "") {
    return record.bucket;
  }
  const s3 = record.s3;
  if (typeof s3 === "object" && s3 !== null) {
    const nested = /** @type {{bucket?: {name?: unknown}}} */ (s3).bucket;
    if (typeof nested === "object" && nested !== null && typeof nested.name === "string") {
      return nested.name === "" ? null : nested.name;
    }
  }
  return null;
}

/**
 * Whether a record's own bucket is the bucket the key's account lives in.
 *
 * `validateEvent` reads the account out of the key's folder, so on its own the
 * account and the key always agree - that check is circular and lets a key
 * naming someone else's account through. The bucket is the one field the
 * account's own store cannot fake: the rule that sent the notification is on
 * the account's own bucket, and every other account's bucket is a name no
 * rewritten key produces (core/keyprovider.js `bucketForAccount`).
 *
 * Fails closed both ways: a record that names no bucket has not proven where
 * it came from, and a bucket that is not the account's own is refused. The
 * signed door is the only index writer, so it holds this proof; the meter's
 * token door and its rows are unchanged.
 * @param {Record<string, unknown>} record
 * @param {string} accountId
 * @returns {boolean}
 */
function bindsToAccount(record, accountId) {
  const bucket = bucketOfRecord(record);
  if (bucket === null) {
    return false;
  }
  try {
    return bucket === bucketForAccount(accountId);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return false;
  }
}

/**
 * The drive path a stored event names, or null when it names none.
 *
 * `validateEvent` stores the account folder as it arrived - `u/<id>/notes.md`
 * from a provider's own key, or `/u/<id>/notes.md` from a sender that has
 * already put a slash on it - and that is what the meter's rows want. The
 * index job wants the path the account's own store takes, which is the same
 * name without the prefix, and `drivePathFromKey` is the one place that
 * conversion is written: a key outside the account's own prefix is refused
 * there rather than turned into a row for someone else's file.
 * @param {string} key
 * @param {string} accountId
 * @returns {string|null}
 */
function drivePathOf(key, accountId) {
  const trimmed = key.startsWith("/") ? key.slice(1) : key;
  try {
    return drivePathFromKey(trimmed, { id: accountId });
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return null;
  }
}

/** @typedef {{db?: D1Database, secret?: string, queue?: {sendBatch(messages: Array<{body: unknown}>): Promise<unknown>}|null, now?: () => number}} SignedEventDeps */

/**
 * POST /api/storage-events/signed: a signed bucket event, metered and indexed.
 *
 * Answers 200 for a batch it finished with whole, including one made only of
 * repeats, so the bucket stops retrying those. A batch holding an event it
 * refuses answers 400, the same split core/meter.js's token door answers: the
 * accepted events stay stored, the retry that follows is deduped against
 * them, and the refusal is reported per event with its index in the batch.
 * Answers 401 for a signature that does not match, 413 for a body past the
 * bound, and 503 for every configuration that makes accepting one
 * impossible.
 * @param {Request} request
 * @param {SignedEventDeps} deps
 * @returns {Promise<Response>}
 */
export async function handleSignedStorageEventRequest(request, deps) {
  if (request.method !== "POST") {
    return json({ error: "The signed storage event route accepts a POST." }, 405);
  }
  if (!deps.db) {
    console.error("signed storage events: the meter database binding is not configured");
    return json({ error: "The signed event intake is not configured on this deployment." }, 503);
  }
  if (typeof deps.secret !== "string" || deps.secret === "") {
    console.error("signed storage events: the event webhook secret is not configured");
    return json({ error: "The signed event intake is not configured on this deployment." }, 503);
  }
  if (!deps.queue) {
    console.error("signed storage events: the index queue binding is not configured");
    return json({ error: "The signed event intake is not configured on this deployment." }, 503);
  }
  const now = deps.now ?? (() => Date.now());
  let body;
  try {
    body = new TextDecoder().decode(await readLimitedBody(request, SIGNED_EVENT_BODY_BYTES));
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return json({ error: "That event was too large to accept." }, 413);
    }
    console.error("signed storage events: could not read the body", String(error));
    return json({ error: "The event could not be read." }, 400);
  }
  let valid = false;
  try {
    valid = await verifyWebhook({
      secret: deps.secret,
      id: request.headers.get("webhook-id"),
      timestamp: request.headers.get("webhook-timestamp"),
      signature: request.headers.get("webhook-signature"),
      body,
      now: now(),
    });
  } catch (error) {
    console.error("signed storage events: the secret could not be read", String(error));
    return json({ error: "The signed event intake is not configured on this deployment." }, 503);
  }
  if (!valid) {
    return json({ error: "The event signature did not match." }, 401);
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return json({ error: "The request body is not valid JSON." }, 400);
  }
  let rawEvents;
  try {
    rawEvents = notificationRecords(parsed).map((record) =>
      looksLikeNotificationRecord(record) ? notificationRecord(record) : record,
    );
  } catch (error) {
    if (error instanceof TypeError) {
      return json({ error: error.message }, 400);
    }
    throw error;
  }
  if (rawEvents.length === 0) {
    return json({ error: "The batch has no events in it." }, 400);
  }
  /** @type {Array<{accountId: string, path: string, at: number}>} */
  const jobs = [];
  let stored = 0;
  let deduped = 0;
  /** @type {Array<{index: number, error: string}>} */
  const rejected = [];
  const at = now();
  for (const [index, raw] of rawEvents.entries()) {
    const event = validateEvent(raw);
    if (event.error) {
      rejected.push({ index, error: event.error });
      continue;
    }
    const accountId = typeof event.accountId === "string" ? event.accountId : "";
    if (!bindsToAccount(/** @type {Record<string, unknown>} */ (raw), accountId)) {
      rejected.push({
        index,
        error: "The event's bucket is not the account's own bucket.",
      });
      continue;
    }
    const indexed = drivePathOf(typeof event.path === "string" ? event.path : "", accountId);
    if (indexed === null) {
      rejected.push({
        index,
        error: `The event's path is not under the account's own folder: ${event.path}`,
      });
      continue;
    }
    try {
      const one = await recordEvent(/** @type {D1Database} */ (deps.db), event, at);
      if (one.stored) {
        stored += 1;
        jobs.push({ accountId, path: indexed, at });
      } else {
        deduped += 1;
      }
    } catch (error) {
      console.error(
        "signed storage events: could not store the event",
        `account=${event.accountId}`,
        String(error),
      );
      return json({ error: "The event could not be stored." }, 503);
    }
  }
  let enqueued = 0;
  try {
    const queue = /** @type {{sendBatch(messages: Array<{body: unknown}>): Promise<unknown>}} */ (
      deps.queue
    );
    enqueued = jobs.length > 0 ? await sendObjectJobs(queue, jobs) : 0;
  } catch (error) {
    console.error("signed storage events: could not enqueue the index job", String(error));
    return json({ ok: false, error: "The index job could not be queued.", stored, deduped }, 503);
  }
  if (rejected.length > 0) {
    return json(
      {
        ok: false,
        error: `${rejected.length} of the batch's events could not be accepted.`,
        stored,
        deduped,
        enqueued,
        rejected,
      },
      400,
    );
  }
  return json({ ok: true, stored, deduped, enqueued }, 200);
}
