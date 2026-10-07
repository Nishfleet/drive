// The signed half of the meter's storage-event intake (drive issue #831).
//
// The open intake (`POST /api/storage-events`, core/meter.js
// handleStorageEventRequest) takes the vendor's event rule behind one shared
// token. That is the only event shape a bucket can send without a deployment
// change: the rule posts a JSON body and a header the vendor's own config can
// set. It cannot sign that body.
//
// Once the production keys exist, a bucket can be told to post to a route that
// proves the body came from it: the Standard Webhooks shape Dodo's payments
// already arrive in (core/topup.js), the same headers, the same `whsec_`
// secret, the same HMAC over the raw body. This route is that proof for a
// storage event, and it does exactly one thing the open intake does not: for
// every event it stores for the first time it enqueues a single-object index
// job (src/meter-jobs.js `meter.object`), so the object's search row is right
// in minutes instead of at the night's walk. The meter rows themselves are
// written by the same `recordEvent`/`validateEvent` path, so this route adds a
// signature and a queue message, never a second rule about what an event
// means.
//
// It is off until its secret is set, and it fails closed: no
// STORAGE_EVENTS_WEBHOOK_SECRET is a 503 with no body read and no event
// accepted, the same answer `handleBillingWebhook` gives with DODO_WEBHOOK_
// SECRET unset. That name is also undeclared - absent from cloudflare.config.ts
// - and this one is absent in the same way and for the same reason: a declared
// `bindings.secret()` no value backs fails every deploy, and the live bucket
// notifications are the orchestrator's step, not a deploy-blocking one. The
// route stays closed on the deployment until then, which is what the issue
// asked for.
//
// Where this lives: the site Worker, not the api one. Only the site Worker
// holds the METER_JOBS queue binding the single-object job is sent on, and the
// intake this route is a second door to answers from this Worker too.

import { drivePathFromKey } from "../core/files.js";
import { BodyTooLargeError, json, readLimitedBody } from "../core/http.js";
import { bucketForAccount } from "../core/keyprovider.js";
import {
  looksLikeNotificationRecord,
  notificationRecord,
  notificationRecords,
  recordEvent,
  validateEvent,
} from "../core/meter.js";
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
 * record is spread through notificationRecord untouched, so this reader runs
 * on what the provider sent.
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
  } catch {
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
  } catch {
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
  // Three bindings decide whether this route is open at all, and each one is
  // the operator's to fix. None of them names itself in the answer: the caller
  // is a machine with a configuration, not a person to be told which setting
  // to change.
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
  // The signature is verified over the raw body, before the body is parsed, so
  // nothing in it is trusted on the strength of a JSON parse. A malformed
  // secret is the operator's problem: it goes to the log by name, never the
  // secret itself, and the event is refused so the bucket keeps retrying it.
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
    // One sentence, no echo of what was presented: a wrong signature is a
    // misconfigured or forged caller, and its text is not a hint.
    return json({ error: "The event signature did not match." }, 401);
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: "The request body is not valid JSON." }, 400);
  }
  // The same three shapes the open intake takes - a list, a `Records`
  // envelope, or one record - through the same normalisers, so this door
  // cannot accept an event shape the other door refuses.
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
  // One batch per event, the way a bucket's own delivery arrives: a
  // notification is a handful of keys, and per-event recording is what says
  // which of them were new, which is what decides which index job to send. The
  // dedup is `recordEvent`'s own, so a redelivery of this whole request stores
  // nothing a second time and enqueues nothing a second time either.
  for (const [index, raw] of rawEvents.entries()) {
    const event = validateEvent(raw);
    if (event.error) {
      // A bad event does not hold the good ones back, and one invalid event
      // still answers 400: the bucket's own logs show a delivery that was not
      // fully accepted, and the stored events are repeats on its retry.
      rejected.push({ index, error: event.error });
      continue;
    }
    // The path the index job is sent: the same name the account's store takes.
    // A key the account's prefix does not cover is a wiring bug in whatever
    // built the event, so it is refused by name rather than reaching a job
    // that could only fail and be retried forever. The path's check is how the
    // key turns into the index row's name; what it proves is done already by
    // the bucket above.
    // The two fields are read plainly rather than off the narrowed event: the
    // job body's own shape is checked again by the validator its consumer
    // uses, so a `path` that is not a string never reaches a message.
    const accountId = typeof event.accountId === "string" ? event.accountId : "";
    // The account comes out of the key, so the key cannot prove the account;
    // the sending bucket can. This door is the only index writer, so it is the
    // only place that proof is worth holding.
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
    // The event is stored, so a failed enqueue is not a stored-event failure:
    // the caller retries, the retry's events are repeats the dedup drops, and
    // the night's walk still corrects the row. Answer 503 so the bucket does
    // retry it, and say what happened in the log.
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
