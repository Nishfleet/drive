// iDrive e2 refuses STS `AssumeRole` outright (403 AccessDenied).

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
  write: Object.freeze(["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]),
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
    namesSession: /** @type {true} */ (true),

    /**
     * One scoped credential. The returned secret is the only copy the api
     * ever holds: the store keeps its hash, exactly as the stand-in did.
     * @param {KeyScope} scope
     * @returns {Promise<MintedStorageKey>}
     */
    async mint(scope) {
      const bucket = typeof scope.bucket === "string" && scope.bucket !== "" ? scope.bucket : null;
      if (bucket === null) {
        throw new TypeError(
          "The S3 key provider needs a scope that names its bucket (keyprovider.js scopeFor).",
        );
      }
      const policy = policyForScope(scope, bucket);
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
        throw new S3Error(
          "mint a scoped storage key",
          answer.status,
          "IncompleteAssumeRole",
          `the answer was missing ${missing} of 3 credential fields`,
        );
      }
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
 * @returns {ReturnType<typeof createS3KeyProvider>|{namesSession: true, mint: () => never, revoke: () => never, swapToReadOnly: () => never}|null}
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
      namesSession: true,
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
