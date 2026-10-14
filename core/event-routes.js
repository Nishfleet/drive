import { errorResponse, json, tokensMatch } from "./http.js";

/**
 * One event from an S3 notification envelope, and the bucket and key it names.
 * @typedef {object} StorageEvent
 * @property {string} eventName e.g. s3:ObjectCreated:Put
 * @property {string} bucket
 * @property {string} key the object key, form-decoded
 * @property {string} versionId
 * @property {string} eventTime
 */

/**
 * The object key from a notification, decoded. S3 event notifications are
 * form-encoded, not just percent-encoded: a space arrives as `+` and a literal
 * `+` as `%2B` (AWS's own documented example is `"key":"red+flower.jpg"` for
 * `red flower.jpg`; MinIO reproduces it, measured 2026-10-01: `q3 report.txt`
 * arrives as `q3+report.txt`). Decoding `+` as a space first is what makes the
 * meter (build step 5) see the key the file actually has.
 * @param {string} rawKey
 * @returns {string}
 */
export function decodeNotificationKey(rawKey) {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, " "));
  } catch {
    return rawKey;
  }
}

/**
 * Reads the records out of a notification body, or names why it will not. The
 * record list is under `Records` on every provider (AWS, MinIO, B2, iDrive);
 * the top-level fields MinIO repeats (EventName, Key) are not a second
 * envelope and are not read, so a body with only top-level fields and no
 * Records is a 400 naming what was missing.
 * @param {unknown} body
 * @returns {{events: StorageEvent[]}|{error: string}}
 */
export function parseStorageEvents(body) {
  if (typeof body !== "object" || body === null) {
    return { error: "The notification body is not an object." };
  }
  const records = /** @type {{Records?: unknown}} */ (body).Records;
  if (!Array.isArray(records) || records.length === 0) {
    return { error: "The notification body carried no Records." };
  }
  /** @type {StorageEvent[]} */
  const events = [];
  for (const record of records) {
    if (typeof record !== "object" || record === null) {
      return { error: "A notification record is not an object." };
    }
    const typed =
      /** @type {{eventName?: unknown, eventTime?: unknown, s3?: {bucket?: {name?: unknown}, object?: {key?: unknown, versionId?: unknown}}}} */ (
        record
      );
    const eventName = typed.eventName;
    const bucket = typed.s3?.bucket?.name;
    const rawKey = typed.s3?.object?.key;
    if (typeof eventName !== "string" || typeof bucket !== "string" || typeof rawKey !== "string") {
      return { error: "A notification record is missing its event name, bucket or key." };
    }
    events.push({
      eventName,
      bucket,
      key: decodeNotificationKey(rawKey),
      versionId: typeof typed.s3?.object?.versionId === "string" ? typed.s3.object.versionId : "",
      eventTime: typeof typed.eventTime === "string" ? typed.eventTime : "",
    });
  }
  return { events };
}

/**
 * POST /v1/events — the bucket's notifications. The token is the whole
 * credential, and the answer is what the bucket will retry on, so a body this
 * route cannot read is a 400 it names rather than a 202 it ignores.
 * @param {Request} request
 * @param {{env: Record<string, unknown>}} ctx
 */
export async function storageEventsRoute(request, ctx) {
  if (request.method !== "POST") {
    return errorResponse(405, "That method is not allowed here.", { allow: "POST" });
  }
  const token = ctx.env.STORAGE_EVENT_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    return errorResponse(503, "Storage events are not configured on this deployment.");
  }
  const [scheme, presented] = (request.headers.get("authorization") ?? "").split(" ");
  if (scheme === undefined || presented === undefined || scheme.toLowerCase() !== "bearer") {
    return errorResponse(401, "Storage events need the bucket's token.", {
      "www-authenticate": 'Bearer realm="drive"',
    });
  }
  if (!(await tokensMatch(presented, token))) {
    return errorResponse(401, "Storage events need the bucket's token.", {
      "www-authenticate": 'Bearer realm="drive"',
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "The notification body is not valid JSON.");
  }
  const parsed = parseStorageEvents(body);
  if ("error" in parsed) {
    return errorResponse(400, parsed.error);
  }
  for (const event of parsed.events) {
    console.log(
      `[api] storage event ${event.eventName} version=${event.versionId || "-"} at=${event.eventTime || "-"}`,
    );
  }
  return json({ received: parsed.events.length, events: parsed.events }, 202);
}
