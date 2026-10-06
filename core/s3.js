// The S3 client the api Worker speaks to storage through: signed requests,
// the four bucket-configuration calls build step 1 needs, and STS key
// minting. Everything here is stock S3 (drive#2), so pointing the Worker at
// iDrive e2, Backblaze B2 or the local stand-in is configuration alone —
// endpoint, region, bucket and the master credential (docs/build-spec.md,
// "Keys and safety").
//
// Two shapes of S3 answer arrive in this file and neither is special-cased by
// vendor: the XML error body (`<Code>`/`<Message>`) every endpoint returns,
// and the XML the calls below read. An endpoint that answers with neither is
// named as unrecognised rather than treated as success, because a storage
// layer that reports success for a call it could not read is how a key ends up
// unscoped. Listing bodies — the versions this file's restore path reads —
// parse in core/s3-listing.js, the one S3 listing parser both Workers share
// (drive issue #504), so a key's own characters survive the answer everywhere.

import { AwsClient } from "aws4fetch";
import { decodeEntities, parseVersionRows, tagValue as scanTagValue } from "./s3-listing.js";

/**
 * An S3 answer: the status, the headers (the version id and ETag a write
 * returns live here) and the body. Refusals are returned, not thrown: an
 * AccessDenied is a result the build step 1 proof has to be able to read.
 * @typedef {object} S3Response
 * @property {number} status
 * @property {Headers} headers
 * @property {string} text
 */

/**
 * An S3 call that failed, with the endpoint's own code and message. Thrown by
 * `ok()` and by every function here that promises an effect, so a failure is
 * never swallowed into a default.
 */
export class S3Error extends Error {
  /**
   * @param {string} operation what the Worker was trying to do
   * @param {number} status
   * @param {string} code the endpoint's `<Code>`, or "Unrecognised"
   * @param {string} message the endpoint's `<Message>`, or the body
   */
  constructor(operation, status, code, message) {
    super(`${operation} failed with ${code} (HTTP ${status}): ${message}`);
    this.name = "S3Error";
    this.operation = operation;
    this.status = status;
    this.code = code;
  }
}

/**
 * One tag's text from an S3 XML body, or null when the tag is absent — this
 * file's readers branch on the missing case (`ok()` reports "Unrecognised",
 * key minting refuses a half-built credential). The scan is the shared one
 * (core/s3-listing.js `tagValue`, the same function the site Worker's listings
 * read), and this adapter only turns its "not found" into null.
 * @param {string} xml
 * @param {string} tag
 * @returns {string|null}
 */
export function tagValue(xml, tag) {
  const value = scanTagValue(xml, tag);
  return value === "" ? null : value;
}

/**
 * Throws unless the call succeeded, naming the endpoint's own error code.
 * @param {string} operation
 * @param {S3Response} response
 * @returns {S3Response}
 */
export function ok(operation, response) {
  if (response.status >= 200 && response.status < 300) {
    return response;
  }
  const code = tagValue(response.text, "Code") ?? "Unrecognised";
  const message = tagValue(response.text, "Message") ?? response.text.slice(0, 200);
  throw new S3Error(operation, response.status, decodeEntities(code), decodeEntities(message));
}

/**
 * A credential the endpoint can verify: an access key id, its secret, and the
 * session token a temporary credential also carries.
 * @typedef {object} S3Credentials
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} [sessionToken] required for a temporary credential
 */

/**
 * @typedef {object} S3ClientConfig
 * @property {string} endpoint e.g. https://s3.eu-west-3.idrivee2.com
 * @property {string} region
 * @property {S3Credentials} credentials
 * @property {string} [service] the SigV4 service, "s3" unless signing the
 *   STS AssumeRole call, which is "sts" and is served on the same origin
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * A signed S3 client. Signing is `aws4fetch` (`AwsClient`), the stock
 * Worker-side SigV4 library; this file only builds the path-style URL, sends
 * the signed request, and reads the XML. `send` returns every answer, refusals
 * included; `ok` above turns a refusal into an error for the callers that
 * promised one.
 * @param {S3ClientConfig} config
 */
export function createS3Client(config) {
  const { endpoint, region, credentials, service = "s3", fetchImpl = fetch } = config;
  if (!endpoint || !region || !credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new TypeError("An S3 client needs an endpoint, a region and a credential.");
  }
  const origin = endpoint.replace(/\/+$/, "");
  const aws = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    region,
    service,
    retries: 0,
  });

  return {
    /**
     * @param {string} method
     * @param {{bucket?: string, key?: string, query?: Record<string, string>, headers?: Record<string, string>, body?: string|Uint8Array}} [target]
     * @returns {Promise<S3Response>}
     */
    async send(method, target = {}) {
      const url = new URL(`${origin}/${target.bucket ?? ""}`);
      if (target.key !== undefined && target.key !== "") {
        // Each path segment is percent-encoded before it goes on the URL, and
        // the slashes are kept. A key from a Finder drive can legally contain
        // `?`, `#` or a space, and the URL pathname setter would otherwise read
        // `?` as the start of the query and `#` as a fragment, so a file named
        // `report#2.txt` would sign and fetch `<prefix>report`. The URL is then
        // what aws4fetch canonicalises, so the address signed and the address
        // sent are the same string.
        url.pathname = `${url.pathname}/${target.key.split("/").map(encodeURIComponent).join("/")}`;
      }
      for (const [name, value] of Object.entries(target.query ?? {})) {
        url.searchParams.set(name, value);
      }
      // The body is sent exactly as it was signed: a `Uint8Array` is copied
      // into a plain-ArrayBuffer view (the bytes themselves, for a binary
      // upload), a string is text, and an absent body is absent. Sending
      // anything other than the signed bytes is SignatureDoesNotMatch.
      /** @type {string|Uint8Array<ArrayBuffer>|undefined} */
      let body;
      if (target.body === undefined || target.body === "") {
        body = undefined;
      } else if (typeof target.body === "string") {
        body = target.body;
      } else {
        body = new Uint8Array(target.body.byteLength);
        body.set(target.body);
      }
      const signed = await aws.sign(url.toString(), {
        method: method.toUpperCase(),
        headers: target.headers ?? {},
        body,
      });
      const response = await fetchImpl(signed);
      return { status: response.status, headers: response.headers, text: await response.text() };
    },
  };
}

/**
 * How many days a hidden version (an overwritten copy, or the file behind a
 * delete marker) stays in a bucket before the lifecycle rule removes it. The
 * docs read this value (src/keys.js `storagePowersFor`), so a page cannot
 * promise a longer undo window than the bucket keeps (drive#502).
 */
export const HIDDEN_VERSION_DAYS = 1;

/**
 * The bucket build step 1 asks for: versioning on, hidden versions kept for a
 * day, and the event notifications pointed at the api Worker. Idempotent, so
 * a run that configures an existing bucket is not a failure.
 *
 * The lifecycle rule is the hidden-version rule from docs/build-spec.md: a
 * version that is no longer current is kept `hiddenVersionDays` days and then
 * gone, and a delete marker left on a file nobody re-saves is gone with it.
 *
 * Server-side encryption is the one setting a stock S3 stand-in cannot host:
 * MinIO refuses SSE-S3 outright (501 "KMS is not configured", measured
 * 2026-10-01). It is the primary provider's own bucket setting — iDrive e2
 * takes the stock call: `AES256` was set on the real bucket and read back
 * 2026-10-03 (drive#173) — so the deployment that is on a vendor that takes
 * it passes `sse: "AES256"`, the stand-in leaves it off, and the two are one
 * stock PUT away from each other. A bucket is provisioned once per customer
 * (drive#371), so this is what sign-up asks the bucket for.
 * @param {ReturnType<typeof createS3Client>} client
 * @param {{bucket: string, notificationQueueArn?: string, hiddenVersionDays?: number, sse?: "AES256"}} config
 * @returns {Promise<{versioning: S3Response, lifecycle: S3Response, notification: S3Response|null, encryption: S3Response|null}>}
 */
export async function provisionBucket(client, config) {
  const { bucket, notificationQueueArn, hiddenVersionDays = HIDDEN_VERSION_DAYS } = config;

  const created = await client.send("PUT", { bucket });
  if (created.status !== 200 && tagValue(created.text, "Code") !== "BucketAlreadyOwnedByYou") {
    ok("create the bucket", created);
  }

  const versioning = ok(
    "enable bucket versioning",
    await client.send("PUT", {
      bucket,
      query: { versioning: "" },
      headers: { "content-type": "application/xml" },
      body: "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
    }),
  );

  // S3 refuses a lifecycle body without a Content-MD5, so it is computed here
  // rather than left to the caller to remember.
  const lifecycleBody =
    `<LifecycleConfiguration><Rule><ID>hidden-versions</ID><Status>Enabled</Status>` +
    `<Filter><Prefix></Prefix></Filter>` +
    `<NoncurrentVersionExpiration><NoncurrentDays>${hiddenVersionDays}</NoncurrentDays>` +
    `</NoncurrentVersionExpiration>` +
    `<Expiration><ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker></Expiration>` +
    `</Rule></LifecycleConfiguration>`;
  const md5 = await contentMd5(lifecycleBody);
  const lifecycle = ok(
    "set the hidden-version lifecycle rule",
    await client.send("PUT", {
      bucket,
      query: { lifecycle: "" },
      headers: { "content-type": "application/xml", "content-md5": md5 },
      body: lifecycleBody,
    }),
  );

  let notification = null;
  if (notificationQueueArn) {
    const notificationBody =
      `<NotificationConfiguration><QueueConfiguration><Id>drive-events</Id>` +
      `<Queue>${notificationQueueArn}</Queue>` +
      `<Event>s3:ObjectCreated:*</Event><Event>s3:ObjectRemoved:*</Event>` +
      `</QueueConfiguration></NotificationConfiguration>`;
    notification = ok(
      "set the bucket event notifications",
      await client.send("PUT", {
        bucket,
        query: { notification: "" },
        headers: { "content-type": "application/xml" },
        body: notificationBody,
      }),
    );
  }

  // SSE-S3, the stock bucket-encryption call. Only sent when the deployment
  // names it: a stock S3 stand-in refuses it, and the vendor that takes it
  // (iDrive e2, measured drive#173) is the one whose deployment names it.
  let encryption = null;
  if (config.sse !== undefined) {
    const encryptionBody =
      `<ServerSideEncryptionConfiguration><Rule>` +
      `<ApplyServerSideEncryptionWithS3EncryptionByDefault>` +
      `<SSEAlgorithm>${config.sse}</SSEAlgorithm>` +
      `</ApplyServerSideEncryptionWithS3EncryptionByDefault>` +
      `</Rule></ServerSideEncryptionConfiguration>`;
    encryption = ok(
      "set the bucket's server-side encryption",
      await client.send("PUT", {
        bucket,
        query: { encryption: "" },
        headers: { "content-type": "application/xml" },
        body: encryptionBody,
      }),
    );
  }

  return { versioning, lifecycle, notification, encryption };
}

/**
 * The bucket's server-side encryption, read back: the algorithm the bucket
 * actually applies, or an empty string when it applies none. Read back rather
 * than taken from the PUT's status, the same rule readBucketConfig follows.
 * @param {ReturnType<typeof createS3Client>} client
 * @param {{bucket: string}} config
 * @returns {Promise<string>}
 */
export async function readBucketEncryption(client, config) {
  const answer = await client.send("GET", {
    bucket: config.bucket,
    query: { encryption: "" },
  });
  return decodeEntities(tagValue(answer.text, "SSEAlgorithm") ?? "");
}

/**
 * MD5 as base64, for the `Content-MD5` S3 requires on a configuration body.
 * WebCrypto has no MD5, so this is the RFC 1321 algorithm.
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function contentMd5(text) {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  // One 0x80 byte, then zeroes, then the length in little-endian bits.
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 0x100000000), true);

  /** @type {Int32Array} */
  const state = new Int32Array([0x67452301, -0x10325477, -0x67452302, 0x10325476]);
  const shifts = [
    [7, 12, 17, 22],
    [5, 9, 14, 20],
    [4, 11, 16, 23],
    [6, 10, 15, 21],
  ];
  const table = Array.from(
    { length: 64 },
    (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0,
  );

  for (let offset = 0; offset < padded.length; offset += 64) {
    /** @type {Int32Array} */
    const words = new Int32Array(16);
    for (let i = 0; i < 16; i++) {
      words[i] = view.getInt32(offset + i * 4, true);
    }
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++) {
      // Each round takes a different function of the same four variables, a
      // different message word and a different rotation, in four groups of
      // sixteen (RFC 1321 section 3.4).
      let mixed;
      let word;
      let shift;
      if (i < 16) {
        mixed = (b & c) | (~b & d);
        word = i;
        shift = shifts[0][i % 4];
      } else if (i < 32) {
        mixed = (d & b) | (~d & c);
        word = (5 * i + 1) % 16;
        shift = shifts[1][i % 4];
      } else if (i < 48) {
        mixed = b ^ c ^ d;
        word = (3 * i + 5) % 16;
        shift = shifts[2][i % 4];
      } else {
        mixed = c ^ (b | ~d);
        word = (7 * i) % 16;
        shift = shifts[3][i % 4];
      }
      const sum = (mixed + a + table[i] + words[word]) | 0;
      const rotated = (sum << shift) | (sum >>> (32 - shift));
      const previousD = d;
      d = c;
      c = b;
      b = (b + rotated) | 0;
      a = previousD;
    }
    state[0] = (state[0] + a) | 0;
    state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0;
    state[3] = (state[3] + d) | 0;
  }

  // The digest is the four state words in little-endian order.
  let out = "";
  for (const word of state) {
    for (let i = 0; i < 4; i++) {
      const byte = (word >>> (i * 8)) & 0xff;
      out += String.fromCharCode(byte);
    }
  }
  return btoa(out);
}

/**
 * The bucket's own answers, read back: the versioning state, the lifecycle
 * rule and the notification target. The proof asserts on these rather than on
 * the PUT's status, so what is asserted is what the bucket will actually do.
 * @param {ReturnType<typeof createS3Client>} client
 * @param {{bucket: string}} config
 */
export async function readBucketConfig(client, config) {
  const versioning = ok(
    "read bucket versioning",
    await client.send("GET", {
      bucket: config.bucket,
      query: { versioning: "" },
    }),
  );
  const lifecycle = await client.send("GET", { bucket: config.bucket, query: { lifecycle: "" } });
  const notification = await client.send("GET", {
    bucket: config.bucket,
    query: { notification: "" },
  });
  return {
    versioning: decodeEntities(tagValue(versioning.text, "Status") ?? ""),
    lifecycleDays: Number(tagValue(lifecycle.text, "NoncurrentDays") ?? ""),
    lifecycleDaysKnown: lifecycle.status === 200,
    notificationArn: decodeEntities(tagValue(notification.text, "Queue") ?? ""),
    notificationEvents: [...notification.text.matchAll(/<Event>([^<]*)<\/Event>/g)].map(
      (match) => match[1],
    ),
  };
}

/**
 * One row of a ListObjectVersions answer: a saved version, or the delete marker
 * an agent's delete leaves behind (the "hidden version" of docs/build-spec.md).
 * @typedef {object} FileVersion
 * @property {string} key
 * @property {string} versionId
 * @property {boolean} latest
 * @property {boolean} deleteMarker
 * @property {number} sizeBytes
 * @property {string} etag
 * @property {string} lastModified
 */

/**
 * The versions of a prefix, newest first as the endpoint returned them. The
 * restore path reads this to find the version a delete marker is hiding. The
 * scan and the decode are the shared parser's (core/s3-listing.js
 * `parseVersionRows`), re-exported here under the name this file has always
 * given it, so a key the provider escaped in the answer reads back the way
 * the account wrote it (drive issue #504).
 * @param {string} xml
 * @param {string} [prefix] keeps the listing to one folder
 * @returns {FileVersion[]}
 */
export const parseListVersions = parseVersionRows;
