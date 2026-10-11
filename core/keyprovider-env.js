// Which key provider a deployment gets, chosen from the credentials it
// carries, read in one place so both Workers agree.
//
// Drive#371 mints a storage key at the deployment's own vendor, and both
// Workers need to answer "which provider is this deployment on?": the api
// Worker mints and swaps keys with it, and the site Worker's account close and
// cap routes withdraw a key's credential at the same vendor (drive#235,
// drive#497). A second copy of this choice in either Worker is a second thing
// to drift: close could revoke at the S3 provider while the api minted through
// the reseller API, and the key would keep working at the storage server.
//
// This module reads the env and returns a provider, and nothing else. It is
// shared by `workers/api/src/index.js` (the api Worker's `storeFor`) and
// `src/index.js` (the site Worker's `closeDepsFor` and cap route), so one
// deployment configuration has one answer.

import { createIdriveKeyProvider } from "./idrive-keys.js";
import { s3KeyProviderFromEnv } from "./s3-keys.js";

/**
 * The reseller API base iDrive e2 publishes for access keys
 * (https://www.idrive.com/s3-storage-e2/reseller-api, drive#371). A deployment
 * overrides it with `IDRIVE_E2_API_ENDPOINT`, the same way `STORAGE_*` override
 * the S3 endpoint.
 */
const IDRIVE_RESELLER_API = "https://api.idrivee2.com/api/reseller/v1";

/**
 * The endpoint and region `drive login` writes into this device's storage
 * settings. The account's own bucket comes from the mint's scope
 * (`keyprovider.js` `scopeFor`), not from a shared deployment bucket.
 * @param {{[key: string]: unknown}} env
 * @returns {{endpoint: string, region: string}|undefined}
 */
export function storageLocationFromEnv(env) {
  if (typeof env.STORAGE_ENDPOINT === "string" && env.STORAGE_ENDPOINT !== "") {
    return {
      endpoint: env.STORAGE_ENDPOINT,
      region:
        typeof env.STORAGE_REGION === "string" && env.STORAGE_REGION !== ""
          ? env.STORAGE_REGION
          : "us-east-1",
    };
  }
  if (typeof env.IDRIVE_E2_API_TOKEN === "string" && env.IDRIVE_E2_API_TOKEN !== "") {
    return {
      endpoint:
        typeof env.IDRIVE_S3_ENDPOINT === "string" && env.IDRIVE_S3_ENDPOINT !== ""
          ? env.IDRIVE_S3_ENDPOINT
          : "https://s3.eu-west-3.idrivee2.com",
      region:
        typeof env.IDRIVE_S3_REGION === "string" && env.IDRIVE_S3_REGION !== ""
          ? env.IDRIVE_S3_REGION
          : "eu-west-3",
    };
  }
  return undefined;
}

/**
 * The storage configuration a deployment carries, or null when it carries
 * none. All five values or none: a half-configured deployment would mint keys
 * the storage endpoint has never heard of, which reads at the user as "your
 * new key does not work". A half-configured deployment is therefore refused
 * at the MINT, not at every route: the error comes back as a provider whose
 * `mint` throws, so the one operation that needs the storage credential is
 * the one that fails and every other route keeps answering. (Rotating the
 * master credential needs the isolate to restart, the same way the stand-in
 * store does; a redeploy restarts it.)
 *
 * Which provider a deployment gets is which credentials it carries, not which
 * vendor is in a config file:
 *
 *   - `STORAGE_*` alone is the S3 path: STS `AssumeRole` with a session policy
 *     scoped to the key's prefix (`s3-keys.js`). The pinned stand-in and
 *     Backblaze B2 both mint this way, and a key's scope is a policy the
 *     endpoint enforces.
 *   - `IDRIVE_E2_API_TOKEN` is the vendor's own path (drive#371): iDrive e2
 *     cannot scope a key to a folder, only to a bucket, so the mint is the
 *     reseller API's `create_access_key` naming the account's own bucket
 *     (`idrive-keys.js`), and a revoke is that API's `remove_access_key` — a
 *     revoked key really stops working at the vendor, not only in the api's
 *     own store. iDrive e2 also has no event notifications over the bucket
 *     API (measured, drive#173), so a deployment that mints this way meters
 *     from the nightly reconciler and the vendor's usage calls rather than
 *     from `/v1/events` (see "Metering without events" in docs/build-spec.md).
 *
 * The half-configured stub matches the KeyProvider shape (`mint`, `revoke`,
 * `swapToReadOnly`) so a later cap swap hits the same refusal, not a missing
 * method.
 * @param {{[key: string]: unknown}} env
 * @returns {ReturnType<typeof s3KeyProviderFromEnv>|ReturnType<typeof createIdriveKeyProvider>|null}
 */
export function keyProviderFor(env) {
  const s3 = s3KeyProviderFromEnv(env);
  if (s3 !== null) {
    return s3;
  }
  // The iDrive path carries the reseller API token and, when it provisions
  // buckets, the S3 master credential the provisioning call needs
  // (drive#371). The token alone mints against buckets that already exist.
  const apiToken = env.IDRIVE_E2_API_TOKEN;
  if (typeof apiToken !== "string" || apiToken === "") {
    return null;
  }
  // The bucket a scope names is provisioned once, before the key limited to
  // it is handed out (drive#371: one bucket per customer is the boundary,
  // so the bucket has to exist before a key can name it). The provisioning
  // call is an S3 call, so it needs the S3 master credential; a deployment
  // that provisions its buckets elsewhere (the console, the reconciler)
  // carries the reseller token alone and mints against buckets that are
  // already there. The two are not mixed up: no credential means no
  // provisioning, never a provisioning call with half a credential.
  const s3AccessKeyId = env.IDRIVE_S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = env.IDRIVE_S3_SECRET_ACCESS_KEY;
  const storageConfig =
    typeof s3AccessKeyId === "string" &&
    s3AccessKeyId !== "" &&
    typeof s3SecretAccessKey === "string" &&
    s3SecretAccessKey !== ""
      ? {
          endpoint:
            typeof env.IDRIVE_S3_ENDPOINT === "string" && env.IDRIVE_S3_ENDPOINT !== ""
              ? env.IDRIVE_S3_ENDPOINT
              : "https://s3.eu-west-3.idrivee2.com",
          region:
            typeof env.IDRIVE_S3_REGION === "string" && env.IDRIVE_S3_REGION !== ""
              ? env.IDRIVE_S3_REGION
              : "eu-west-3",
          credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey },
        }
      : undefined;
  return createIdriveKeyProvider({
    apiEndpoint:
      typeof env.IDRIVE_E2_API_ENDPOINT === "string" && env.IDRIVE_E2_API_ENDPOINT !== ""
        ? env.IDRIVE_E2_API_ENDPOINT
        : IDRIVE_RESELLER_API,
    apiToken,
    ...(storageConfig === undefined ? {} : { provisionBuckets: true, storage: storageConfig }),
  });
}

/**
 * The dl Worker's host and the grant secret (drive#517), or undefined unless
 * both are set: `DL_BASE_URL` (e.g. `https://dl.example`) and
 * `DL_SIGNING_SECRET`, the same secret the dl Worker checks grants with. They
 * are per-deployment vars, not declared bindings, so a deployment without a
 * dl Worker mints keys exactly as before, with no download URL.
 * @param {{[key: string]: unknown}} env
 * @returns {{baseUrl: string, secret: string}|undefined}
 */
export function downloadFromEnv(env) {
  const baseUrl = env.DL_BASE_URL;
  const secret = env.DL_SIGNING_SECRET;
  if (typeof baseUrl !== "string" || !/^https?:\/\/[^/]/.test(baseUrl)) {
    return undefined;
  }
  if (typeof secret !== "string" || secret === "") {
    return undefined;
  }
  return { baseUrl, secret };
}
