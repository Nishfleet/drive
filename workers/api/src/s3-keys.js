// Key minting against the storage endpoint itself: the api Worker holds the
// master credential and hands out credentials the storage server enforces
// (build step 1, drive#2).
//
// Before this, a minted key was an id and a secret the api Worker remembered
// in its own store, so the scope of a key was a promise the Worker made. Now
// the scope is a policy handed to the storage server, which refuses the calls
// it does not allow: an agent key that cannot delete is refused by storage,
// and a key pointed at another account's prefix is refused by storage. The
// proofs in test/step1-storage.test.mjs read those refusals off real S3
// answers.
//
// The mint is STS `AssumeRole` with a session policy, which is stock S3, so
// the endpoint, region and master credential are the whole of the
// configuration difference between the local stand-in and a provider that
// mints this way. MinIO and Backblaze B2 do; iDrive e2 refuses `AssumeRole`
// outright (403 AccessDenied, measured 2026-10-03, drive#173), so its bucket
// settings come from this module but its keys cannot.
//
// The bucket a minted key is scoped to is the key scope's own, never this
// provider's: one bucket per account and one per team (keyprovider.js
// `bucketForAccount` / `bucketForTeam`, drive#371), so the boundary the
// storage server enforces is the account. drive#462 measured the other way
// round on the real Mac run of 2026-10-04: the mint resolved its bucket from
// the deployment's `STORAGE_BUCKET`, so every key the deployment minted was
// scoped to the one shared bucket, and the prefix was the only thing left
// separating two accounts' files.
//
// Revoking a minted key is deliberately not here: a temporary S3 credential
// cannot be withdrawn before it expires, so the provider is built with a
// bounded session and the store still refuses a revoked key on its own
// storage API. Withdrawing the credential at the provider is the vendor's key
// API, which iDrive e2 does not expose over S3 (measured, drive#173).

import { createS3Client, ok, S3Error, tagValue } from "./s3.js";

/**
 * @typedef {import("./keyprovider.js").Capability} Capability
 * @typedef {import("./keyprovider.js").KeyScope} KeyScope
 */

/**
 * The S3 actions a drive capability needs on an OBJECT. There is no second
 * table of powers by kind: the capabilities come from the one table in
 * keyprovider.js, and this is how each capability is spelled to a storage
 * server. An agent key's missing `delete` is visible in the policy the
 * endpoint enforces.
 * @type {Readonly<Partial<Record<Capability, ReadonlyArray<string>>>>}
 */
const OBJECT_ACTIONS_BY_CAPABILITY = Object.freeze({
  read: Object.freeze(["s3:GetObject", "s3:GetObjectVersion"]),
  // Multipart is what rclone writes a large file with, so a write that could
  // not finish a multipart upload would fail on the big files, not the small
  // ones. These three all act on the object; the bucket-wide multipart listing
  // is explained in BUCKET_ACTIONS_BY_CAPABILITY.
  write: Object.freeze(["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]),
  // `s3:DeleteObject` is the marker a plain delete leaves; `s3:DeleteObject`
  // with a version id is what `drive restore` uses to lift that marker and
  // bring the last save back (build step 1's done-when). Both are the delete
  // capability, and only a device key has it — an agent key is refused either
  // one by the endpoint, so an agent can never destroy the hidden version a
  // delete left behind.
  delete: Object.freeze(["s3:DeleteObject", "s3:DeleteObjectVersion"]),
});

/**
 * The S3 actions a capability needs on the BUCKET, which are the ones whose
 * resource is the bucket rather than an object. They go in their own
 * statement with the prefix condition; granted on an object resource they
 * would be inert. `s3:ListBucketMultipartUploads` is deliberately NOT here: it
 * is a bucket-wide listing that no prefix condition can narrow — a stock S3
 * server answers "unsupported condition keys '[s3:prefix]' used for action
 * 's3:ListBucketMultipartUploads'" (measured 2026-10-01 against the pinned
 * stand-in) — so granting it would either be inert or hand one account a
 * listing of the whole bucket. rclone's multipart write path uses the
 * object-level write actions above; enumerating in-progress uploads is the
 * reconciler's job under the master credential, not a per-account key's.
 * @type {Readonly<Partial<Record<Capability, ReadonlyArray<string>>>>}
 */
const BUCKET_ACTIONS_BY_CAPABILITY = Object.freeze({
  // A listing is `ListBucket` on the bucket, and the prefix condition on the
  // statement is what keeps it inside one account's folder.
  list: Object.freeze(["s3:ListBucket", "s3:ListBucketVersions"]),
});

/**
 * The session policy for one key scope: the object actions on the account's
 * own prefix, and the listing actions on the bucket limited to that prefix.
 * Exported so the policy can be asserted on directly (build step 1) and read
 * in a review without running the provider.
 *
 * The bucket is an argument only so a caller that has already resolved it
 * does not resolve it twice, and it must be the scope's own: a policy that
 * names one bucket while the mint answers with another is a key scoped to
 * somewhere the caller did not mean, so a scope that names a bucket and an
 * argument that names a different one is refused rather than resolved in
 * either direction. A scope that names no bucket still takes the argument,
 * which is how the test asserts a policy against a bucket it built itself.
 * @param {KeyScope} scope
 * @param {string} bucket
 * @returns {{Version: string, Statement: Array<Record<string, unknown>>}}
 */
export function policyForScope(scope, bucket) {
  if (scope.bucket !== undefined && scope.bucket !== bucket) {
    throw new TypeError(
      `A key scope is scoped to the bucket it names, and this policy is for another: ${JSON.stringify(scope.bucket)} against ${JSON.stringify(bucket)}.`,
    );
  }
  if (!scope.prefix.endsWith("/")) {
    // A prefix without its trailing slash would make `u/a*` also match
    // `u/ab/…` — a cross-account widening. scopeFor() always ends the prefix
    // with a slash; this refuses a scope that does not rather than widening.
    throw new TypeError(`A key prefix must end with "/", got ${JSON.stringify(scope.prefix)}.`);
  }
  const objectActions = scope.capabilities.flatMap(
    (capability) => OBJECT_ACTIONS_BY_CAPABILITY[capability] ?? [],
  );
  const bucketActions = scope.capabilities.flatMap(
    (capability) => BUCKET_ACTIONS_BY_CAPABILITY[capability] ?? [],
  );
  if (objectActions.length === 0 && bucketActions.length === 0) {
    throw new TypeError(
      `A key with no capabilities (${JSON.stringify(scope.capabilities)}) would be refused by every request; refusing to mint it.`,
    );
  }
  const folder = scope.prefix.replace(/\/*$/, "");
  /** @type {Array<Record<string, unknown>>} */
  const statements = [];
  if (bucketActions.length > 0) {
    statements.push({
      Effect: "Allow",
      Action: [...new Set(bucketActions)],
      Resource: [`arn:aws:s3:::${bucket}`],
      // The bucket is the resource, so the prefix cannot be a resource
      // string: it is the condition. `folder/*` is everything inside the
      // account, `folder` is the folder marker itself.
      Condition: { StringLike: { "s3:prefix": [`${folder}/*`, folder] } },
    });
  }
  if (objectActions.length > 0) {
    statements.push({
      Effect: "Allow",
      Action: [...new Set(objectActions)],
      Resource: [`arn:aws:s3:::${bucket}/${scope.prefix}*`],
    });
  }
  return { Version: "2012-10-17", Statement: statements };
}

/**
 * @typedef {object} S3KeyProviderConfig
 * @property {string} endpoint
 * @property {string} region
 * @property {string} masterAccessKeyId
 * @property {string} masterSecretAccessKey
 * @property {number} [sessionSeconds] how long a minted credential lives
 * @property {string} [sessionName]
 * @property {string} [roleArn] the ARN the provider's STS wants in the
 *   AssumeRole call. MinIO does not need one. Drive#173 measured iDrive e2
 *   (2026-10-03) and a role ARN is no help there: its STS refuses AssumeRole
 *   outright, so no scoped key can be minted on it at all.
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * @typedef {object} MintedStorageKey
 * @property {string} accessKeyId
 * @property {string} secret
 * @property {string} sessionToken
 * @property {string} bucket the bucket the credential is scoped to, which is
 *   the key scope's own bucket (`drv-<accountId>`, `drv-t-<teamId>`) and the
 *   boundary the storage server enforces
 * @property {ReturnType<typeof policyForScope>} policy
 * @property {number} expiresIn
 */

/**
 * Mints a scoped credential for a key scope.
 * @param {S3KeyProviderConfig} config
 */
export function createS3KeyProvider(config) {
  const {
    endpoint,
    region,
    masterAccessKeyId,
    masterSecretAccessKey,
    sessionSeconds = 3600,
    sessionName,
    roleArn,
    fetchImpl = fetch,
  } = config;
  if (!masterAccessKeyId || !masterSecretAccessKey) {
    throw new TypeError("The S3 key provider needs the master credential.");
  }
  if (!Number.isInteger(sessionSeconds) || sessionSeconds < 900 || sessionSeconds > 43200) {
    throw new TypeError(
      `sessionSeconds must be a whole number of seconds between 900 and 43200, got ${sessionSeconds}.`,
    );
  }
  const master = createS3Client({
    endpoint,
    region,
    service: "sts",
    credentials: { accessKeyId: masterAccessKeyId, secretAccessKey: masterSecretAccessKey },
    fetchImpl,
  });

  return {
    /**
     * One scoped credential. The returned secret is the only copy the api
     * ever holds: the store keeps its hash, exactly as the stand-in did.
     * @param {KeyScope} scope
     * @returns {Promise<MintedStorageKey>}
     */
    async mint(scope) {
      // The scope's own bucket, and nothing else. drive#371 moved the boundary
      // from the prefix to the bucket: a key scoped to one bucket cannot list,
      // read or write another account's, whatever the prefix inside it, and
      // that is the guarantee the old `u/<id>/` prefix could not give on a
      // vendor that cannot scope a key to a folder. So a scope that names no
      // bucket is refused, exactly as the iDrive provider refuses one
      // (idrive-keys.js): handing it the deployment's own bucket instead would
      // mint a key for the shared bucket, which is the bug drive#462 found.
      const bucket = typeof scope.bucket === "string" && scope.bucket !== "" ? scope.bucket : null;
      if (bucket === null) {
        throw new TypeError(
          "The S3 key provider needs a scope that names its bucket (keyprovider.js scopeFor).",
        );
      }
      const policy = policyForScope(scope, bucket);
      // STS answers on the service root with the parameters in the form body
      // and no query string, signed for the `sts` service with the same region
      // and master credential (AWS's own AssumeRole shape).
      const body = new URLSearchParams({
        Action: "AssumeRole",
        Version: "2011-06-15",
        DurationSeconds: String(sessionSeconds),
        RoleSessionName: sessionName ?? `drive-key-${crypto.randomUUID().slice(0, 8)}`,
        Policy: JSON.stringify(policy),
        ...(roleArn === undefined || roleArn === "" ? {} : { RoleArn: roleArn }),
      }).toString();
      const answer = await master.send("POST", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      ok("mint a scoped storage key", answer);

      const accessKeyId = tagValue(answer.text, "AccessKeyId");
      const secret = tagValue(answer.text, "SecretAccessKey");
      const sessionToken = tagValue(answer.text, "SessionToken");
      const missing = [accessKeyId, secret, sessionToken].filter((part) => part === null).length;
      if (accessKeyId === null || secret === null || sessionToken === null) {
        // A 200 without all three fields is not a credential, and handing one
        // back half-built would fail later, on a user's file.
        throw new S3Error(
          "mint a scoped storage key",
          answer.status,
          "IncompleteAssumeRole",
          `the answer was missing ${missing} of 3 credential fields`,
        );
      }
      // The bucket is part of the answer, not a detail of the policy: the
      // store keeps it on the key row it hands back and the callers mount this
      // bucket, so a mint is where an account's own bucket name is learned.
      return { accessKeyId, secret, sessionToken, bucket, policy, expiresIn: sessionSeconds };
    },
  };
}

/**
 * The storage provider a deployment's env carries, or null when it carries
 * none. All four STORAGE_* values or none: a half-configured deployment
 * would mint keys the endpoint has never heard of, so the mint throws and
 * every other route keeps answering. The stub matches the KeyProvider
 * shape (`mint`, `revoke`, `swapToReadOnly`) so a cap swap hits the same
 * refusal, not a missing method.
 *
 * No bucket is configured here, and that is deliberate: the bucket a key is
 * scoped to is the scope's own (keyprovider.js `bucketForAccount` /
 * `bucketForTeam`), so a deployment-wide bucket is not a thing this provider
 * can be given. drive#462 removed `STORAGE_BUCKET` from this list for that
 * reason: with it, every key the deployment minted was scoped to the one
 * bucket it named.
 *
 * Shared by the api Worker (POST /v1/keys) and the site Worker
 * (`drive cap` on POST /api/cap): one function, so a deployment that can
 * mint a device key can also swap it.
 * @param {{[key: string]: unknown}} env
 * @returns {ReturnType<typeof createS3KeyProvider>|{mint: () => never, revoke: () => never, swapToReadOnly: () => never}|null}
 */
export function s3KeyProviderFromEnv(env) {
  const names = [
    "STORAGE_ENDPOINT",
    "STORAGE_REGION",
    "STORAGE_MASTER_ACCESS_KEY_ID",
    "STORAGE_MASTER_SECRET_ACCESS_KEY",
  ];
  const values = names
    .map((name) => env[name])
    .filter((value) => typeof value === "string" && value.length > 0);
  if (values.length === 0) {
    return null;
  }
  if (values.length < names.length) {
    const missing = names.filter((name) => typeof env[name] !== "string" || env[name] === "");
    const problem = new Error(
      `Storage is half-configured: set all of ${names.join(", ")}. Missing: ${missing.join(", ")}.`,
    );
    return {
      mint() {
        throw problem;
      },
      revoke() {
        throw problem;
      },
      swapToReadOnly() {
        throw problem;
      },
    };
  }
  return createS3KeyProvider({
    endpoint: /** @type {string} */ (env.STORAGE_ENDPOINT),
    region: /** @type {string} */ (env.STORAGE_REGION),
    masterAccessKeyId: /** @type {string} */ (env.STORAGE_MASTER_ACCESS_KEY_ID),
    masterSecretAccessKey: /** @type {string} */ (env.STORAGE_MASTER_SECRET_ACCESS_KEY),
    ...(typeof env.STORAGE_ROLE_ARN === "string" && env.STORAGE_ROLE_ARN !== ""
      ? { roleArn: env.STORAGE_ROLE_ARN }
      : {}),
  });
}
