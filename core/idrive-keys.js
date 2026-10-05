// Key minting against the vendor's own access-key API: the api Worker holds a
// reseller API token and hands out credentials the storage server enforces
// (drive#371, build step 1's third measurement).
//
// iDrive e2 cannot limit a key to a folder (prefix) — it limits a key to a
// BUCKET, and it allows unlimited buckets (measured 2026-10-03, drive#173 and
// #371). So the boundary is the bucket: one bucket per account, `drv-<id>`,
// and one per team, `drv-t-<id>` (keyprovider.js `bucketForAccount` /
// `bucketForTeam`, the one place the name is built). The prefix inside a
// bucket stays the layout the rest of the product already reads
// (`u/<id>/…`, `.branches/<name>/…`), so the S3 code paths stay stock.
//
// The mint is the vendor's reseller API, not S3: `POST
// /api/reseller/v1/create_access_key` with a `token` header, naming the bucket
// or buckets the key may touch, the permission level, and the delete switches
// that make an agent's delete a delete marker rather than a destruction.
// That is the same safety the STS session policy gave the stand-in and B2 —
// the endpoint refuses what the key is not allowed — carried on the one vendor
// API that can express it. Revoking is the same API's `remove_access_key`, so
// a revoked key really stops working at the provider, not only in the api's
// own store.

import { createS3Client, provisionBucket } from "./s3.js";

/**
 * @typedef {object} IdriveKeyProviderConfig
 * @property {string} apiEndpoint the reseller API base, e.g.
 *   https://api.idrivee2.com/api/reseller/v1
 * @property {string} apiToken the token from the e2 profile page, read from
 *   the deployment's secret (`IDRIVE_E2_API_TOKEN`) and never logged
 * @property {boolean} [provisionBuckets] when true, the bucket a scope names is
 *   provisioned (versioning, SSE `AES256`, the one-day hidden-version rule)
 *   before its key is minted, so the first key an account is handed always has
 *   a bucket to name. Idempotent, so a repeat mint is not a failure.
 * @property {import("./s3.js").S3ClientConfig} [storage] the S3 master
 *   credential the provisioning call needs. Required when `provisionBuckets`
 *   is true, refused otherwise.
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * What a minted key is: the pair the caller shows once, and the one value the
 * api keeps so it can be withdrawn later. The vendor's key id is the api's own
 * `accessKeyId` column, the same column every provider writes, so revoke and
 * re-authentication read the same row.
 * @typedef {object} IdriveMintedKey
 * @property {string} accessKeyId
 * @property {string} secret
 * @property {string|null} sessionToken always null: the vendor's key is a
 *   long-lived pair, not a bounded session, so there is no token half
 * @property {number|null} expiresIn null unless the deployment names an
 *   expiry, in which case the vendor answers with the epoch second it stops at
 * @property {string} bucket the bucket the key is limited to
 * @property {boolean} disableDeleteVersion whether the key can destroy a
 *   hidden version (false on a person's device key, true on every agent key)
 * @property {string} [vendorExpiryOn] the expiry the vendor echoed back, when
 *   the deployment asked for one
 */

/**
 * A vendor answer that is not a usable key or a usable revocation, named as
 * the failure it is rather than answered as a default: a mint that came back
 * without a secret would hand the caller half a credential.
 */
export class IdriveKeyError extends Error {
  /**
   * @param {string} operation
   * @param {number} status
   * @param {string} detail the vendor's own words when it gave any
   */
  constructor(operation, status, detail) {
    super(`${operation} failed (HTTP ${status}): ${detail}`);
    this.name = "IdriveKeyError";
    this.operation = operation;
    this.status = status;
  }
}

/** The permission level that reads and writes. 2 is the vendor's own number. */
const READ_WRITE_PERMISSION = 2;

/**
 * The reseller API call, one POST with the token in a header. The body is
 * JSON, the answer is JSON, and a non-2xx is thrown with the vendor's own
 * message rather than read as an empty success.
 * @param {string} apiEndpoint
 * @param {string} apiToken
 * @param {string} action `create_access_key`, `remove_access_key` or `list_access_keys`
 * @param {Record<string, unknown>} body
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Record<string, unknown>>}
 */
async function callResellerApi(apiEndpoint, apiToken, action, body, fetchImpl) {
  if (!apiEndpoint || !apiToken) {
    throw new TypeError(
      "The iDrive key provider needs the reseller API endpoint and an API token.",
    );
  }
  const url = `${apiEndpoint.replace(/\/+$/, "")}/${action}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", token: apiToken },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  /** @type {Record<string, unknown>} */
  let answer = {};
  if (text !== "") {
    // An unparseable answer is named as one: a body this module cannot read is
    // not a successful mint.
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new IdriveKeyError(
          action,
          response.status,
          `the answer was not a JSON object: ${text.slice(0, 200)}`,
        );
      }
      answer = /** @type {Record<string, unknown>} */ (parsed);
    } catch (error) {
      if (error instanceof IdriveKeyError) {
        throw error;
      }
      throw new IdriveKeyError(
        action,
        response.status,
        `the answer was not JSON: ${text.slice(0, 200)}`,
      );
    }
  }
  if (!(response.status >= 200 && response.status < 300)) {
    const detail =
      typeof answer.message === "string"
        ? answer.message
        : typeof answer.error === "string"
          ? answer.error
          : text.slice(0, 200) || "no body";
    throw new IdriveKeyError(action, response.status, detail);
  }
  return answer;
}

/**
 * The first value present under one of the names a vendor answer can use. The
 * reseller API's own spelling is snake_case; the camelCase and PascalCase
 * shapes are what the same answer looks like behind a gateway that re-cases
 * it, and reading only one spelling is how a working key is reported missing.
 * @param {Record<string, unknown>} answer
 * @param {ReadonlyArray<string>} names
 * @returns {string|null}
 */
function firstString(answer, names) {
  for (const name of names) {
    const value = answer[name];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return null;
}

/**
 * The iDrive e2 key provider: mint on one bucket, revoke by key id, list the
 * deployment's keys.
 *
 * `expiryOn`, when given, is the epoch second the key stops working at; the
 * vendor takes it as `expiry_on`. null means the vendor keeps the key until it
 * is removed, which is what a person's device key is for.
 * @param {IdriveKeyProviderConfig} config
 */
export function createIdriveKeyProvider(config) {
  const { apiEndpoint, apiToken, provisionBuckets = false, storage, fetchImpl = fetch } = config;
  /** @type {import("./s3.js").S3ClientConfig|undefined} */
  const storageConfig = storage;
  if (provisionBuckets && !storageConfig) {
    throw new TypeError(
      "The iDrive key provider needs the storage master credential to provision buckets.",
    );
  }

  return {
    /**
     * One key limited to the scope's own bucket.
     * @param {import("./keyprovider.js").KeyScope} scope
     * @param {{expiresAt?: number|null}} [options]
     * @returns {Promise<IdriveMintedKey>}
     */
    async mint(scope, options = {}) {
      // A scope that names no bucket is refused below rather than minted
      // against everything the vendor allows, so the read below is a double
      // cast: the declared type promises a bucket, and the runtime proves it.
      const bucket = /** @type {string|undefined} */ (
        /** @type {Record<string, unknown>} */ (scope).bucket
      );
      if (typeof bucket !== "string" || bucket === "") {
        // A scope with no bucket cannot name a vendor key: the vendor's own
        // model limits a key to buckets, so there is nothing to mint against.
        throw new TypeError(
          "The iDrive key provider needs a scope that names its bucket (keyprovider.js scopeFor).",
        );
      }
      if (provisionBuckets && storageConfig) {
        const client = createS3Client(storageConfig);
        // Idempotent, and one bucket per customer: the vendor allows unlimited
        // buckets, so provisioning is the sign-up act the bucket model needs.
        await provisionBucket(client, { bucket, sse: "AES256" });
      }
      // A key without the delete capability is an agent's key: its delete adds
      // a delete marker, and `disable_delete_version` is what stops it lifting
      // or destroying the hidden version behind that marker, so `drive restore`
      // always has something to restore. A person's device key keeps delete and
      // gets neither switch. Every key gets `disable_delete_bucket`, on every
      // mint, because no customer key has any business removing a bucket.
      const disableDeleteVersion = !scope.capabilities.includes("delete");
      const answer = await callResellerApi(
        apiEndpoint,
        apiToken,
        "create_access_key",
        {
          buckets: [bucket],
          permissions: READ_WRITE_PERMISSION,
          disable_delete_object: false,
          disable_delete_version: disableDeleteVersion,
          disable_delete_bucket: true,
          ...(options.expiresAt === null || options.expiresAt === undefined
            ? {}
            : { expiry_on: options.expiresAt }),
        },
        fetchImpl,
      );
      const accessKeyId = firstString(answer, [
        "access_key_id",
        "accessKeyId",
        "AccessKeyId",
        "key_id",
        "id",
      ]);
      const secret = firstString(answer, [
        "secret_access_key",
        "secretAccessKey",
        "SecretAccessKey",
        "secret",
      ]);
      if (accessKeyId === null || secret === null) {
        // A 200 without both halves is not a credential, and handing one back
        // half-built would fail later, on a user's file.
        const missing = [
          accessKeyId === null ? "access key id" : null,
          secret === null ? "secret" : null,
        ]
          .filter((part) => part !== null)
          .join(" and ");
        throw new IdriveKeyError(
          "mint an iDrive storage key",
          200,
          `the answer was missing ${missing}`,
        );
      }
      const expiryOn = firstString(answer, ["expiry_on", "expiryOn", "expires_on"]);
      return {
        accessKeyId,
        secret,
        sessionToken: null,
        expiresIn: null,
        bucket,
        disableDeleteVersion,
        ...(expiryOn === null ? {} : { vendorExpiryOn: expiryOn }),
      };
    },

    /**
     * Withdraw one key at the vendor. The api's own store refuses the row at
     * once; this is the half that stops the credential itself working.
     * @param {string} accessKeyId the vendor's key id, the device row's own
     *   `accessKeyId`
     */
    async revoke(accessKeyId) {
      await callResellerApi(
        apiEndpoint,
        apiToken,
        "remove_access_key",
        {
          access_key_id: accessKeyId,
        },
        fetchImpl,
      );
    },

    /**
     * The deployment's keys, as the vendor lists them. Read-only, and used by
     * the reconciler and by an operator checking a revoke really landed.
     * @returns {Promise<Array<Record<string, unknown>>>}
     */
    async list() {
      const answer = await callResellerApi(
        apiEndpoint,
        apiToken,
        "list_access_keys",
        {},
        fetchImpl,
      );
      for (const name of ["keys", "access_keys", "accessKeys", "data"]) {
        const value = answer[name];
        if (Array.isArray(value)) {
          return /** @type {Array<Record<string, unknown>>} */ (value);
        }
      }
      return [];
    },
  };
}
