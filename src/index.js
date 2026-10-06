import { withSentry } from "@sentry/cloudflare";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { methodNotAllowed } from "hono/method-not-allowed";
import { secureHeaders } from "hono/secure-headers";
import { trimTrailingSlash } from "hono/trailing-slash";
import { runPreChargeLimitCron } from "../core/abuse-guards.js";
import { authFor, SIGNIN_LINK_PATH } from "../core/auth.js";
import {
  BILLING_CONFIG,
  handleQuoteRequest,
  handleUsageRequest,
  QUOTE_ENDPOINT,
  USAGE_ENDPOINT,
} from "../core/billing.js";
import {
  CAP_ENDPOINT,
  capStateForAccount,
  handleCapRequest,
  runCapEnforcement,
} from "../core/cap.js";
import { createD1DeviceSigninStore } from "../core/device-signin.js";
import { createD1DeviceStore } from "../core/devices.js";
import { handleSendEmailRequest, isSameOriginRequest } from "../core/email-send.js";
import { EXPORT_ENDPOINT, exportRoute } from "../core/export.js";
import {
  createS3Store,
  FILES_ENDPOINT,
  handleFilesRequest,
  purgeExpiredTrash,
  scopeStore,
  storageBucketForKey,
  storageVarsFromEnv,
  TRASH_PURGE_SCHEDULE,
} from "../core/files.js";
import { bearerToken, errorResponse } from "../core/http.js";
import { runKeySweep } from "../core/key-sweep.js";
import { keyProviderFor } from "../core/keyprovider-env.js";
import { balanceCents } from "../core/ledger.js";
import { failureMessage } from "../core/messages.js";
import {
  downloadRecorder,
  HOUR_MS,
  handleStorageEventRequest,
  hourStart,
  listMeteredAccounts,
  METER_CRON,
  METER_RECONCILE_SCHEDULE,
  monthStart,
  pruneHiddenVersions,
  reconcileMeter,
  recordNightlySizes,
  runMeterCron,
  toMillis,
} from "../core/meter.js";
import {
  AUTO_TOPUP_ENDPOINT,
  drawPendingHours,
  handleAutoTopUpRequest,
  prepaidPauseOn,
  settleBalances,
} from "../core/prepaid.js";
import { createD1QueueStore } from "../core/queues.js";
import {
  handleFirstRunStatusRequest,
  STATUS_ENDPOINT,
  signedInAccount,
  unauthorizedResponse,
} from "../core/status.js";
import {
  BALANCE_ENDPOINT,
  BILLING_WEBHOOK_PATH,
  balanceLine,
  handleBalanceRequest,
  handleBillingWebhook,
  handleTopUpRequest,
  TOPUP_ENDPOINT,
} from "../core/topup.js";
import {
  CLOSE_CANCEL_ENDPOINT,
  CLOSE_ENDPOINT,
  CLOSE_SCHEDULE,
  handleCloseCancelRequest,
  handleCloseRequest,
  handleCloseStatusRequest,
  runAccountCloseCron,
} from "./account-close.js";
import { BRANCH_QUEUE_KINDS, branchJob, branchJobsQueue, handleBranchJobs } from "./branch-jobs.js";
import {
  BRANCHES_ENDPOINT,
  createKvSnapshotStore,
  failJob,
  handleBranchesRequest,
  processBranchJob,
} from "./branches.js";
import { HEALTH_PATH, handleHealthRequest } from "./health.js";
import {
  handleMeterJobs,
  METER_JOB_KINDS,
  meterJobHandlers,
  meterJobsQueue,
  sendMeterJobs,
} from "./meter-jobs.js";
import {
  captureError,
  reportBillingGap,
  reportPurgeFailures,
  withCronCheckIn,
} from "./monitoring.js";
import { handlePortalRequest, PORTAL_ENDPOINT } from "./portal.js";
import { handleRewindRequest, REWIND_ENDPOINT } from "./rewind.js";
import {
  handleSearchRequest,
  indexAccounts,
  REINDEX_SCHEDULE,
  reconcileIndex,
  SEARCH_ENDPOINT,
  withIndex,
} from "./search.js";
import {
  createD1LinkStore,
  handleRequestInfoRequest,
  handleRequestRequest,
  handleRequestUploadRequest,
  handleShareFileRequest,
  handleShareRequest,
  purgeStaleLinks,
  REQUEST_ENDPOINT,
  SHARE_ENDPOINT,
  SHARE_LINK_PREFIX,
} from "./share.js";
import { handleSigninLinkVerify, handleSigninRequest, SIGNIN_ENDPOINT } from "./signin.js";
import { purgeExpiredSigninSends } from "./signin-send-limit.js";
import { handleStarterRequest, STARTER_ENDPOINT } from "./starter.js";
import { handleWaitlistRequest } from "./waitlist.js";

// The path the meter, the billing webhook and the tests post a drive email to
// (core/email-send.js). One route, so one place knows the provider.
const SEND_EMAIL_PATH = "/api/emails/send";

// The api Worker's family (workers/api/src/routes.js API_PREFIX), the one path
// this Worker forwards and never renders a page for. Spelled here the way the
// /v1/* route is, rather than imported, so the site Worker does not pull the
// whole api route registry into its bundle; test/deploy-assets.test.mjs pins
// the error path against a browser Accept on this family.
const API_PATH_PREFIX = "/v1";

/**
 * The per-request value Hono's context carries. `account` is resolved once by
 * the gate middleware below and read from the context by every handler, so a
 * handler cannot disagree with the gate about who is calling. It is the same
 * shape core/status.js `signedInAccount` returns and every handler's own
 * `account` parameter takes, so the gate's answer needs no narrowing where it
 * is handed on.
 * @typedef {{account: {id: string, name: string, email: string|null}|null}} DriveVariables
 */

/**
 * The app's own type: the Worker's generated `Env` as Hono's bindings (so
 * `c.env` is `Env`, not `unknown`) and the context value above as its
 * variables (so `c.get("account")` is typed rather than a key the library has
 * never heard of). Typed once here and reused by every handler's annotation,
 * the same way workers/api/src/index.js types its dispatcher.
 * @typedef {import("hono").Hono<{Bindings: Env, Variables: DriveVariables}>} DriveApp
 */

/**
 * The Hono context every route handler and middleware on this app receives.
 * @typedef {import("hono").Context<{Bindings: Env, Variables: DriveVariables}>} DriveContext
 */

// Public routes: reachable without a signed-in account. Every other /api/
// route is account-gated by default (deny-by-default). The listing is the
// only way to be exempt, so a new route cannot ship unclassified: the walk in
// test/account-gate.test.mjs reads Hono's own route table and fails on any
// route that is neither here nor accounted for by an endpoint the tests know.
//
//   - /api/waitlist: sign-ups, before accounts exist.
//   - /api/storage-events: the storage provider's event rule posts here with
//     its own shared token in a header (core/meter.js handleStorageEventRequest),
//     not a session. The token is the gate.
//   - /api/emails/send: the meter's cap emails and the billing webhook; closed
//     with no EMAIL_SEND_TOKEN set (core/email-send.js), so its gate is a
//     deployment secret rather than a session.
//   - /api/health: the outside outage monitor polls it with no session and it
//     answers ok/failing with no account data at all (src/health.js).
//   - /api/signin and /api/signin/verify: the sign-in flow itself. Signing in
//     is the only way to get a session, so it must be reachable without one.
//   - /s/<token>: a share link, where the token in the path is the whole proof
//     and one that expires or is revoked answers 404 (src/share.js).
//   - /api/request/info and /api/request/upload: the logged-out side of an
//     upload request, where the token in the query is the whole proof.
//   - /api/quote: the public savings calculator (drive issue #14). It quotes
//     the price for a size, not an account, so it has no session to need.
//   - /api/billing/webhook: Dodo's signed payment webhook (drive#586). The
//     Standard Webhooks signature over the raw body is the gate
//     (core/topup.js handleBillingWebhook), and with DODO_WEBHOOK_SECRET unset
//     it answers 503, a closed door.
export const PUBLIC_ROUTES = Object.freeze([
  "/api/waitlist",
  "/api/storage-events",
  SEND_EMAIL_PATH,
  HEALTH_PATH,
  SIGNIN_ENDPOINT,
  SIGNIN_LINK_PATH,
  `${SHARE_LINK_PREFIX}/*`,
  `${REQUEST_ENDPOINT}/info`,
  `${REQUEST_ENDPOINT}/upload`,
  QUOTE_ENDPOINT,
  BILLING_WEBHOOK_PATH,
]);

/**
 * The Dodo settings this Worker reads, none of them declared bindings: each is
 * unset until Nish sets the live account up (#325), and every route that needs
 * one answers a closed door without it. DODO_FETCH is the tests' recorder.
 * @param {Env} env
 */
function dodoEnv(env) {
  return /** @type {{DODO_PAYMENTS_API_KEY?: string, DODO_BASE_URL?: string, DODO_TOPUP_PRODUCT_ID?: string, DODO_WEBHOOK_SECRET?: string, DODO_FETCH?: typeof fetch, MAIL_FROM?: string, PREPAID_PAUSE?: string}} */ (
    /** @type {unknown} */ (env)
  );
}

/** @param {string} pathname */
function isPublic(pathname) {
  const clean = pathname.replace(/\/+$/, "") || "/";
  return PUBLIC_ROUTES.some((p) => {
    const route = p.endsWith("/*") ? p.slice(0, -2) : p;
    return clean === route || clean.startsWith(`${route}/`);
  });
}

// One S3 store per Worker isolate. An S3 endpoint (FILES_S3_ENDPOINT, or the
// same IDRIVE_S3_ENDPOINT the api Worker uses) points the handlers at storage;
// each account's objects live in that account's own bucket (`drv-<id>`,
// storageBucketForKey / bucketForAccount), which is the same name a Finder
// key is minted into (drive#371 / #460). The account prefix is still
// scopeStore's job (core/files.js). A deployment with no endpoint answers 503
// rather than an in-memory store that vanishes with the isolate (drive#505).
// Tests that need the in-memory stand-in import createMemoryStore themselves
// and set env[TEST_FILES_STORE]; production never does.
export const TEST_FILES_STORE = Symbol("drive.testFilesStore");
/** @type {import("../core/files.js").FileStore|undefined} */
let filesStore;
/** One missing-endpoint line per isolate env, not per request. */
const missingFilesStoreLogged = new WeakSet();
/**
 * Storage config vars. They are set per deployment, never declared as
 * bindings in cloudflare.config.ts: a declared secret is required at deploy,
 * and a deployment with none of them answers 503 rather than an in-memory
 * store (drive#505). The names match the api Worker's iDrive pair so the site
 * Worker can read the buckets a minted key writes to, plus the older
 * FILES_S3_* stand-in pair a local `rclone serve s3` still uses. The typedef's
 * one definition is core/files.js's, beside the one reader of the vars.
 * @typedef {import("../core/files.js").StorageEnv} StorageEnv
 * @param {Env} env
 * @returns {StorageEnv}
 */
function devStorage(env) {
  return /** @type {StorageEnv} */ (env);
}

/**
 * The close handlers' dependencies, or null when this deployment has no
 * customer database or no storage endpoint. A missing database or store is a
 * 503 from the route, not an in-memory close that would vanish on the next
 * isolate (drive#505).
 * @param {Env} env
 */
function closeDepsFor(env) {
  if (!env.DRIVE_DB) {
    return null;
  }
  const store = storeFor(env);
  if (!store) {
    return null;
  }
  const secrets = /** @type {Env & {MAIL_FROM?: string}} */ (env);
  return {
    devices: createD1DeviceStore(env.DRIVE_DB, {
      keyProvider: keyProviderFor(env) ?? undefined,
    }),
    store,
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
function forwardToApi(c) {
  const api = apiBinding(c.env).API;
  if (!api) return errorResponse(503, failureMessage("unexpected"));
  return api.fetch(c.req.raw);
}

/**
 * @param {Env} env
 * @returns {import("../core/files.js").FileStore | null}
 */
function storeFor(env) {
  const injected =
    /** @type {{[key: symbol]: import("../core/files.js").FileStore | undefined}} */ (env)[
      TEST_FILES_STORE
    ];
  if (injected) {
    return injected;
  }
  if (!filesStore) {
    // The four storage vars read through src/files.js's one reader, the same
    // read provisionAccountBucket makes at the sign-in verify step, so the
    // store and the provisioning cannot name two endpoints.
    const { endpoint, accessKeyId, secretAccessKey, region } = storageVarsFromEnv(devStorage(env));
    if (!endpoint) {
      // Fail closed: no endpoint, no store (drive#505). An in-memory store
      // here would take an upload and lose it with the isolate, and the
      // nightly reconcile would wipe the search index against it.
      if (!missingFilesStoreLogged.has(env)) {
        missingFilesStoreLogged.add(env);
        console.error("files: no storage endpoint is set, so this deployment cannot serve files");
      }
      return null;
    }
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
  }
  return filesStore;
}

/**
 * Run a files-backed route, or answer 503 when this deployment has no store.
 * @param {DriveContext} c
 * @param {(store: import("../core/files.js").FileStore) => Response | Promise<Response>} run
 */
function withFileStore(c, run) {
  const store = storeFor(c.env);
  if (!store) {
    return c.json({ error: failureMessage("drive-not-configured") }, 503);
  }
  return run(store);
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
function linksFor(env) {
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
function snapshotsFor(env) {
  const kv = env.BRANCH_SNAPSHOTS;
  return kv ? createKvSnapshotStore(kv) : null;
}

// The live upload queue a device on this account reported (drive issue #318),
// read from the same row the api Worker's report route writes. Built per
// request from the binding, like linksFor: a report a mount just sent is the
// row the next poll reads, on whichever instance the poll lands. The
// freshness window is inside the store's read (core/queues.js
// `latest`), so the first-run page and the usage page cannot disagree about
// whether a report is live, and a device that has not reported for a while
// reads as no queue to report — the same honest null #308 answers — rather
// than as a stale one. No database means nothing has reported and there is
// nothing to read: null, the same answer as an account whose no device has
// signed in yet.
/**
 * @param {Env} env
 * @param {{id: string}} account
 * @returns {Promise<import("../core/queues.js").UploadQueue|null>}
 */
async function liveQueueFor(env, account) {
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
// window is core/status.js `connectionStatus`'s own — so this one function fills
// the payload and the rule stays in the module the page and the CLI already
// read. No database means no device has signed in yet: the empty list, the
// same answer as an account whose machine has not.
/**
 * @param {Env} env
 * @param {{id: string}} account
 * @returns {Promise<Array<{id: string, name: string, kind: string, lastSeenAt: number|null}>>}
 */
async function liveDevicesFor(env, account) {
  if (!env.DRIVE_DB) {
    return [];
  }
  return createD1DeviceStore(env.DRIVE_DB).listLive(account);
}

// The owner's spending-cap state for the public upload routes, read from the
// same core/billing.js summary the usage page shows, and resolved per account so
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
function capStateFor(env) {
  return (accountId) => capStateForAccount(createD1DeviceStore(env.DRIVE_DB), accountId);
}

// Account-gated middleware resolves the caller once, from the request's own
// credentials and nothing else (core/status.js signedInAccount over
// core/auth.js authFor), and puts that account on Hono's context. Every handler
// below reads it from the context, so a handler cannot disagree with the gate
// about who is calling. An anonymous request is answered 401 here, before the
// store is built or any handler runs — the deny-by-default rule the walk in
// test/account-gate.test.mjs checks route by route.
//
// It is registered on "/api/*" alone and its own isPublic() check skips the
// public routes declared above, so the two public POST routes keep the repo's
// own same-origin rule (src/waitlist.js, core/email-send.js) and the token
// lanes keep their tokens. One CSRF middleware on /api/* then covers every
// other write: the two public POSTs keep their handler copies, and every
// other non-GET is refused here before the handler runs.
//
// @type {import("hono").MiddlewareHandler<{Bindings: Env, Variables: DriveVariables}>}
async function accountGate(/** @type {DriveContext} */ c, /** @type {import("hono").Next} */ next) {
  if (isPublic(c.req.path)) return next();
  /** @type {DriveVariables["account"]} */
  let account = await signedInAccount(c.req.raw, authFor(c.env));
  // The CLI holds a device token, not a browser cookie (drive#64 `drive cap`
  // and `drive status`). The same D1 lookup the api Worker uses, so one
  // token is one account on both Workers. No header means no lookup: an
  // anonymous browser request stays the cookie 401 the tests pin.
  if (!account) {
    const token = bearerToken(c.req.raw);
    if (token !== null && c.env.DRIVE_DB) {
      account = await createD1DeviceSigninStore(c.env.DRIVE_DB).accountForDeviceToken(token);
    }
  }
  if (!account) return unauthorizedResponse();
  c.set("account", account);
  await next();
}

// One CSRF rule for every non-GET /api/* route. The check is the repo's
// same-origin function (core/email-send.js): a caller with no Origin and no
// Sec-Fetch-Site (curl, the Go CLI) is not a browser, so it passes and the
// account gate is what holds it; a browser that names another origin, or
// Origin: null without Sec-Fetch-Site: same-origin, is refused with the
// message table's cross-site words. Hono's built-in csrf() only inspects
// form content-types, so a JSON POST would slip past it — the copies this
// replaced were already covering that, and this middleware is that same
// rule once, in front of every write.
//
// The two public POSTs keep their own handler copies (waitlist sign-up and
// the token-gated send lane) and are skipped here so those sentences stay
// the product's, not a second generic 403.
const CSRF_EXEMPT_PATHS = new Set(["/api/waitlist", SEND_EMAIL_PATH]);
/**
 * Same-origin CSRF on every write except the two public POSTs that keep
 * their own handler copies.
 * @type {import("hono").MiddlewareHandler<{Bindings: Env, Variables: DriveVariables}>}
 */
const csrfWhenBrowser = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
    return next();
  }
  const path = c.req.path.replace(/\/+$/, "") || "/";
  if (CSRF_EXEMPT_PATHS.has(path)) return next();
  if (!isSameOriginRequest(c.req.raw)) {
    return c.json({ error: failureMessage("cross-site") }, 403);
  }
  return next();
};

/** @param {DriveContext} c */
const filesHandler = async (c) => {
  const account = c.get("account");
  // The account's own state, read from the accounts row the cap saves
  // (drive#496). The handler asks for it rather than reading D1 itself, so the
  // write refusal below is one rule with one source and the tests can drive it
  // with a store they control. No DRIVE_DB means no cap state to enforce, so
  // the options carry no resolver and the account gate is what holds the route.
  return handleFilesRequest(
    c.req.raw,
    account ? withIndex(storeFor(c.env), c.env.DRIVE_DB, account) : null,
    account,
    Date.now(),
    c.env.DRIVE_DB
      ? {
          db: c.env.DRIVE_DB,
          prepaidPause: prepaidPauseOn(c.env),
          accountState: createD1DeviceStore(c.env.DRIVE_DB).accountState,
          recordDownload: downloadRecorder(c.env.DRIVE_DB),
        }
      : { prepaidPause: prepaidPauseOn(c.env) },
  );
};

/**
 * Create the Hono app. All route logic lives here so the Worker export is a
 * thin shim and the app — including its route table — can be walked in tests.
 *
 * It takes no env and closes over no request: every handler reads its
 * bindings from Hono's own `c.env`, which the platform's `fetch(request, env)`
 * fills in. So one app is a pure route table that any env can be run against
 * — which is what lets the account-gate walk in test/account-gate.test.mjs
 * build it and read the real registry without a deployment behind it.
 * @returns {DriveApp}
 */
export function createApp() {
  /** @type {DriveApp} */
  const app = new Hono({ strict: false });

  // Trailing slashes handled by the library (redirects to canonical), so no
  // hand-written `pathname === X || pathname === X + "/"` pair remains.
  app.use(trimTrailingSlash());

  // Secure headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
  // Strict-Transport-Security, and the rest Hono ships) on every response.
  app.use("*", secureHeaders());

  // The api Worker's one route in this Worker's own namespace, registered
  // ahead of the account gate so the gate never answers it (drive#354). The
  // api registry declares POST /api/keys/revoke outside its /v1 family
  // (workers/api/src/routes.js, the walk's one exception) because `drive
  // logout` posts it with the storage key the rclone config holds: the key
  // itself is the credential, so there is no session to gate on. It is the
  // one deliberate hole in the deny-by-default gate below — a wrong key is
  // the api Worker's own 401, a right one its 204, and no account route is
  // reachable through it — and test/account-gate.test.mjs pins that it is the
  // only such route.
  app.all("/api/keys/revoke", forwardToApi);

  // Deny-by-default account gate on /api/*. Public routes are declared in
  // PUBLIC_ROUTES above.
  app.use("/api/*", accountGate);

  // Same-origin / CSRF protection on every non-GET /api/* route except the
  // two public POSTs that keep their handler copies. Registered after the
  // account gate so an anonymous request is its 401, not a 403: the gate is
  // the outer rule. A caller with no Origin and no Sec-Fetch-Site (curl, the
  // Go CLI) is not a browser, so it passes this check and the account gate
  // is what holds it. /api/starter is a write route under this one rule
  // (drive#539), so it carries the check without its own registration.
  app.use("/api/*", csrfWhenBrowser);

  // --------------------------------------------------- the second family (/v1/*)
  // The api Worker's family on the one host that answers the CLI's one base
  // (drive#156/#341: `drive agents` posts /v1/keys to the same APIBase
  // `drive search` posts /api/search to, cmd/drive/api.go). This Worker is the
  // one that answers that address, so /v1/* is forwarded here rather than
  // served here.
  //
  // The prefix is the api registry's own (workers/api/src/routes.js
  // API_PREFIX, the value every path in that registry starts with), spelled
  // here the way every route path on this app is spelled, and
  // cloudflare.config.ts carries the same list in runWorkerFirst, which is
  // what routes a /v1/* request to this route instead of the asset layer.
  // test/deploy-assets.test.mjs pins this route, the config's list and the
  // registry against that one constant.
  app.all("/v1/*", forwardToApi);

  // ---------------------------------------------------------- account routes
  // Each method is registered on its own (rather than with app.all) so Hono's
  // methodNotAllowed middleware answers a wrong method with 405 and an Allow
  // header; the gate above already answered an anonymous caller 401.

  // The first-run page's live flip (issue #32, #45, #556). The third
  // argument is the queue a device on this account reported, read from the row
  // the api Worker's report route wrote (drive issue #318): #308 made it an
  // argument to the handler, and the read is the one line that fills it. The
  // fourth is the account's live device rows, which are what let the page say
  // connected at all: until #556 this route carried none, so the hard-coded
  // "waiting" it answered was the only answer it had.
  app.get(STATUS_ENDPOINT, async (c) => {
    const account = c.get("account");
    // Both reads answer the same poll, so they go together: the page asks
    // every POLL_INTERVAL_MS and a second round-trip before the first answer
    // is a longer wait on a page someone is watching. Neither read depends on
    // the other.
    const [upload, devices] = await Promise.all([
      account ? liveQueueFor(c.env, account) : null,
      account ? liveDevicesFor(c.env, account) : [],
    ]);
    return handleFirstRunStatusRequest(c.req.raw, account, upload, devices);
  });

  // Search reads only the D1 file index (issue #18), behind the account gate.
  // The write half of the same module keeps the index current by wrapping the
  // store, so an upload, delete or restore is in the index before the next
  // search. The rebuild is not a web route: it runs from the scheduled handler.
  // Hono matches only registered paths, so deeper paths (e.g. /api/search/index)
  // would hit the notFound handler and lose the asset fallback the old
  // switch gave them. A wildcard route keeps the safety review intact
  // (no reindex starts from a web request) while forwarding anything that
  // is not the exact search endpoint to the asset worker unchanged.
  app.get(`${SEARCH_ENDPOINT}/*`, (c) => {
    const p = c.req.path;
    if (p !== SEARCH_ENDPOINT && p !== `${SEARCH_ENDPOINT}/`) {
      return c.env.ASSETS.fetch(c.req.raw);
    }
    return handleSearchRequest(c.req.raw, c.env.DRIVE_DB, c.get("account"));
  });

  // The files lane (issue #73). Signed-in callers read and write only their
  // own prefix; anonymous callers never reach here (the gate answered 401).
  app.get(FILES_ENDPOINT, filesHandler);
  app.post(FILES_ENDPOINT, filesHandler);
  app.get(`${FILES_ENDPOINT}/*`, filesHandler);
  app.post(`${FILES_ENDPOINT}/*`, filesHandler);

  // The optional notes starter (drive issue #15). A GET describes the template
  // and writes nothing; a POST with `action: "create"` fills in the starter's
  // own files, and only the ones that are missing. Same store handling as the
  // files lane: the handler scopes the store to the account it is handed, and
  // no withIndex, so a starter's files are not search rows a person never
  // asked to index. Off by default is enforced by the gate and the method
  // together: nothing in the Worker calls the create for a person, and the
  // only route that runs it is a POST behind the account gate.
  /** @param {DriveContext} c */
  const starterHandler = (c) => {
    const account = c.get("account");
    if (!account) {
      return handleStarterRequest(c.req.raw, null, account);
    }
    return withFileStore(c, (store) =>
      handleStarterRequest(c.req.raw, scopeStore(store, account), account),
    );
  };
  app.get(STARTER_ENDPOINT, starterHandler);
  app.post(STARTER_ENDPOINT, starterHandler);

  // Branches (build step 7, drive#8): the folder copy, the diff, approve and
  // discard. The store is handed in unscoped (the handler scopes it) and
  // without withIndex, so a branch's own copies never land in the search index.
  /** @param {DriveContext} c */
  const branchesHandler = (c) =>
    handleBranchesRequest(
      c.req.raw,
      c.env.DRIVE_DB,
      snapshotsFor(c.env),
      storeFor(c.env),
      c.get("account"),
      () => Date.now(),
      branchJobsQueue(c.env),
    );
  app.get(BRANCHES_ENDPOINT, branchesHandler);
  app.post(BRANCHES_ENDPOINT, branchesHandler);
  app.get(`${BRANCHES_ENDPOINT}/*`, branchesHandler);
  app.post(`${BRANCHES_ENDPOINT}/*`, branchesHandler);

  // Agent undo (build step 11, issue #13): the one-click rewind of an agent's
  // work, on the branch copy src/branches.js already keeps. Same store handling
  // as the branches route above.
  /** @param {DriveContext} c */
  const rewindHandler = (c) =>
    handleRewindRequest(
      c.req.raw,
      c.env.DRIVE_DB,
      snapshotsFor(c.env),
      storeFor(c.env),
      c.get("account"),
      () => Date.now(),
      branchJobsQueue(c.env),
    );
  app.get(REWIND_ENDPOINT, rewindHandler);
  app.post(REWIND_ENDPOINT, rewindHandler);
  app.get(`${REWIND_ENDPOINT}/*`, rewindHandler);
  app.post(`${REWIND_ENDPOINT}/*`, rewindHandler);

  // The usage page's and the CLI's read of the month's money (issues #7, #53).
  app.get(USAGE_ENDPOINT, async (c) => {
    const account = c.get("account");
    /** @type {number} */
    let capUsd = BILLING_CONFIG.defaultCapUsd;
    let cardOnFile = false;
    // The month's own metered numbers, read from the same store and the same
    // `monthUsageThrough` the cap walk and the invoice read (drive#496). This
    // is what turns /api/usage from an empty month into the account's real
    // one, including the download bytes the earlier read dropped. It is null
    // when there is no binding, so the handler falls back to the empty month
    // rather than failing the page.
    /** @type {Record<string, unknown>|null} */
    let usage = null;
    if (!account) return unauthorizedResponse();
    if (c.env.DRIVE_DB) {
      const store = createD1DeviceStore(c.env.DRIVE_DB);
      capUsd = await store.getCapUsd(account.id);
      // The card on file is the accounts row's own stamp, read the same way as
      // the cap (drive#417). Until it is really on file the usage page says no
      // charge has been made and shows no bill, instead of a balance line a
      // card-less account would look like it had been charged. It is
      // the display flag alone: the cap line and the write cap are unchanged.
      cardOnFile = await store.cardAdded(account.id);
      usage = /** @type {Record<string, unknown>} */ (
        await store.monthUsage(account.id, { capUsd })
      );
    }
    // The third argument is the live rclone upload queue, reported by the
    // account's device over its device token and stored in DRIVE_DB
    // (core/queues.js, drive issue #318). It is null when no
    // device has reported recently, which is the honest answer for an account
    // whose no device has signed in yet or whose mount is gone (drive issue
    // #308), so the usage page hides the line rather than showing a stale
    // one.
    // The prepaid balance line rides beside the cap line (drive#586), so
    // `drive status` prints the Worker's words, the top-up prompt included.
    const balance = c.env.DRIVE_DB
      ? balanceLine(await balanceCents(c.env.DRIVE_DB, account.id), {
          pauseOn: prepaidPauseOn(c.env),
        })
      : null;
    return handleUsageRequest(
      c.req.raw,
      { ...account, capUsd, cardOnFile, usage },
      await liveQueueFor(c.env, account),
      balance,
      // The month these numbers belong to, sent as its first instant (drive#559):
      // the one UTC month boundary the meter, the cap walk and the invoice read
      // (src/meter.js monthStart). It rides on the answer so the page can write
      // the month's name in the browser's own words and the customer can check
      // their statement against it. It is not worked out here in billing.js:
      // this file already owns the month, and a second boundary in the handler
      // would be a second answer to the same question.
      new Date(monthStart(Date.now())).toISOString(),
    );
  });

  // Own-data export (drive#547): the same handler GET /v1/export runs, served
  // here so a signed-in browser can download it before the api Worker is bound.
  // The account gate already answered 401 for a stranger. No DRIVE_DB means
  // no keys and no file rows, which is a truthful empty export, not a 503.
  app.get(EXPORT_ENDPOINT, (c) => {
    const account = c.get("account");
    if (!account) return unauthorizedResponse();
    const db = c.env.DRIVE_DB;
    return exportRoute(c.req.raw, {
      store: {
        listKeys: (acct) => (db ? createD1DeviceStore(db).listPublic(acct) : Promise.resolve([])),
      },
      db: db ?? null,
      account,
      now: Date.now,
      url: new URL(c.req.url),
    });
  });

  // The prepaid balance (drive#586): the balance and recent ledger lines, and
  // a top-up's checkout. The balance is credited only by the signed webhook
  // below, never by this route or the checkout's redirect.
  app.get(BALANCE_ENDPOINT, (c) =>
    handleBalanceRequest(c.req.raw, c.get("account"), c.env.DRIVE_DB, {
      pauseOn: prepaidPauseOn(c.env),
    }),
  );
  app.post(AUTO_TOPUP_ENDPOINT, (c) =>
    handleAutoTopUpRequest(c.req.raw, c.get("account"), c.env.DRIVE_DB),
  );
  app.post(TOPUP_ENDPOINT, (c) => {
    const dodo = dodoEnv(c.env);
    return handleTopUpRequest(c.req.raw, c.get("account"), {
      db: c.env.DRIVE_DB,
      apiKey: dodo.DODO_PAYMENTS_API_KEY,
      baseUrl: dodo.DODO_BASE_URL,
      productId: dodo.DODO_TOPUP_PRODUCT_ID,
      fetch: dodo.DODO_FETCH,
    });
  });

  // The card-update path the payment-failed copy points at (drive#575). A GET
  // because it is a link a browser follows, and the answer is a 302 to the
  // provider's customer portal rather than a JSON body. The account gate
  // above already answered an anonymous caller 401, so a stranger never
  // reaches a provider call.
  app.get(PORTAL_ENDPOINT, (c) => {
    const dodo = dodoEnv(c.env);
    return handlePortalRequest(c.req.raw, c.get("account"), {
      db: c.env.DRIVE_DB,
      apiKey: dodo.DODO_PAYMENTS_API_KEY,
      baseUrl: dodo.DODO_BASE_URL,
      fetch: dodo.DODO_FETCH,
    });
  });

  // `drive cap <dollars>` and the usage page's cap write (drive#64). The
  // amount is parsed with parseCapUsd() and persisted as accounts.cap_cents.
  app.get(CAP_ENDPOINT, (c) => handleCapRequest(c.req.raw, c.get("account"), null));
  app.post(CAP_ENDPOINT, async (c) => {
    const db = c.env.DRIVE_DB;
    // The full two-provider choice (S3, else iDrive), not the S3 one alone
    // (drive#496): on an iDrive deployment a store wired to the S3 provider
    // alone has no provider that can revoke at the storage side, so the swap
    // that a cap write performs was a no-op on the drive itself.
    const store = db
      ? createD1DeviceStore(db, { keyProvider: keyProviderFor(c.env) ?? undefined })
      : null;
    return handleCapRequest(c.req.raw, c.get("account"), store);
  });

  // Account close (drive#235): confirm by typing email, keys revoked at once,
  // files after 30 days. The GET feeds the usage page; both POSTs are the
  // same gate as every other account write.
  app.get(CLOSE_ENDPOINT, async (c) => {
    const deps = closeDepsFor(c.env);
    if (!deps) {
      return c.json({ error: failureMessage("drive-not-configured") }, 503);
    }
    return handleCloseStatusRequest(c.req.raw, c.get("account"), deps);
  });
  app.post(CLOSE_ENDPOINT, async (c) => {
    const deps = closeDepsFor(c.env);
    if (!deps) {
      return c.json({ error: failureMessage("drive-not-configured") }, 503);
    }
    return handleCloseRequest(c.req.raw, c.get("account"), deps);
  });
  app.post(CLOSE_CANCEL_ENDPOINT, async (c) => {
    const deps = closeDepsFor(c.env);
    if (!deps) {
      return c.json({ error: failureMessage("drive-not-configured") }, 503);
    }
    return handleCloseCancelRequest(c.req.raw, c.get("account"), deps);
  });

  // Share links and upload requests (issue #19). The share/request roots are
  // the owner's side and stand behind the gate; the token-carrying child
  // routes are public and registered below.
  app.get(SHARE_ENDPOINT, (c) =>
    withFileStore(c, (store) =>
      handleShareRequest(c.req.raw, store, linksFor(c.env), c.get("account")),
    ),
  );
  app.post(SHARE_ENDPOINT, (c) =>
    withFileStore(c, (store) =>
      handleShareRequest(c.req.raw, store, linksFor(c.env), c.get("account"), {
        // The mint route's own bound (drive issue #549). The per-account
        // open-link cap lives in the handler; this is the edge limit.
        limiter: c.env.SHARE_MINT_RATE_LIMITER,
      }),
    ),
  );
  // DELETE revokes a link (`drive share --revoke`); the handler answers it,
  // but a route that is not registered is a 405 before the handler runs.
  app.delete(SHARE_ENDPOINT, (c) =>
    withFileStore(c, (store) =>
      handleShareRequest(c.req.raw, store, linksFor(c.env), c.get("account")),
    ),
  );
  app.get(REQUEST_ENDPOINT, (c) =>
    withFileStore(c, (store) =>
      handleRequestRequest(c.req.raw, store, linksFor(c.env), c.get("account")),
    ),
  );
  app.post(REQUEST_ENDPOINT, (c) =>
    withFileStore(c, (store) =>
      handleRequestRequest(c.req.raw, store, linksFor(c.env), c.get("account"), {
        // The mint route's own bound (drive issue #549).
        limiter: c.env.REQUEST_MINT_RATE_LIMITER,
      }),
    ),
  );
  app.delete(REQUEST_ENDPOINT, (c) =>
    withFileStore(c, (store) =>
      handleRequestRequest(c.req.raw, store, linksFor(c.env), c.get("account")),
    ),
  );

  // ----------------------------------------------------------- public routes
  // Sign-ups (GET is a 405 from methodNotAllowed; POST is the route).
  app.post("/api/waitlist", (c) =>
    handleWaitlistRequest(c.req.raw, c.env.WAITLIST_DB, c.env.WAITLIST_RATE_LIMITER),
  );

  // The public savings calculator (drive issue #14). GET only; the handler
  // refuses every other method. No account: it quotes the price, not a bill.
  app.get(QUOTE_ENDPOINT, (c) => handleQuoteRequest(c.req.raw));

  // The meter's event intake (issue #6), behind the provider's shared token.
  app.post("/api/storage-events", (c) =>
    handleStorageEventRequest(c.req.raw, c.env.METER_DB, c.env.METER_EVENT_TOKEN),
  );

  // The sign-in screen's two steps (build step 9, issue #10; Better Auth over
  // D1, #181). The handler enforces the edge limits (issue #147) before it
  // reads the body.
  app.post(SIGNIN_ENDPOINT, (c) => handleSigninRequest(c.req.raw, c.env));
  // The link a sign-in email carries (drive#181): GET only.
  app.get(SIGNIN_LINK_PATH, (c) => handleSigninLinkVerify(c.req.raw, c.env));

  // The logged-out side of a share/request token (issue #19). The token in
  // the path or query is the whole proof; an expired or revoked one is 404.
  app.get(`${SHARE_LINK_PREFIX}/*`, (c) =>
    withFileStore(c, (store) =>
      handleShareFileRequest(c.req.raw, store, linksFor(c.env), {
        ipLimiter: c.env.SHARE_DOWNLOAD_RATE_LIMITER,
        recordDownload: downloadRecorder(c.env.DRIVE_DB),
      }),
    ),
  );
  app.get(`${REQUEST_ENDPOINT}/info`, (c) =>
    handleRequestInfoRequest(c.req.raw, linksFor(c.env), capStateFor(c.env)),
  );
  app.post(`${REQUEST_ENDPOINT}/upload`, (c) =>
    withFileStore(c, (store) =>
      handleRequestUploadRequest(c.req.raw, store, linksFor(c.env), capStateFor(c.env), {
        ipLimiter: c.env.REQUEST_UPLOAD_RATE_LIMITER,
        linkLimiter: c.env.REQUEST_UPLOAD_LINK_RATE_LIMITER,
        db: c.env.DRIVE_DB,
        prepaidPause: prepaidPauseOn(c.env),
      }),
    ),
  );

  // Dodo's signed payment webhook (drive#586): credits a top-up, records a
  // refund. Public, because the signature is the proof.
  app.post(BILLING_WEBHOOK_PATH, (c) =>
    handleBillingWebhook(c.req.raw, {
      db: c.env.DRIVE_DB,
      secret: dodoEnv(c.env).DODO_WEBHOOK_SECRET,
      email: c.env.EMAIL,
      mailFrom: dodoEnv(c.env).MAIL_FROM ?? "",
    }),
  );

  // The send lane: closed with no EMAIL_SEND_TOKEN set (core/email-send.js).
  app.post(SEND_EMAIL_PATH, (c) => handleSendEmailRequest(c.req.raw, c.env));

  // The health endpoint the outside monitor polls (issues #96, #36).
  app.get(HEALTH_PATH, (c) => handleHealthRequest(c.req.raw, c.env));

  // ------------------------- method handling, 404, 405 and errors: the library
  app.use("*", methodNotAllowed({ app }));
  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      // The old hand-written switch fell through to assets for paths it
      // didn't match (e.g. /api/search/index, which is not the exact
      // search endpoint). Preserve that fallback so unknown API paths
      // that are subpaths of a registered prefix still serve the page.
      if (c.req.path.startsWith(`${SEARCH_ENDPOINT}/`)) {
        return c.env.ASSETS.fetch(c.req.raw);
      }
      return c.json({ error: "Not found." }, 404);
    }
    return c.env.ASSETS.fetch(c.req.raw);
  });
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // A 500 that only reached console.error was invisible: the Worker shipped
    // with `observability: null` and no error pipeline (issue #520). Sentry
    // sees it now; the console line stays for Workers Logs, which
    // `observability` in cloudflare.config.ts turns on.
    captureError(err, `${c.req.method} ${c.req.path}`);
    console.error("[pricing] request failed:", err.message, err.stack, err);
    // drive#584: a browser that asked for a page gets the site's own 5xx page,
    // so a failure deep in the Worker still looks like the site. An API caller
    // keeps the one failure table's JSON, so a CLI never has to parse HTML.
    // The JSON answer keys off the route family, not the Accept header alone:
    // Java's HttpURLConnection sends a text/html default, and /v1/* is the CLI.
    const accept = c.req.header("accept") ?? "";
    // The path family, not the Accept header (Java's HttpURLConnection sends a
    // text/html default and /v1/* is the CLI). A bare "/api" or "/v1" cannot
    // reach here: both are real routes (API_PATH_PREFIX's own handler and a
    // sites route), so this sees only subpaths of either family.
    const isApiPath =
      c.req.path.startsWith("/api/") || c.req.path.startsWith(`${API_PATH_PREFIX}/`);
    if (accept.includes("text/html") && !isApiPath && c.env.ASSETS) {
      const errorUrl = new URL(c.req.url);
      errorUrl.pathname = "/500.html";
      errorUrl.search = "";
      return c.env.ASSETS.fetch(new Request(errorUrl, { headers: c.req.raw.headers }))
        .then(
          (asset) =>
            // The answer is built by hand, not by copying the asset's headers: an
            // error response must never be cacheable, and a page request's
            // headers (a cache modifier the browser sent) cannot ride onto a 500
            // from an unrelated path. src/seo.js marks /500.html noindex, so a
            // crawler that follows a broken link keeps the error out of its
            // index too.
            new Response(asset.body, {
              status: 500,
              headers: {
                "content-type": asset.headers.get("content-type") ?? "text/html; charset=utf-8",
                "cache-control": "no-store",
                "x-robots-tag": "noindex",
              },
            }),
        )
        .catch(() => c.json({ error: failureMessage("unexpected") }, 500));
    }
    return c.json({ error: failureMessage("unexpected") }, 500);
  });

  return app;
}

// One app per isolate, built on the first fetch: createApp takes no env and
// closes over no request, so the compiled router is safe to share across
// fetches (the api Worker's appFor cache, minus the table key), and a
// construction failure fails that request, not the isolate's boot.
/** @type {ReturnType<typeof createApp> | undefined} */
let app;

// Static assets serve the pricing page, the first-run page, the Web Files page
// and the usage page; only /api/*, /s/* and the api Worker's /v1/* reach this
// Worker (see runWorkerFirst in cloudflare.config.ts). Anything that does reach
// it and is not an API falls
// through to the assets, so a stray path is a real 404 from the asset worker
// rather than a hand-rolled page.
/**
 * The Sentry options, read off the environment per invocation: the DSN is a
 * per-deployment var like the storage pair and EMAIL_SEND_TOKEN, never a
 * declared binding (a declared one is required at deploy). With no DSN the
 * SDK is disabled and every call in src/monitoring.js is a safe no-op, so a
 * deployment that has not configured Sentry still runs every cron (issue
 * #520).
 * @param {Env} env
 */
const sentryOptions = (env) => ({
  dsn: /** @type {{SENTRY_DSN?: string}} */ (env).SENTRY_DSN,
});

/**
 * @satisfies {ExportedHandler<Env>}
 */
const handler = {
  async fetch(request, env, _context) {
    if (app === undefined) app = createApp();
    return app.fetch(request, env);
  },

  // Three Cron Triggers share this one handler, and the platform's cron string
  // tells them apart, so no trigger spends another's work:
  //   - The meter's hourly rollup (issue #6): roll every closed UTC hour that
  //     has not been rolled yet into usage_minutes, oldest first
  //     (core/meter.js runMeterCron). A D1 failure throws, so Cloudflare
  //     records the trigger as failed and retries, and the catch-up takes
  //     the next one over - a failed rollup must never read as a quiet zero.
  //     The schedule string lives in cloudflare.config.ts, pinned to
  //     core/meter.js's METER_CRON by test/meter.test.mjs. The same trip
  //     also enforces the 1 TB pre-charge storage limit on mounts
  //     (core/abuse-guards.js runPreChargeLimitCron, drive#536): an
  //     over-limit unpaid account's keys are taken read-only through the
  //     cap's own swap, the same answer the web upload path gives.
  //   - The meter's nightly reconciler (build-spec.md piece 6, drive issue
  //     #59): `reconcileMeter` walks each metered account's versions in the
  //     storage provider, fixes the rows the event stream missed, and rewinds
  //     the rollup watermark to the earliest corrected hour so the next hourly
  //     run re-rolls it (the overwrite-not-add re-roll #6 built). Awaited, so a
  //     D1 failure is Cloudflare's to record and retry: a repair that silently
  //     did nothing would read as a healthy run.
  //   - The nightly reconciler (build-spec.md piece 6, drive issue #18):
  //     `reconcileIndex` walks one account's store once and rebuilds its rows,
  //     so an event the write path missed is corrected within a day. The
  //     schedule is the only way a rebuild starts: it is invoked by the
  //     platform and cannot be started by a browser request, which a route on
  //     /api/search/index would have allowed (issue #18 safety review). The
  //     accounts to walk are the ones the index already holds rows for — a
  //     scheduled run has no request and so no signed-in account, and this
  //     repo has no accounts table until the device sign-in store lands (#5),
  //     so the index's own rows are the only honest list: an account the
  //     drive has never served has nothing to rebuild, and no invented
  //     identity is indexed. Each account's rows are rebuilt from its own
  //     prefix (scopeStore), the same scoping a request path gets.
  /**
   * @param {ScheduledController} event
   * @param {Env} env
   * @param {ExecutionContext} context
   * @param {import("../core/files.js").FileStore} [store] the storage store,
   *   injectable so the reindex's own tests hand one in instead of standing
   *   in the runtime's fetch
   * @returns {Promise<void>}
   */
  async scheduled(event, env, context, store) {
    // Every string cloudflare.config.ts declares has a branch below.
    // Anything else used to fall through to the nightly reindex, so a
    // mistyped trigger silently walked every account's store.
    if (
      event.cron !== METER_CRON &&
      event.cron !== METER_RECONCILE_SCHEDULE &&
      event.cron !== CLOSE_SCHEDULE &&
      event.cron !== TRASH_PURGE_SCHEDULE &&
      event.cron !== REINDEX_SCHEDULE
    ) {
      throw new Error(`unknown cron: ${event.cron}`);
    }
    // The meter's trip. The controller carries the schedule string the
    // trigger fired for (event.cron), so a run on the meter's schedule does
    // the meter's work and nothing else.
    if (event.cron === METER_CRON) {
      // The whole branch runs inside one Sentry Crons check-in (issue #520):
      // `error` on any throw, rethrown so Cloudflare still records and
      // retries the failed trigger.
      return withCronCheckIn(event, "meter-hourly-rollup", async () => {
        // Awaited, so a D1 failure is Cloudflare's to record and retry: a
        // rollup that returned early would read as a quiet zero.
        const rolled = await runMeterCron(env.METER_DB, event.scheduledTime);
        // The trip's clock, once, as epoch milliseconds: runMeterCron reads
        // scheduledTime through toMillis, and the steps below take only a
        // number, so they read the same normalised instant.
        const now = toMillis(event.scheduledTime, "scheduledTime");
        // The billing gap the catch-up cap can leave (issue #520): a run
        // capped at MAX_CATCHUP_HOURS stops short of the last closed hour,
        // and every hour between sits unbilled until later runs drain it.
        // A healthy run always rolls through the last closed hour, so this
        // fires only on real backlog.
        const lastClosed = hourStart(now) - HOUR_MS;
        if (rolled.through < lastClosed) {
          reportBillingGap((lastClosed - rolled.through) / HOUR_MS, rolled.through, lastClosed);
        }
        // With the meter's queue bound (drive#519), the per-account steps below
        // (cap, draw, settle) run as one message per account instead of one
        // loop in this invocation (src/meter-jobs.js).
        const jobs = meterJobsQueue(env);
        if (jobs) {
          const sent = await sendMeterJobs(
            jobs,
            METER_JOB_KINDS.hourly,
            await listMeteredAccounts(env.METER_DB),
            { at: now, through: rolled.through },
          );
          console.log(`meter: queued ${sent} hourly account job(s)`);
          return;
        }
        // The cap walk, right after the rollup and before the push (drive#496).
        // The order is the whole point: the rollup is what makes the current
        // hour count, so a walk that ran before it would enforce the previous
        // hour's spend and then wait a full hour to catch up. The push is after
        // it so the invoice for those hours is built from the same rows the cap
        // was decided on.
        //
        // A cap that threw would be retried by Cloudflare with the whole
        // trigger, rollup included, which is the same contract the rollup above
        // has: an enforced cap that did not happen must be a failed trigger and
        // not a quiet zero. The walk's own state saves are guarded and its
        // notice stamps are written after the send, so a retry neither
        // re-sends a notice that went nor un-swaps a swap that happened.
        /** @type {ReadonlyArray<{id: string, error: unknown}>} */
        let capFailures = [];
        if (env.DRIVE_DB) {
          const secrets = /** @type {Env & {MAIL_FROM?: string}} */ (env);
          const cap = await runCapEnforcement({
            store: createD1DeviceStore(env.DRIVE_DB, {
              keyProvider: keyProviderFor(env) ?? undefined,
            }),
            now: event.scheduledTime,
            email: env.EMAIL,
            mailFrom: secrets.MAIL_FROM ?? "",
          });
          if (cap.mailed > 0 || cap.readOnly > 0) {
            console.log(
              `cap: ${cap.readOnly} of ${cap.accounts} metered account(s) at their cap, ${cap.mailed} notice(s) sent`,
            );
          }
          capFailures = cap.failures;
        }
        // The prepaid draw (drive#586): each account's usage is drawn from its
        // balance, at most once per account per hour (src/prepaid.js). It works
        // from each account's own draw mark through the newest rolled hour
        // (drive#519), not from the hours this run rolled, so a run that failed
        // here - for an hour or for days, across a month end or not - is caught
        // up by the next one. A failed D1 write fails the trigger, and the
        // idempotency key makes the retry draw nothing twice.
        const drawn = await drawPendingHours(
          env.METER_DB,
          await listMeteredAccounts(env.METER_DB),
          {
            through: rolled.through,
            now,
          },
        );
        if (drawn.drawn > 0) {
          console.log("prepaid: drew usage", `draws=${drawn.drawn}`, `cents=${drawn.cents}`);
        }
        // The "$2 left" email and the auto top-up for the accounts just drawn.
        // Each account's failure is logged inside and never fails the trigger:
        // the draws above are written, and a retry must not wait on a mail
        // outage.
        const dodo = dodoEnv(env);
        await settleBalances(env.METER_DB, drawn.accounts, {
          email: env.EMAIL,
          mailFrom: dodo.MAIL_FROM ?? "",
          apiKey: dodo.DODO_PAYMENTS_API_KEY,
          productId: dodo.DODO_TOPUP_PRODUCT_ID,
          baseUrl: dodo.DODO_BASE_URL,
          fetch: dodo.DODO_FETCH ?? globalThis.fetch,
          now,
        });
        // The pre-charge limit's own trip (drive#536). The web upload path has
        // held 1 TB free since drive#464, but a mount holds a storage key and
        // writes past any page, so the same hourly run reads the over-limit
        // unpaid accounts and takes their keys read-only, through the cap's
        // own swap (src/abuse-guards.js). DRIVE_DB is a required binding on
        // this trip - the sites Worker holds it - so a missing one fails the
        // trigger the same way a failed read does: a run that capped nobody
        // because the sweep never ran would be a quiet zero reporting the hour
        // as guarded, and Cloudflare's retry is the honest answer to a
        // misconfigured trip.
        if (env.DRIVE_DB === undefined || env.DRIVE_DB === null) {
          throw new Error(
            "the pre-charge limit sweep needs the DRIVE_DB binding, so an over-limit " +
              "unpaid account's keys can be taken read-only",
          );
        }
        const capped = await runPreChargeLimitCron({
          db: env.DRIVE_DB,
          devices: createD1DeviceStore(env.DRIVE_DB, {
            keyProvider: keyProviderFor(env) ?? undefined,
          }),
        });
        if (capped.capped > 0) {
          console.log(
            "pre-charge limit: capped",
            `accounts=${capped.capped}`,
            `over=${capped.overLimit}`,
            `failures=${capped.failures}`,
          );
        }
        // A cap step that failed for some accounts is raised last, after every
        // other account was decided and the hours were drawn and settled, so Cloudflare
        // records a failed trigger and the next run retries those accounts.
        if (capFailures.length > 0) {
          throw new AggregateError(
            capFailures.map((failure) => failure.error),
            `cap: enforcement failed for ${capFailures.length} account(s)`,
          );
        }
      });
    }
    const files = store ?? storeFor(env);
    if (!files) {
      throw new Error("the nightly jobs need a storage endpoint");
    }
    // The meter's nightly trip. Awaited for the same reason: a repair that
    // failed must be a failed trigger, not a run that reported success having
    // fixed nothing. The store is the one every account-scoped handler uses;
    // `reconcileMeter` scopes it per account, so the provider listing never
    // crosses accounts.
    if (event.cron === METER_RECONCILE_SCHEDULE) {
      // The whole branch shares one Sentry Crons check-in (issue #520): a
      // failure in any of its trips marks the nightly monitor `error`.
      return withCronCheckIn(event, "meter-nightly-reconcile", async () => {
        // The account close cron no longer rides this trip (drive#522): it has
        // its own schedule, its own branch and its own check-in below, so a
        // reconcileMeter, prune or size-record failure here cannot leave every
        // close receipt, reminder and purge undone for that night. The purge is
        // resumable, so the next night finishes whatever did not.
        //
        // With the meter's queue bound (drive#519), one message per account
        // does the reconcile (src/meter-jobs.js); without it, the same
        // per-account step runs here, each account's failure kept and raised.
        const jobs = meterJobsQueue(env);
        if (jobs) {
          const sent = await sendMeterJobs(
            jobs,
            METER_JOB_KINDS.reconcile,
            await listMeteredAccounts(env.METER_DB),
            { at: toMillis(event.scheduledTime, "scheduledTime") },
          );
          console.log(`meter: queued ${sent} reconcile account job(s)`);
        } else {
          await reconcileMeter(env.METER_DB, files, event.scheduledTime);
        }
        // Retention (drive issue #564): the reconciler has finished its
        // repairs, so the prune sees the row set the provider listings have
        // already agreed with, and a version the provider still lists is never
        // deleted from under it. A skipped prune is reported, not thrown: the
        // hours the cutoff needs are still being booked by the hourly rollup,
        // and the next nightly run tries again. The rows the prune would have
        // deleted keep being summed into usage_minutes meanwhile, so skipping
        // loses nothing but the space.
        const pruned = await pruneHiddenVersions(env.METER_DB, event.scheduledTime);
        if (pruned.skipped !== null) {
          console.log(`meter retention: skipped, ${pruned.skipped}`);
        } else {
          console.log(
            `meter retention: pruned=${pruned.pruned} hidden rows before ` +
              `${new Date(pruned.cutoff).toISOString()}`,
          );
        }
        if (env.DRIVE_DB) {
          // Link retention (drive issue #549): expired and revoked rows older
          // than 90 days are pruned nightly. A still-open row is never touched,
          // so this cannot close a link a stranger is holding. Awaited, like
          // the size row below: a purge that failed is a failed run, not a
          // silent gap.
          const purged = await purgeStaleLinks(
            env.DRIVE_DB,
            toMillis(event.scheduledTime, "scheduledTime"),
          );
          console.log(
            `link retention: pruned ${purged.shares} share rows, ` +
              `${purged.requests} upload-request rows`,
          );
          // Sign-in counter retention (drive#725): a row whose day window
          // ended more than a day ago is deleted, so the public sign-in route
          // cannot make this table keep every address anybody typed. It deletes
          // counter rows only. Awaited like the link prune: a failed sweep is a
          // failed run, retried the next night.
          const signinSends = await purgeExpiredSigninSends(
            env.DRIVE_DB,
            toMillis(event.scheduledTime, "scheduledTime"),
          );
          console.log(`signin counter retention: pruned ${signinSends.purged} rows`);
        }
        // The nightly size row (drive issue #564): the growth numbers the
        // spec's decision watches, written to nightly_sizes and printed here,
        // where an operator reading Worker logs sees one line a day. Awaited
        // like everything else on this trip: a size row that failed must be a
        // failed run, not a silent gap in the table.
        const sizes = await recordNightlySizes(env.METER_DB, event.scheduledTime);
        console.log(
          `nightly sizes: day=${sizes.day} ` +
            `file_versions=${sizes.fileVersionRows} rows / ${sizes.fileVersionBytes} bytes, ` +
            `usage_minutes=${sizes.usageMinuteRows} rows, file_index=${sizes.fileIndexRows} rows`,
        );
      });
    }
    // The account close cron, on its own trip and its own Sentry Crons
    // check-in (drive#522, CLOSE_SCHEDULE; issue #520). Awaited, not a
    // waitUntil: this trip exists to run this job and nothing else, so a
    // whole-cron failure (D1 down) fails the trigger for Cloudflare to retry
    // and marks the monitor `error`, rather than disappearing into a
    // background promise.
    if (event.cron === CLOSE_SCHEDULE) {
      return withCronCheckIn(event, "nightly-account-close", async () => {
        if (!env.DRIVE_DB) {
          throw new Error("the account close cron needs the drive database");
        }
        const secrets = /** @type {Env & {MAIL_FROM?: string}} */ (env);
        const devices = createD1DeviceStore(env.DRIVE_DB);
        const close = await runAccountCloseCron({
          db: env.DRIVE_DB,
          devices,
          store: files,
          email: env.EMAIL,
          mailFrom: secrets.MAIL_FROM ?? "",
          now: event.scheduledTime,
        });
        // A purge that fails is caught inside the close cron so one account's
        // failure never blocks the others; the resolved count is the only way
        // that failure leaves the function, so it reaches Sentry here (issue
        // #520 review). The failed purges resume next night.
        reportPurgeFailures(close.purgeFailures, close.purged);
        // The counters the pass already returns are the operator's one line
        // for it (drive#522). A mail outage means a receipt or a deletion
        // notice did not go out and a purge may have been skipped; those must
        // be visible in the cron log, not inferable only from the per-send
        // lines.
        if (close.mailFailures > 0 || close.purgeFailures > 0 || close.purgeSkipped > 0) {
          console.error(
            `account close: mailed=${close.mailed} mailFailures=${close.mailFailures} ` +
              `reminded=${close.reminded} purged=${close.purged} ` +
              `purgeFailures=${close.purgeFailures} purgeSkipped=${close.purgeSkipped}`,
          );
        } else {
          console.log(
            `account close: mailed=${close.mailed} reminded=${close.reminded} purged=${close.purged}`,
          );
        }
        // The vendor-key sweep (drive issue #552), on the same store: remove
        // the dead rows' vendor access keys and record how many keys the
        // vendor holds. A deployment whose provider has no removal (the
        // S3/STS one, whose sessions expire on their own) is skipped loudly
        // by the sweep itself; the shared iDrive provider is the one with
        // keys to remove. Awaited like the account close above: a sweep that
        // failed must be a failed trigger, not a run that reported success.
        // The provider is read off the same env the api Worker reads, so the
        // two Workers mint with one credential and the sweep removes what
        // that credential minted.
        const provider = keyProviderFor(env);
        if (provider !== null) {
          await runKeySweep({ devices, provider, now: event.scheduledTime });
        } else {
          console.log(
            "key-sweep: this deployment mints no vendor keys, so there is nothing to sweep",
          );
        }
      });
    }
    // No snapshot backfill trip (drive#399). The leftover `branches.snapshot`
    // column is unread (#329/#338), and production D1 `drive-data` at
    // 2026-10-04T08:37:56Z had `empty_pointer_open=0`, `open_rows=0`,
    // `all_rows=0` (cf d1 query, colo AMS), so there is no open row left
    // whose JSON the sweep could still move. Dropping the column is #339.

    // The nightly trash purge (drive issue #521), wrapped in a Sentry Crons
    // check-in like every scheduled branch (issue #520). Awaited for the same
    // reason as the meter's trips: a purge that failed must be a failed
    // trigger Cloudflare retries, not a run that logged success having removed
    // nothing, because a parked file past 30 days is one the page has
    // already told its person is gone. The store is scoped per account
    // inside `purgeExpiredTrash`, so the listing never crosses accounts.
    if (event.cron === TRASH_PURGE_SCHEDULE) {
      return withCronCheckIn(event, "nightly-trash-purge", async () => {
        if (!env.DRIVE_DB) {
          throw new Error("the nightly trash purge needs the customer database");
        }
        const purged = await purgeExpiredTrash(env.DRIVE_DB, files, event.scheduledTime);
        console.log(
          `trash: removed ${purged.purged} expired file(s) across ${purged.accounts} account(s)`,
        );
      });
    }

    context.waitUntil(
      withCronCheckIn(event, "nightly-reindex", async () => {
        if (!env.DRIVE_DB) {
          throw new Error("the nightly reindex needs the file index database");
        }
        for (const account of await indexAccounts(env.DRIVE_DB)) {
          await reconcileIndex(env.DRIVE_DB, scopeStore(files, account), account);
        }
      }).catch((error) => {
        // Same as the close cron: a waitUntil rejection is invisible to the
        // caller, so the reindex reports its own failure (issue #520) before
        // the rethrow that keeps the platform's record honest.
        captureError(error, "nightly reindex");
        throw new Error(`the nightly reindex failed: ${error.message}`);
      }),
    );
  },

  // The meter's queue consumer (drive#519): one message is one account's
  // hourly step or nightly reconcile, sent by the crons above when the
  // METER_JOBS queue is bound. A job that throws is retried by the platform,
  // and after its retries it lands in the dead-letter queue (src/meter-jobs.js).
  /**
   * @param {{messages: readonly {body: unknown, ack(): void, retry(): void}[]}} batch
   * @param {Env} env
   * @param {ExecutionContext} _context
   * @param {import("../core/files.js").FileStore} [store] injectable like scheduled's
   */
  async queue(batch, env, _context, store = storeFor(env) ?? undefined) {
    const branchMessages = [];
    const meterMessages = [];
    for (const message of batch.messages) {
      const kind =
        message.body !== null && typeof message.body === "object"
          ? /** @type {{kind?: unknown}} */ (message.body).kind
          : "";
      if (typeof kind === "string" && kind.startsWith("branch.")) {
        branchMessages.push(message);
      } else {
        meterMessages.push(message);
      }
    }
    if (branchMessages.length > 0) {
      const snapshots = snapshotsFor(env);
      if (!env.DRIVE_DB || !snapshots || !store) {
        // A missing branch dependency must not fail the meter's messages in
        // the same batch: both producers currently share drive-meter-jobs.
        for (const message of branchMessages) {
          message.retry();
        }
      } else {
        await handleBranchJobs(
          { messages: branchMessages },
          async (job) => {
            const scoped = scopeStore(store, { id: job.accountId });
            const result = await processBranchJob(
              env.DRIVE_DB,
              snapshots,
              scoped,
              { id: job.accountId },
              job.branchId,
            );
            return { continue: result.done === false };
          },
          branchJobsQueue(env),
          async (body, error) => {
            const job = branchJob(body);
            const nextState = job.kind === BRANCH_QUEUE_KINDS.approve ? "open" : "discarded";
            const sentence =
              error instanceof Error && error.message
                ? error.message
                : failureMessage("unexpected");
            await failJob(env.DRIVE_DB, job.branchId, nextState, sentence);
          },
        );
      }
    }
    if (meterMessages.length === 0) {
      return;
    }
    if (!env.METER_DB) {
      throw new Error("meter jobs: METER_DB binding is not configured");
    }
    const secrets = /** @type {Env & {MAIL_FROM?: string}} */ (env);
    const dodo = dodoEnv(env);
    await handleMeterJobs(
      { messages: meterMessages },
      meterJobHandlers({
        meterDb: env.METER_DB,
        capStore: env.DRIVE_DB
          ? createD1DeviceStore(env.DRIVE_DB, { keyProvider: keyProviderFor(env) ?? undefined })
          : undefined,
        email: env.EMAIL,
        mailFrom: secrets.MAIL_FROM ?? "",
        settle: {
          email: env.EMAIL,
          mailFrom: dodo.MAIL_FROM ?? "",
          apiKey: dodo.DODO_PAYMENTS_API_KEY,
          productId: dodo.DODO_TOPUP_PRODUCT_ID,
          baseUrl: dodo.DODO_BASE_URL,
          fetch: dodo.DODO_FETCH ?? globalThis.fetch,
        },
        store,
      }),
    );
  },
};

// withSentry wraps every entrypoint of the object it is given in place, so it
// gets a copy: `monitored` is the Sentry-instrumented handler, and `handler`
// stays the plain one. Each entrypoint below runs the monitored copy only when
// SENTRY_DSN is set and the runtime handed in its context, because the wrap
// reads `context.waitUntil` to flush and `env` to build its options, and a
// caller with neither (the tests, a deployment with no DSN) must run exactly
// the code it ran before Sentry existed (issue #520). The injectable fourth
// `store` argument passes through either way.
const monitored = withSentry(sentryOptions, { ...handler });

/**
 * @param {Env | undefined} env
 * @param {ExecutionContext | undefined} context
 * @returns {typeof handler}
 */
const entrypoints = (env, context) =>
  context && /** @type {{SENTRY_DSN?: string} | undefined} */ (env)?.SENTRY_DSN
    ? /** @type {typeof handler} */ (monitored)
    : handler;

export default {
  async fetch(
    /** @type {Parameters<typeof handler.fetch>[0]} */ request,
    /** @type {Env} */ env,
    /** @type {ExecutionContext} */ context,
  ) {
    return entrypoints(env, context).fetch(request, env, context);
  },
  /**
   * @param {ScheduledController} event
   * @param {Env} env
   * @param {ExecutionContext} context
   * @param {import("../core/files.js").FileStore} [store]
   */
  async scheduled(event, env, context, store) {
    return entrypoints(env, context).scheduled(event, env, context, store);
  },
  /**
   * @param {{messages: readonly {body: unknown, ack(): void, retry(): void}[]}} batch
   * @param {Env} env
   * @param {ExecutionContext} context
   * @param {import("../core/files.js").FileStore} [store]
   */
  async queue(batch, env, context, store) {
    return entrypoints(env, context).queue(batch, env, context, store);
  },
};
