import { Hono } from "hono";
import { authFor, SIGNIN_LINK_PATH } from "../core/auth.js";
import { QUOTE_ENDPOINT } from "../core/billing.js";
import { capStateForAccount } from "../core/cap.js";
import { createD1DeviceSigninStore } from "../core/device-signin.js";
import { createD1DeviceStore } from "../core/devices.js";
import { isSameOriginRequest } from "../core/email-send.js";
import {
  createS3Store,
  handleFilesRequest,
  storageBucketForKey,
  storageVarsFromEnv,
} from "../core/files.js";
import { bearerToken, errorResponse } from "../core/http.js";
import { keyProviderFor } from "../core/keyprovider-env.js";
import { failureMessage } from "../core/messages.js";
import { downloadRecorder } from "../core/meter.js";
import { prepaidPauseOn } from "../core/prepaid.js";
import { createD1QueueStore } from "../core/queues.js";
import { signedInAccount, unauthorizedResponse } from "../core/status.js";
import { BILLING_WEBHOOK_PATH } from "../core/topup.js";
import { createKvSnapshotStore } from "./branches.js";
import { HEALTH_PATH } from "./health.js";
import { withIndex } from "./search.js";
import { createD1LinkStore, REQUEST_ENDPOINT, SHARE_LINK_PREFIX } from "./share.js";
import { SIGNIN_ENDPOINT } from "./signin.js";

// The path the meter, the billing webhook and the tests post a drive email to
// (core/email-send.js). One route, so one place knows the provider.
export const SEND_EMAIL_PATH = "/api/emails/send";

// The api Worker's family (workers/api/src/routes.js API_PREFIX), the one path
// this Worker forwards and never renders a page for. Spelled here the way the
// /v1/* route is, rather than imported, so the site Worker does not pull the
// whole api route registry into its bundle; test/deploy-assets.test.mjs pins
// the error path against a browser Accept on this family.
export const API_PATH_PREFIX = "/v1";

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
export function dodoEnv(env) {
  return /** @type {{DODO_PAYMENTS_API_KEY?: string, DODO_BASE_URL?: string, DODO_TOPUP_PRODUCT_ID?: string, DODO_WEBHOOK_SECRET?: string, DODO_FETCH?: typeof fetch, MAIL_FROM?: string, PREPAID_PAUSE?: string}} */ (
    /** @type {unknown} */ (env)
  );
}

/** @param {string} pathname */
export function isPublic(pathname) {
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
export const missingFilesStoreLogged = new WeakSet();
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
export function devStorage(env) {
  return /** @type {StorageEnv} */ (env);
}

/**
 * The close handlers' dependencies, or null when this deployment has no
 * customer database or no storage endpoint. A missing database or store is a
 * 503 from the route, not an in-memory close that would vanish on the next
 * isolate (drive#505).
 * @param {Env} env
 */
export function closeDepsFor(env) {
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
export function apiBinding(env) {
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
 * @returns {import("../core/files.js").FileStore | null}
 */
export function storeFor(env) {
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
export function withFileStore(c, run) {
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
// window is core/status.js `connectionStatus`'s own — so this one function fills
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
export function capStateFor(env) {
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
export async function accountGate(
  /** @type {DriveContext} */ c,
  /** @type {import("hono").Next} */ next,
) {
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
export const CSRF_EXEMPT_PATHS = new Set(["/api/waitlist", SEND_EMAIL_PATH]);
/**
 * Same-origin CSRF on every write except the two public POSTs that keep
 * their own handler copies.
 * @type {import("hono").MiddlewareHandler<{Bindings: Env, Variables: DriveVariables}>}
 */
export const csrfWhenBrowser = async (c, next) => {
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
export const filesHandler = async (c) => {
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
