import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { methodNotAllowed } from "hono/method-not-allowed";
import { secureHeaders } from "hono/secure-headers";
import { trimTrailingSlash } from "hono/trailing-slash";
import { createD1DeviceSigninStore } from "../workers/api/src/device-signin.js";
import { createD1DeviceStore } from "../workers/api/src/devices.js";
import { bearerToken, errorResponse } from "../workers/api/src/http.js";
import { createD1QueueStore } from "../workers/api/src/queues.js";
import { s3KeyProviderFromEnv } from "../workers/api/src/s3-keys.js";
import { authFor, SIGNIN_LINK_PATH } from "./auth.js";
import { BILLING_CONFIG, handleUsageRequest, USAGE_ENDPOINT, usageSummary } from "./billing.js";
import {
  BRANCHES_ENDPOINT,
  backfillBranchSnapshots,
  createKvSnapshotStore,
  handleBranchesRequest,
  SNAPSHOT_BACKFILL_SCHEDULE,
} from "./branches.js";
import { CAP_ENDPOINT, handleCapRequest } from "./cap.js";
import { billingPushGap, pushBillingHours } from "./dodo.js";
import { handleSendEmailRequest } from "./email-send.js";
import {
  createMemoryStore,
  createS3Store,
  FILES_ENDPOINT,
  handleFilesRequest,
  scopeStore,
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
]);

/** @param {string} pathname */
function isPublic(pathname) {
  const clean = pathname.replace(/\/+$/, "") || "/";
  return PUBLIC_ROUTES.some((p) => {
    const route = p.endsWith("/*") ? p.slice(0, -2) : p;
    return clean === route || clean.startsWith(`${route}/`);
  });
}

// One store per Worker isolate, holding every account's files under its own
// prefix. With no storage configured the in-memory store holds what the page
// uploaded this run, so the Web Files page is real in dev and in the tests;
// FILES_S3_ENDPOINT and FILES_S3_BUCKET point the same handlers at
// `rclone serve s3` instead. The real scoped-key adapter lands with #2 behind
// the same FileStore interface. Both are plain stores over storage keys: the
// account prefix and the isolation between accounts are scopeStore's job
// (src/files.js), so an adapter never has to know about an account.
/** @type {import("./files.js").FileStore|undefined} */
let filesStore;
/**
 * The `rclone serve s3` stand-in's two config vars (drive issue #1's build
 * host). They are set in the environment of a local dev run, never declared
 * as bindings in cloudflare.config.ts: the deployed Worker has no S3 stand-in,
 * and a declared binding would also have to be probed by the health check
 * (test/health.test.mjs) when there is nothing to probe. So they are read off
 * the worker's own env as the optional pair the dev-only path takes, and the
 * env is widened with exactly that pair and nothing else.
 * @param {Env} env
 * @returns {Env & {FILES_S3_ENDPOINT?: string, FILES_S3_BUCKET?: string}}
 */
function devStorage(env) {
  return /** @type {Env & {FILES_S3_ENDPOINT?: string, FILES_S3_BUCKET?: string}} */ (env);
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
    const dev = devStorage(env);
    filesStore =
      dev.FILES_S3_ENDPOINT && dev.FILES_S3_BUCKET
        ? createS3Store({
            endpoint: dev.FILES_S3_ENDPOINT,
            bucket: dev.FILES_S3_BUCKET,
          })
        : createMemoryStore();
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
 * The `_accountId` is the swap point's seam: the meter (issue #6) will read
 * the named account's usage_minutes rows here, and until it lands every
 * account gets the empty month the usage endpoint answers with.
 *
 * @param {string} _accountId
 */
function capStateFor(_accountId) {
  const empty = usageSummary({
    gbMinutes: 0,
    peakGb: 0,
    storedGb: 0,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: 0,
    capUsd: BILLING_CONFIG.defaultCapUsd,
    cardAdded: true,
  });
  return empty.cap.state;
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
const filesHandler = (c) => {
  const account = c.get("account");
  return handleFilesRequest(
    c.req.raw,
    account ? withIndex(storeFor(c.env), c.env.DRIVE_DB, account) : null,
    account,
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

  // The first-run page's live flip (issue #32, #45). The third argument is
  // the queue a device on this account reported, read from the row the api
  // Worker's report route wrote (drive issue #318): #308 made it an argument
  // to the handler, and the read is the one line that fills it.
  app.get(STATUS_ENDPOINT, async (c) => {
    const account = c.get("account");
    const upload = account ? await liveQueueFor(c.env, account) : null;
    return handleFirstRunStatusRequest(c.req.raw, account, upload);
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
    if (!account) return unauthorizedResponse();
    if (c.env.DRIVE_DB) {
      capUsd = await createD1DeviceStore(c.env.DRIVE_DB).getCapUsd(account.id);
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
      { ...account, capUsd },
      await liveQueueFor(c.env, account),
    );
  });

  // `drive cap <dollars>` and the usage page's cap write (drive#64). The
  // amount is parsed with parseCapUsd() and persisted as accounts.cap_cents.
  app.get(CAP_ENDPOINT, (c) => handleCapRequest(c.req.raw, c.get("account"), null));
  app.post(CAP_ENDPOINT, async (c) => {
    const db = c.env.DRIVE_DB;
    const store = db
      ? createD1DeviceStore(db, { keyProvider: s3KeyProviderFromEnv(c.env) ?? undefined })
      : null;
    return handleCapRequest(c.req.raw, c.get("account"), store);
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
  app.get(REQUEST_ENDPOINT, (c) =>
    handleRequestRequest(c.req.raw, storeFor(c.env), linksFor(c.env), c.get("account")),
  );
  app.post(REQUEST_ENDPOINT, (c) =>
    handleRequestRequest(c.req.raw, storeFor(c.env), linksFor(c.env), c.get("account")),
  );

  // ----------------------------------------------------------- public routes
  // Sign-ups (GET is a 405 from methodNotAllowed; POST is the route).
  app.post("/api/waitlist", (c) =>
    handleWaitlistRequest(c.req.raw, c.env.WAITLIST_DB, c.env.WAITLIST_RATE_LIMITER),
  );

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
    handleRequestInfoRequest(c.req.raw, linksFor(c.env), capStateFor),
  );
  app.post(`${REQUEST_ENDPOINT}/upload`, (c) =>
    handleRequestUploadRequest(c.req.raw, storeFor(c.env), linksFor(c.env), capStateFor, {
      ipLimiter: c.env.REQUEST_UPLOAD_RATE_LIMITER,
      linkLimiter: c.env.REQUEST_UPLOAD_LINK_RATE_LIMITER,
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

  // Four Cron Triggers share this one handler, and the platform's cron string
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
  //   - The snapshot backfill (build step 7's contract, drive issue #321):
  //     `backfillBranchSnapshots` moves the open pre-namespace rows' JSON out
  //     of the legacy `branches.snapshot` column into BRANCH_SNAPSHOTS, under
  //     each row's own `snapshotKey`, and sets the row's pointer and byte
  //     length. It skips a closed branch and leaves the column in place, and
  //     it is awaited so a failed sweep is a failed trigger Cloudflare
  //     retries. The schedule is imported from the module that owns the sweep
  //     (src/branches.js), pinned by test/branches.test.mjs the way
  //     src/meter.js's METER_CRON is by test/meter.test.mjs.
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
      return;
    }
    // The meter's nightly trip. Awaited for the same reason: a repair that
    // failed must be a failed trigger, not a run that reported success having
    // fixed nothing. The store is the one every account-scoped handler uses;
    // `reconcileMeter` scopes it per account, so the provider listing never
    // crosses accounts.
    if (event.cron === METER_RECONCILE_SCHEDULE) {
      await reconcileMeter(env.METER_DB, storeFor(env), event.scheduledTime);
      return;
    }
    // The snapshot backfill's trip (drive issue #321): every open branch that
    // predates the namespace keeps its JSON in the legacy `branches.snapshot`
    // column, and this sweep moves each into BRANCH_SNAPSHOTS under its own
    // key and sets the row's pointer and byte length — the step before the
    // column can be dropped. Awaited, so a failed sweep is a failed trigger
    // Cloudflare retries: the rows it did not reach are the next night's work,
    // and the sweep is idempotent, so a repeat is free. The schedule is the
    // only way a backfill starts, exactly like the reindex above: no web
    // route walks every open branch a drive ever made.
    if (event.cron === SNAPSHOT_BACKFILL_SCHEDULE) {
      const snapshots = snapshotsFor(env);
      if (!snapshots) {
        throw new Error("the snapshot backfill needs the BRANCH_SNAPSHOTS namespace");
      }
      await backfillBranchSnapshots(env.DRIVE_DB, snapshots);
      return;
    }
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
