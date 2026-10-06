// Site-worker env helpers. Extracted from src/index.js (drive issue #617)
// with no behaviour change; src/index.js keeps the route table and re-exports
// nothing here that tests import.

import { createD1DeviceStore } from "../workers/api/src/devices.js";
import { errorResponse } from "../workers/api/src/http.js";
import { keyProviderFor } from "../workers/api/src/keyprovider-env.js";
import { createD1QueueStore } from "../workers/api/src/queues.js";
import { createKvSnapshotStore } from "./branches.js";
import { capStateForAccount } from "./cap.js";
import {
  createMemoryStore,
  createS3Store,
  storageBucketForKey,
  storageVarsFromEnv,
} from "./files.js";
import { failureMessage } from "./messages.js";
import { createD1LinkStore } from "./share.js";

/**
 * The per-request value Hono's context carries.
 * @typedef {{account: {id: string, name: string, email: string|null}|null}} DriveVariables
 */
/**
 * @typedef {import("hono").Context<{Bindings: Env, Variables: DriveVariables}>} DriveContext
 */

/**
 * The Dodo settings this Worker reads, none of them declared bindings: each is
 * unset until Nish sets the live account up (#325), and every route that needs
 * one answers a closed door without it. DODO_FETCH is the tests' recorder.
 * @param {Env} env
 */
export function dodoEnv(env) {
  return /** @type {{DODO_PAYMENTS_API_KEY?: string, DODO_BASE_URL?: string, DODO_TOPUP_PRODUCT_ID?: string, DODO_WEBHOOK_SECRET?: string, DODO_FETCH?: typeof fetch, MAIL_FROM?: string, PREPAID_PAUSE?: string}} */ (
    /** @type {unknown} */ (env)
  );
}

// One store per Worker isolate. With no storage configured the in-memory
// store holds what the page uploaded this run, so the Web Files page is real
// in dev and in the tests. An S3 endpoint (FILES_S3_ENDPOINT, or the same
// IDRIVE_S3_ENDPOINT the api Worker uses) points the same handlers at storage;
// each account's objects live in that account's own bucket (`drv-<id>`,
// storageBucketForKey / bucketForAccount), which is the same name a Finder
// key is minted into (drive#371 / #460). The account prefix is still
// scopeStore's job (src/files.js).
/** @type {import("./files.js").FileStore|undefined} */
let filesStore;
/**
 * Storage config vars. They are set per deployment, never declared as
 * bindings in cloudflare.config.ts: a declared secret is required at deploy,
 * and the Files page already answers from the in-memory store when they are
 * unset. The names match the api Worker's iDrive pair so the site Worker can
 * read the buckets a minted key writes to, plus the older FILES_S3_* stand-in
 * pair a local `rclone serve s3` still uses. The typedef's one definition is
 * src/files.js's, beside the one reader of the vars.
 * @typedef {import("./files.js").StorageEnv} StorageEnv
 * @param {Env} env
 * @returns {StorageEnv}
 */
function devStorage(env) {
  return /** @type {StorageEnv} */ (env);
}

/**
 * The close handlers' dependencies, or null when this deployment has no
 * customer database. A missing database is a 503 from the route, not an
 * in-memory close that would vanish on the next isolate.
 * @param {Env} env
 */
export function closeDepsFor(env) {
  if (!env.DRIVE_DB) {
    return null;
  }
  const secrets = /** @type {Env & {MAIL_FROM?: string}} */ (env);
  return {
    devices: createD1DeviceStore(env.DRIVE_DB, {
      keyProvider: keyProviderFor(env) ?? undefined,
    }),
    store: storeFor(env),
    email: env.EMAIL,
    mailFrom: secrets.MAIL_FROM ?? "",
    now: () => Date.now(),
  };
}

/**
 * The api Worker's service binding, read off this Worker's own env as the
 * optional value it is until the api Worker is deployed (drive#156/#341,
 * #342). It is read here rather than declared in cloudflare.config.ts for the
 * same reason devStorage's two vars are: a declared binding is required at
 * deploy, and Cloudflare fails this Worker's own deploy against a service
 * binding whose target Worker does not exist
 * (https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#deployment
 * — "the target Worker must be deployed first, before Worker A. Otherwise,
 * when you attempt to deploy Worker A, deployment will fail"). So the
 * binding is declared when the deploy step ships drive-api beside this
 * Worker, and until then the /v1/* family answers its closed door instead of
 * pretending to be routed.
 * @param {Env} env
 * @returns {Env & {API?: Fetcher}}
 */
function apiBinding(env) {
  return /** @type {Env & {API?: Fetcher}} */ (env);
}

/**
 * The forward to the api Worker over the service binding, shared by the two
 * routes this Worker forwards: the /v1/* family and the one /api/* route
 * registered ahead of the account gate. The request goes over unchanged —
 * method, path, query, headers and body — and the api Worker's own dispatcher
 * answers it with its own gate, its own edge limits and its own words.
 * Nothing either family serves is re-implemented on this side.
 *
 * A deployment with no binding is the closed door, not an open one: the api
 * Worker is a separate deployable that no deploy has shipped yet (its deploy
 * step is the one line the worker App's token cannot push), and a declared
 * binding to a Worker that does not exist fails this Worker's own deploy. So
 * until drive-api is deployed and the binding is declared, both routes say so
 * in the message table's words rather than falling through to the asset layer
 * and serving a 404 page to a CLI mid sign-in.
 * @param {DriveContext} c
 * @returns {Response | Promise<Response>}
 */
export function forwardToApi(c) {
  const api = apiBinding(c.env).API;
  if (!api) return errorResponse(503, failureMessage("unexpected"));
  return api.fetch(c.req.raw);
}

/**
 * @param {Env} env
 * @returns {import("./files.js").FileStore}
 */
export function storeFor(env) {
  if (!filesStore) {
    // The four storage vars read through src/files.js's one reader, the same
    // read provisionAccountBucket makes at the sign-in verify step, so the
    // store and the provisioning cannot name two endpoints.
    const { endpoint, accessKeyId, secretAccessKey, region } = storageVarsFromEnv(devStorage(env));
    if (endpoint) {
      const signed =
        accessKeyId !== undefined && secretAccessKey !== undefined && region !== undefined;
      filesStore = createS3Store({
        endpoint,
        bucketFor: storageBucketForKey,
        ...(signed
          ? {
              region,
              credentials: {
                accessKeyId: /** @type {string} */ (accessKeyId),
                secretAccessKey: /** @type {string} */ (secretAccessKey),
              },
            }
          : {}),
      });
    } else {
      filesStore = createMemoryStore();
    }
  }
  return filesStore;
}

// One link store over the customer database, built per request from the
// binding rather than cached on the isolate: a link and an upload request are
// rows in DRIVE_DB (src/share.js createD1LinkStore,
// migrations/drive/0006_share_links.sql), so a link minted on one Worker
// instance resolves on the next one and a deploy does not take every link with
// it (issue #207). It used to be a pair of Maps held per isolate, which is
// exactly the bug. The store is a thin object over the binding, so there is
// nothing to hold on to and no stale copy to serve — which is the same shape
// storeFor() has for files. The binding is required: a deployment without
// DRIVE_DB has no way to stand behind a link and is already failing the health
// check's required-bindings list (src/health.js).
/**
 * @param {Env} env
 * @returns {import("./share.js").LinkStore}
 */
export function linksFor(env) {
  return createD1LinkStore(env.DRIVE_DB);
}

// The branch snapshot store (drive issue #252), built per request from the
// BRANCH_SNAPSHOTS binding the same way linksFor builds its link store: a thin
// object over the binding, so there is nothing to hold on the isolate and no
// stale copy to serve. A branch's snapshot is ~117 bytes a file, so a
// 100,000-file branch is ~11 MiB of JSON — twelve times D1's 1 MiB row limit,
// which is why it lives in KV (migrations/drive/0012_branch_snapshot_kv.sql)
// and the row holds a pointer to it instead. Required since drive#329 dropped
// the legacy-column fallback: a missing binding is a 503 on every branch and
// rewind route, and BRANCH_SNAPSHOTS is already on src/health.js
// `REQUIRED_BINDINGS` (required before this change).
// `null` is still the answer a missing binding gets, so the handlers can refuse
// it by name rather than throw on the first put.
/**
 * @param {Env} env
 * @returns {import("./branches.js").SnapshotStore|null}
 */
export function snapshotsFor(env) {
  const kv = env.BRANCH_SNAPSHOTS;
  return kv ? createKvSnapshotStore(kv) : null;
}

// The live upload queue a device on this account reported (drive issue #318),
// read from the same row the api Worker's report route writes. Built per
// request from the binding, like linksFor: a report a mount just sent is the
// row the next poll reads, on whichever instance the poll lands. The
// freshness window is inside the store's read (workers/api/src/queues.js
// `latest`), so the first-run page and the usage page cannot disagree about
// whether a report is live, and a device that has not reported for a while
// reads as no queue to report — the same honest null #308 answers — rather
// than as a stale one. No database means nothing has reported and there is
// nothing to read: null, the same answer as an account whose no device has
// signed in yet.
/**
 * @param {Env} env
 * @param {{id: string}} account
 * @returns {Promise<import("../workers/api/src/queues.js").UploadQueue|null>}
 */
export async function liveQueueFor(env, account) {
  if (!env.DRIVE_DB) {
    return null;
  }
  return createD1QueueStore(env.DRIVE_DB).latest(account.id);
}

// The account's live devices (drive issue #556), read from the same `devices`
// rows the api Worker's key store writes: the first-run page used to be told
// "waiting" for every account, because this route carried no device rows at
// all, so nothing it answered could ever say connected. Built per request from
// the binding like liveQueueFor, for the same reason: a machine that just
// signed in is the row the next poll reads, on whichever instance the poll
// lands on. Whether a device reads as connected is not decided here — the
// window is src/status.js `connectionStatus`'s own — so this one function fills
// the payload and the rule stays in the module the page and the CLI already
// read. No database means no device has signed in yet: the empty list, the
// same answer as an account whose machine has not.
/**
 * @param {Env} env
 * @param {{id: string}} account
 * @returns {Promise<Array<{id: string, name: string, kind: string, lastSeenAt: number|null}>>}
 */
export async function liveDevicesFor(env, account) {
  if (!env.DRIVE_DB) {
    return [];
  }
  return createD1DeviceStore(env.DRIVE_DB).listLive(account);
}

// The owner's spending-cap state for the public upload routes, read from the
// same src/billing.js summary the usage page shows, and resolved per account so
// the cap answered is always the one belonging to the account that minted the
// token (src/share.js handleRequestInfoRequest and
// handleRequestUploadRequest both take a resolver, not a value). Until the
// meter lands (#6) an account has no usage rows, so this is the empty month
// the usage endpoint already answers with — the honest cap for a drive with
// nothing stored. When the meter lands, this one function is the swap point:
// it reads the token owner's usage_minutes rows and answers their cap, and no
// upload route changes.
/**
 * The resolver the public upload-request links ask about the account that owns
 * the link (`capStateForAccount`, src/cap.js, drive#496). It is bound to the
 * environment because the cap is in D1, so the answer for one deployment's
 * account has to come from that deployment's rows and not from a module-level
 * constant.
 *
 * Before the meter, this answered the empty month for every account, so
 * "active", and a public upload link never stopped at its owner's cap. It now
 * reads the account's own cap and the metered month the invoice reads, which
 * is what makes the 403 below a real refusal rather than a rehearsal.
 *
 * The device store is built per call rather than cached, because the
 * resolver is handed straight to the route table and a Worker isolates globals
 * across requests; a per-request store is also the only store that can be
 * built for the env a particular request carries.
 *
 * @param {Env} env
 * @returns {(accountId: string) => Promise<"active"|"read_only">}
 */
export function capStateFor(env) {
  return (accountId) => capStateForAccount(createD1DeviceStore(env.DRIVE_DB), accountId);
}
