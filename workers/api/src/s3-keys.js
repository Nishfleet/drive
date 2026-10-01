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
// the endpoint, region, bucket and master credential are the whole of the
// configuration difference between the local stand-in, iDrive e2 and B2.
//
// Revoking a minted key is deliberately not here: a temporary S3 credential
// cannot be withdrawn before it expires, so the provider is built with a
// bounded session and the store still refuses a revoked key on its own
// storage API. Withdrawing the credential at the provider is the vendor's key
// API and lands with iDrive e2 (issue #173).

import { S3Error, createS3Client, ok, tagValue } from "./s3.js";

/**
 * @typedef {import("./keyprovider.js").Capability} Capability
 * @typedef {import("./keyprovider.js").KeyScope} KeyScope
 */

/**
 * The S3 actions a drive capability needs. There is no second table of powers
 * by kind: the capabilities come from the one table in keyprovider.js, and
 * this is how each capability is spelled to a storage server. An agent key's
 * missing `delete` is visible in the policy the endpoint enforces.
 * @type {Readonly<Record<Capability, ReadonlyArray<string>>>}
 */
const ACTIONS_BY_CAPABILITY = Object.freeze({
  // A listing is `ListBucket` on the bucket, and the prefix condition on the
  // statement below is what keeps it inside one account's folder.
  list: Object.freeze(["s3:ListBucket", "s3:ListBucketVersions"]),
  read: Object.freeze(["s3:GetObject", "s3:GetObjectVersion"]),
  // Multipart is what rclone writes a large file with, so a write that could
  // not finish a multipart upload would fail on the big files, not the small
  // ones.
  write: Object.freeze([
    "s3:PutObject",
    "s3:AbortMultipartUpload",
    "s3:ListBucketMultipartUploads",
    "s3:ListMultipartUploadParts",
  ]),
  // Only the marker a plain delete leaves. Removing a named version is a
  // different power (`s3:DeleteObjectVersion`) and is not granted: it is how a
  // hidden version would be destroyed instead of kept for a day.
  delete: Object.freeze(["s3:DeleteObject"]),
});

/**
 * The session policy for one key scope: the object actions on the account's
 * own prefix, and the listing actions on the bucket limited to that prefix.
 * Exported so the policy can be asserted on directly (build step 1) and read
 * in a review without running the provider.
 * @param {KeyScope} scope
 * @param {string} bucket
 * @returns {{Version: string, Statement: Array<Record<string, unknown>>}}
 */
export function policyForScope(scope, bucket) {
  const actions = scope.capabilities.flatMap((capability) => ACTIONS_BY_CAPABILITY[capability]);
  if (actions.length === 0) {
    throw new TypeError(
      `A key with no capabilities (${JSON.stringify(scope.capabilities)}) would be refused by every request; refusing to mint it.`,
    );
  }
  const folder = scope.prefix.replace(/\/*$/, "");
  /** @type {Array<Record<string, unknown>>} */
  const statements = [];
  if (scope.capabilities.includes("list")) {
    statements.push({
      Effect: "Allow",
      Action: ACTIONS_BY_CAPABILITY.list,
      Resource: [`arn:aws:s3:::${bucket}`],
      // The bucket is the resource, so the prefix cannot be a resource
      // string: it is the condition. `folder/*` is everything inside the
      // account, `folder` is the folder marker itself.
      Condition: { StringLike: { "s3:prefix": [`${folder}/*`, folder] } },
    });
  }
  statements.push({
    Effect: "Allow",
    Action: [...new Set(actions)],
    Resource: [`arn:aws:s3:::${bucket}/${scope.prefix}*`],
  });
  return { Version: "2012-10-17", Statement: statements };
}

/**
 * @typedef {object} S3KeyProviderConfig
 * @property {string} endpoint
 * @property {string} region
 * @property {string} bucket
 * @property {string} masterAccessKeyId
 * @property {string} masterSecretAccessKey
 * @property {number} [sessionSeconds] how long a minted credential lives
 * @property {string} [sessionName]
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * @typedef {object} MintedStorageKey
 * @property {string} accessKeyId
 * @property {string} secret
 * @property {string} sessionToken
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
    bucket,
    masterAccessKeyId,
    masterSecretAccessKey,
    sessionSeconds = 3600,
    sessionName = "drive-key",
    fetchImpl = fetch,
  } = config;
  if (!bucket || !masterAccessKeyId || !masterSecretAccessKey) {
    throw new TypeError("The S3 key provider needs a bucket and the master credential.");
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
      const policy = policyForScope(scope, bucket);
      // STS answers on the service root with the parameters in the form body
      // and no query string, signed for the `sts` service with the same region
      // and master credential (AWS's own AssumeRole shape).
      const body = new URLSearchParams({
        Action: "AssumeRole",
        Version: "2011-06-15",
        DurationSeconds: String(sessionSeconds),
        RoleSessionName: sessionName,
        Policy: JSON.stringify(policy),
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
      return { accessKeyId, secret, sessionToken, policy, expiresIn: sessionSeconds };
    },
  };
}
