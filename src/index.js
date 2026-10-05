import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { methodNotAllowed } from "hono/method-not-allowed";
import { secureHeaders } from "hono/secure-headers";
import { trimTrailingSlash } from "hono/trailing-slash";
import { createD1DeviceSigninStore } from "../workers/api/src/device-signin.js";
import { createD1DeviceStore } from "../workers/api/src/devices.js";
import { bearerToken, errorResponse } from "../workers/api/src/http.js";
import { keyProviderFor } from "../workers/api/src/keyprovider-env.js";
import { createD1QueueStore } from "../workers/api/src/queues.js";
import {
  CLOSE_CANCEL_ENDPOINT,
  CLOSE_ENDPOINT,
  handleCloseCancelRequest,
  handleCloseRequest,
  handleCloseStatusRequest,
  runAccountCloseCron,
} from "./account-close.js";
import { authFor, SIGNIN_LINK_PATH } from "./auth.js";
import {
  BILLING_CONFIG,
  handleQuoteRequest,
  handleUsageRequest,
  QUOTE_ENDPOINT,
  USAGE_ENDPOINT,
} from "./billing.js";
import { BRANCHES_ENDPOINT, createKvSnapshotStore, handleBranchesRequest } from "./branches.js";
import { CAP_ENDPOINT, capStateForAccount, handleCapRequest, runCapEnforcement } from "./cap.js";
import { billingPushGap, pushBillingHours } from "./dodo.js";
import { handleSendEmailRequest } from "./email-send.js";
import {
  createMemoryStore,
  createS3Store,
  FILES_ENDPOINT,
  handleFilesRequest,
  scopeStore,
  storageBucketForKey,
} from "./files.js";
import { HEALTH_PATH, handleHealthRequest } from "./health.js";
import { failureMessage } from "./messages.js";
import {
  HOUR_MS,
  handleStorageEventRequest,
  METER_CRON,
  METER_RECONCILE_SCHEDULE,
  reconcileMeter,
  runMeterCron,
} from "./meter.js";
import { handlePortalRequest, PORTAL_ENDPOINT } from "./portal.js";
import { handleRewindRequest, REWIND_ENDPOINT } from "./rewind.js";
import {
  handleSearchRequest,
  indexAccounts,
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
  REQUEST_ENDPOINT,
  SHARE_ENDPOINT,
  SHARE_LINK_PREFIX,
} from "./share.js";
import { handleSigninLinkVerify, handleSigninRequest, SIGNIN_ENDPOINT } from "./signin.js";
import { handleStarterRequest, STARTER_ENDPOINT } from "./starter.js";
import {
  handleFirstRunStatusRequest,
  STATUS_ENDPOINT,
  signedInAccount,
  unauthorizedResponse,
} from "./status.js";
import {
  BALANCE_ENDPOINT,
  BILLING_WEBHOOK_PATH,
  handleBalanceRequest,
  handleBillingWebhook,
  handleTopUpRequest,
  TOPUP_ENDPOINT,
} from "./topup.js";
import { handleWaitlistRequest } from "./waitlist.js";

// The path the meter, the billing webhook and the tests post a drive email to
// (src/email-send.js). One route, so one place knows the provider.
const SEND_EMAIL_PATH = "/api/emails/send";

/**
 * The per-request value Hono's context carries. `account` is resolved once by
 * the gate middleware below and read from the context by every handler, so a
 * handler cannot disagree with the gate about who is calling. It is the same
 * shape src/status.js `signedInAccount` returns and every handler's own
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
//     its own shared token in a header (src/meter.js handleStorageEventRequest),
//     not a session. The token is the gate.
//   - /api/emails/send: the meter's cap emails and the billing webhook; closed
//     with no EMAIL_SEND_TOKEN set (src/email-send.js), so its gate is a
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
//     (src/topup.js handleBillingWebhook), and with DODO_WEBHOOK_SECRET unset
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
  return /** @type {{DODO_PAYMENTS_API_KEY?: string, DODO_BASE_URL?: string, DODO_TOPUP_PRODUCT_ID?: string, DODO_WEBHOOK_SECRET?: string, DODO_FETCH?: typeof fetch}} */ (
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
 * pair a local `rclone serve s3` still uses.
 * @typedef {Env & {
 *   FILES_S3_ENDPOINT?: string,
 *   FILES_S3_BUCKET?: string,
 *   FILES_S3_REGION?: string,
 *   FILES_S3_ACCESS_KEY_ID?: string,
 *   FILES_S3_SECRET_ACCESS_KEY?: string,
 *   IDRIVE_S3_ENDPOINT?: string,
 *   IDRIVE_S3_REGION?: string,
 *   IDRIVE_S3_ACCESS_KEY_ID?: string,
 *   IDRIVE_S3_SECRET_ACCESS_KEY?: string,
 * }} StorageEnv
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
function closeDepsFor(env) {
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
function forwardToApi(c) {
  const api = apiBinding(c.env).API;
  if (!api) return errorResponse(503, failureMessage("unexpected"));
  return api.fetch(c.req.raw);
}

/**
 * @param {Env} env
 * @returns {import("./files.js").FileStore}
 */
function storeFor(env) {
  if (!filesStore) {
    const storage = devStorage(env);
    const endpoint = storage.IDRIVE_S3_ENDPOINT || storage.FILES_S3_ENDPOINT;
    if (endpoint) {
      const accessKeyId = storage.IDRIVE_S3_ACCESS_KEY_ID || storage.FILES_S3_ACCESS_KEY_ID;
      const secretAccessKey =
        storage.IDRIVE_S3_SECRET_ACCESS_KEY || storage.FILES_S3_SECRET_ACCESS_KEY;
      const region = storage.IDRIVE_S3_REGION || storage.FILES_S3_REGION;
      const signed =
        typeof accessKeyId === "string" &&
        accessKeyId !== "" &&
        typeof secretAccessKey === "string" &&
        secretAccessKey !== "" &&
        typeof region === "string" &&
        region !== "";
      filesStore = createS3Store({
        endpoint,
        bucketFor: storageBucketForKey,
        ...(signed
          ? {
              region,
              credentials: { accessKeyId, secretAccessKey },
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
// window is src/status.js `connectionStatus`'s own — so this one function fills
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
function capStateFor(env) {
  return (accountId) => capStateForAccount(createD1DeviceStore(env.DRIVE_DB), accountId);
}

// Account-gated middleware resolves the caller once, from the request's own
// credentials and nothing else (src/status.js signedInAccount over
// src/auth.js authFor), and puts that account on Hono's context. Every handler
// below reads it from the context, so a handler cannot disagree with the gate
// about who is calling. An anonymous request is answered 401 here, before the
// store is built or any handler runs — the deny-by-default rule the walk in
// test/account-gate.test.mjs checks route by route.
//
// It is registered on "/api/*" alone and its own isPublic() check skips the
// public routes declared above, so the two public POST routes keep the repo's
// own same-origin rule (src/waitlist.js, src/email-send.js) and the token
// lanes keep their tokens. The browser-facing write lane under /api/files
// additionally takes Hono's built-in csrf() middleware below.
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

// Hono's own csrf() refuses a request with neither Origin nor Sec-Fetch-Site
// before a custom origin/secFetchSite handler is consulted (its undefined
// short-circuit returns false), which would refuse curl and the Go CLI — the
// callers the repo's same-origin rule deliberately lets through, because a
// caller that sends no browser header is not a browser and the account gate
// is what holds it (src/email-send.js isSameOriginRequest, load-bearing in
// src/files.js for the three state-changing routes). So the built-in
// middleware runs only when a browser evidence header is present; a
// non-browser request falls straight through to the handler, whose own
// same-origin check answers with the product's sentence rather than a bare
// "Forbidden". The browser case is still Hono's middleware deciding.
const browserCsrf = csrf({
  origin: (origin, c) => origin === new URL(c.req.url).origin,
  secFetchSite: (site) => site === "same-origin",
});
/**
 * Hono's csrf(), run only when a browser evidence header is present.
 * @type {import("hono").MiddlewareHandler<{Bindings: Env, Variables: DriveVariables}>}
 */
const csrfWhenBrowser = (c, next) =>
  c.req.header("origin") === undefined && c.req.header("sec-fetch-site") === undefined
    ? next()
    : browserCsrf(c, next);

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
      ? { db: c.env.DRIVE_DB, accountState: createD1DeviceStore(c.env.DRIVE_DB).accountState }
      : {},
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

  // Same-origin / CSRF protection on the browser-facing write lane, with
  // Hono's built-in csrf() middleware. It is registered on the account-gated
  // files lane so an anonymous request is its 401, not a 403: the gate is the
  // outer rule. It covers exactly the requests a cross-site page can forge —
  // a form-encoded or multipart POST to the account routes — and reads no
  // header the CLI cannot send: a caller with no Origin and no Sec-Fetch-Site
  // (curl, the Go CLI) is not a browser, so it passes this check and the
  // account gate is what holds it.
  app.use(`${FILES_ENDPOINT}/*`, csrfWhenBrowser);
  app.use(CLOSE_ENDPOINT, csrfWhenBrowser);
  app.use(CLOSE_CANCEL_ENDPOINT, csrfWhenBrowser);
  app.use(TOPUP_ENDPOINT, csrfWhenBrowser);

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
    return handleStarterRequest(
      c.req.raw,
      account ? scopeStore(storeFor(c.env), account) : null,
      account,
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
      // charge has been made and shows no bill, instead of the $10 membership
      // line a card-less account would look like it had been charged. It is
      // the display flag alone: the cap line and the write cap are unchanged.
      cardOnFile = await store.cardAdded(account.id);
      usage = /** @type {Record<string, unknown>} */ (
        await store.monthUsage(account.id, { capUsd })
      );
    }
    // The third argument is the live rclone upload queue, reported by the
    // account's device over its device token and stored in DRIVE_DB
    // (workers/api/src/queues.js, drive issue #318). It is null when no
    // device has reported recently, which is the honest answer for an account
    // whose no device has signed in yet or whose mount is gone (drive issue
    // #308), so the usage page hides the line rather than showing a stale
    // one.
    return handleUsageRequest(
      c.req.raw,
      { ...account, capUsd, cardOnFile, usage },
      await liveQueueFor(c.env, account),
    );
  });

  // The prepaid balance (drive#586): the balance and recent ledger lines, and
  // a top-up's checkout. The balance is credited only by the signed webhook
  // below, never by this route or the checkout's redirect.
  app.get(BALANCE_ENDPOINT, (c) =>
    handleBalanceRequest(c.req.raw, c.get("account"), c.env.DRIVE_DB),
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
    handleShareRequest(c.req.raw, storeFor(c.env), linksFor(c.env), c.get("account")),
  );
  app.post(SHARE_ENDPOINT, (c) =>
    handleShareRequest(c.req.raw, storeFor(c.env), linksFor(c.env), c.get("account")),
  );
  // DELETE revokes a link (`drive share --revoke`); the handler answers it,
  // but a route that is not registered is a 405 before the handler runs.
  app.delete(SHARE_ENDPOINT, (c) =>
    handleShareRequest(c.req.raw, storeFor(c.env), linksFor(c.env), c.get("account")),
  );
  app.get(REQUEST_ENDPOINT, (c) =>
    handleRequestRequest(c.req.raw, storeFor(c.env), linksFor(c.env), c.get("account")),
  );
  app.post(REQUEST_ENDPOINT, (c) =>
    handleRequestRequest(c.req.raw, storeFor(c.env), linksFor(c.env), c.get("account")),
  );
  app.delete(REQUEST_ENDPOINT, (c) =>
    handleRequestRequest(c.req.raw, storeFor(c.env), linksFor(c.env), c.get("account")),
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
    handleShareFileRequest(c.req.raw, storeFor(c.env), linksFor(c.env)),
  );
  app.get(`${REQUEST_ENDPOINT}/info`, (c) =>
    handleRequestInfoRequest(c.req.raw, linksFor(c.env), capStateFor(c.env)),
  );
  app.post(`${REQUEST_ENDPOINT}/upload`, (c) =>
    handleRequestUploadRequest(c.req.raw, storeFor(c.env), linksFor(c.env), capStateFor(c.env), {
      ipLimiter: c.env.REQUEST_UPLOAD_RATE_LIMITER,
      linkLimiter: c.env.REQUEST_UPLOAD_LINK_RATE_LIMITER,
      db: c.env.DRIVE_DB,
    }),
  );

  // Dodo's signed payment webhook (drive#586): credits a top-up, records a
  // refund. Public, because the signature is the proof.
  app.post(BILLING_WEBHOOK_PATH, (c) =>
    handleBillingWebhook(c.req.raw, {
      db: c.env.DRIVE_DB,
      secret: dodoEnv(c.env).DODO_WEBHOOK_SECRET,
    }),
  );

  // The send lane: closed with no EMAIL_SEND_TOKEN set (src/email-send.js).
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
    console.error("[pricing] request failed:", err.message, err.stack, err);
    return c.json({ error: failureMessage("unexpected") }, 500);
  });

  return app;
}

// Static assets serve the pricing page, the first-run page, the Web Files page
// and the usage page; only /api/*, /s/* and the api Worker's /v1/* reach this
// Worker (see runWorkerFirst in cloudflare.config.ts). Anything that does reach
// it and is not an API falls
// through to the assets, so a stray path is a real 404 from the asset worker
// rather than a hand-rolled page.
/**
 * @type {ExportedHandler<Env>}
 */
export default {
  async fetch(request, env) {
    return createApp().fetch(request, env);
  },

  // Three Cron Triggers share this one handler, and the platform's cron string
  // tells them apart, so no trigger spends another's work:
  //   - The meter's hourly rollup (issue #6): roll every closed UTC hour that
  //     has not been rolled yet into usage_minutes, oldest first
  //     (src/meter.js runMeterCron). A D1 failure throws, so Cloudflare
  //     records the trigger as failed and retries, and the catch-up takes
  //     the next one over - a failed rollup must never read as a quiet zero.
  //     The schedule string lives in cloudflare.config.ts, pinned to
  //     src/meter.js's METER_CRON by test/meter.test.mjs.
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
   * @param {import("./files.js").FileStore} [store] the storage store,
   *   injectable so the reindex's own tests hand one in instead of standing
   *   in the runtime's fetch
   * @returns {Promise<void>}
   */
  async scheduled(event, env, context, store = storeFor(env)) {
    // The meter's trip. The controller carries the schedule string the
    // trigger fired for (event.cron), so a run on the meter's schedule does
    // the meter's work and nothing else.
    if (event.cron === METER_CRON) {
      // Awaited, so a D1 failure is Cloudflare's to record and retry: a
      // rollup that returned early would read as a quiet zero.
      const rolled = await runMeterCron(env.METER_DB, event.scheduledTime);
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
      const hours = [];
      for (let hour = rolled.from; hour <= rolled.through; hour += HOUR_MS) {
        hours.push(hour);
      }
      // Test-mode Dodo ingest for the hours this run rolled (drive issue #51).
      // A missing key skips rather than failing the rollup; a failed ingest
      // throws so Cloudflare retries. fetch is injectable as DODO_FETCH so
      // the unit tests can record the request without reaching the network.
      // DODO_BASE_URL overrides the test host (drive issue #323, owner comment
      // 2026-10-03T06:35Z); it defaults to test.dodopayments.com when unset.
      const dodo =
        /** @type {{DODO_PAYMENTS_API_KEY?: string, DODO_FETCH?: typeof fetch, DODO_BASE_URL?: string}} */ (
          env
        );
      const pushed = await pushBillingHours(env.METER_DB, hours, {
        apiKey: dodo.DODO_PAYMENTS_API_KEY,
        fetch: dodo.DODO_FETCH ?? globalThis.fetch,
        baseUrl: dodo.DODO_BASE_URL,
        now: event.scheduledTime,
      });
      // The report on the skip (drive issue #334). pushBillingHours returns
      // {pushed: 0} for a missing key on purpose, and that silence is the bug
      // this names: a deploy whose key was never set, or was set on the wrong
      // Worker, rolls metered hours and bills nobody while /api/health stays
      // green, because health deliberately does not look at secrets.
      //
      // It runs on the cron, beside the skip, and reaches a person reading
      // Worker logs (/api/health cannot: a billing-config gap is not an outage,
      // and health's contract is one failure at a time, not a second opinion).
      // It runs after the push is awaited, and deliberately not under a try:
      // a push that throws on purpose (Cloudflare retries the rollup) also
      // ends this run, so the report is suppressed for that cycle and speaks
      // on the next one. That is fine because a throwing push is itself the
      // loud event; the report answers the silent path only.
      //
      // Guarded on purpose. The push above may throw - Cloudflare retries the
      // rollup, because an unpushed hour should be retried. The report must
      // not: a detector that fails the work it is reporting on is worse than
      // no detector, because a transient D1 error, a schema change or a bad
      // trigger time would then retry a rollup that already billed everyone
      // correctly. Every failure path in billingPushGap is logged and dropped.
      const gap = await billingPushGap(env.METER_DB, {
        apiKey: dodo.DODO_PAYMENTS_API_KEY,
        now: event.scheduledTime,
      }).catch((error) => {
        console.error(
          "billing: the gap report failed, so it says nothing about this run",
          error instanceof Error ? error.message : String(error),
        );
        return null;
      });
      if (gap && gap.hours > 0) {
        // Value-free: hours, the oldest one, and which of the two causes the
        // issue names. Never the key, never an account id.
        console.error(
          "billing: metered hours reached nobody",
          gap.missingKey
            ? "DODO_PAYMENTS_API_KEY is not set on this Worker, so the push skipped"
            : "DODO_PAYMENTS_API_KEY is set but hours are still unpushed; check the key is the right one for this Worker",
          `hours=${gap.hours}`,
          `oldest=${new Date(gap.since ?? event.scheduledTime).toISOString()}`,
        );
      } else if (gap && pushed.pushed > 0) {
        // The healthy counter-case, so the absence of the line above is
        // meaningful: a person tailing logs can tell "nothing wrong" from
        // "the report stopped running". `gap` is non-null here, so the gap
        // was measured and came back zero; a report that failed prints its own
        // line above and must not be followed by an all-clear. console.log,
        // not console.error - error level is for actionable failures, and
        // training an operator to ignore the error channel is how the next gap
        // goes unseen.
        console.log(`billing: push working, ${pushed.pushed} hour(s) ingested this run`);
      }
      // A cap step that failed for some accounts is raised last, after every
      // other account was decided and the hours were pushed, so Cloudflare
      // records a failed trigger and the next run retries those accounts.
      if (capFailures.length > 0) {
        throw new AggregateError(
          capFailures.map((failure) => failure.error),
          `cap: enforcement failed for ${capFailures.length} account(s)`,
        );
      }
      return;
    }
    // The meter's nightly trip. Awaited for the same reason: a repair that
    // failed must be a failed trigger, not a run that reported success having
    // fixed nothing. The store is the one every account-scoped handler uses;
    // `reconcileMeter` scopes it per account, so the provider listing never
    // crosses accounts.
    if (event.cron === METER_RECONCILE_SCHEDULE) {
      // The account close cron is its own waitUntil (drive#565), registered
      // before the reconcile runs: a reconcileMeter throw used to leave every
      // close receipt, reminder and purge undone for that night, and the
      // purge is resumable now, so the two trips have nothing to say to each
      // other. Its own per-account catches mean only a whole-cron failure
      // (D1 down) rejects here, and a failed trigger is the honest signal
      // for that: the next night retries everything it did not finish.
      if (env.DRIVE_DB) {
        const secrets = /** @type {Env & {MAIL_FROM?: string}} */ (env);
        context.waitUntil(
          runAccountCloseCron({
            db: env.DRIVE_DB,
            devices: createD1DeviceStore(env.DRIVE_DB),
            store,
            email: env.EMAIL,
            mailFrom: secrets.MAIL_FROM ?? "",
            now: event.scheduledTime,
          }).catch((error) => {
            throw new Error(`the account close cron failed: ${error.message}`);
          }),
        );
      }
      await reconcileMeter(env.METER_DB, storeFor(env), event.scheduledTime);
      return;
    }
    // No snapshot backfill trip (drive#399). The leftover `branches.snapshot`
    // column is unread (#329/#338), and production D1 `drive-data` at
    // 2026-10-04T08:37:56Z had `empty_pointer_open=0`, `open_rows=0`,
    // `all_rows=0` (cf d1 query, colo AMS), so there is no open row left
    // whose JSON the sweep could still move. Dropping the column is #339.

    context.waitUntil(
      (async () => {
        if (!env.DRIVE_DB) {
          throw new Error("the nightly reindex needs the file index database");
        }
        for (const account of await indexAccounts(env.DRIVE_DB)) {
          await reconcileIndex(env.DRIVE_DB, scopeStore(store, account), account);
        }
      })().catch((error) => {
        throw new Error(`the nightly reindex failed: ${error.message}`);
      }),
    );
  },
};
