import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { methodNotAllowed } from "hono/method-not-allowed";
import { secureHeaders } from "hono/secure-headers";
import { trimTrailingSlash } from "hono/trailing-slash";
import { createD1DeviceSigninStore } from "../workers/api/src/device-signin.js";
import { createD1DeviceStore } from "../workers/api/src/devices.js";
import { bearerToken } from "../workers/api/src/http.js";
import { keyProviderFor } from "../workers/api/src/keyprovider-env.js";
import {
  CLOSE_CANCEL_ENDPOINT,
  CLOSE_ENDPOINT,
  handleCloseCancelRequest,
  handleCloseRequest,
  handleCloseStatusRequest,
} from "./account-close.js";
import { authFor, SIGNIN_LINK_PATH } from "./auth.js";
import {
  BILLING_CONFIG,
  handleQuoteRequest,
  handleUsageRequest,
  QUOTE_ENDPOINT,
  USAGE_ENDPOINT,
} from "./billing.js";
import { BRANCHES_ENDPOINT, handleBranchesRequest } from "./branches.js";
import { CAP_ENDPOINT, handleCapRequest } from "./cap.js";
import { handleSendEmailRequest, isSameOriginRequest } from "./email-send.js";
import { FILES_ENDPOINT, handleFilesRequest, scopeStore } from "./files.js";
import { HEALTH_PATH, handleHealthRequest } from "./health.js";
import { entrypoints } from "./index-cron.js";
import {
  capStateFor,
  closeDepsFor,
  dodoEnv,
  forwardToApi,
  linksFor,
  liveDevicesFor,
  liveQueueFor,
  snapshotsFor,
  storeFor,
} from "./index-env.js";
import { balanceCents } from "./ledger.js";
import { failureMessage } from "./messages.js";
import { handleStorageEventRequest, monthStart } from "./meter.js";
import { captureError } from "./monitoring.js";
import { handlePortalRequest, PORTAL_ENDPOINT } from "./portal.js";
import { AUTO_TOPUP_ENDPOINT, handleAutoTopUpRequest, prepaidPauseOn } from "./prepaid.js";
import { handleRewindRequest, REWIND_ENDPOINT } from "./rewind.js";
import { handleSearchRequest, SEARCH_ENDPOINT, withIndex } from "./search.js";
import {
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
  balanceLine,
  handleBalanceRequest,
  handleBillingWebhook,
  handleTopUpRequest,
  TOPUP_ENDPOINT,
} from "./topup.js";
import { handleWaitlistRequest } from "./waitlist.js";

// The path the meter, the billing webhook and the tests post a drive email to
// (src/email-send.js). One route, so one place knows the provider.
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

/** @param {string} pathname */
function isPublic(pathname) {
  const clean = pathname.replace(/\/+$/, "") || "/";
  return PUBLIC_ROUTES.some((p) => {
    const route = p.endsWith("/*") ? p.slice(0, -2) : p;
    return clean === route || clean.startsWith(`${route}/`);
  });
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
// same-origin function (src/email-send.js): a caller with no Origin and no
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
    handleShareRequest(c.req.raw, storeFor(c.env), linksFor(c.env), c.get("account")),
  );
  app.post(SHARE_ENDPOINT, (c) =>
    handleShareRequest(c.req.raw, storeFor(c.env), linksFor(c.env), c.get("account"), {
      // The mint route's own bound (drive issue #549). The per-account
      // open-link cap lives in the handler; this is the edge limit.
      limiter: c.env.SHARE_MINT_RATE_LIMITER,
    }),
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
    handleRequestRequest(c.req.raw, storeFor(c.env), linksFor(c.env), c.get("account"), {
      // The mint route's own bound (drive issue #549).
      limiter: c.env.REQUEST_MINT_RATE_LIMITER,
    }),
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
    handleShareFileRequest(c.req.raw, storeFor(c.env), linksFor(c.env), {
      ipLimiter: c.env.SHARE_DOWNLOAD_RATE_LIMITER,
    }),
  );
  app.get(`${REQUEST_ENDPOINT}/info`, (c) =>
    handleRequestInfoRequest(c.req.raw, linksFor(c.env), capStateFor(c.env)),
  );
  app.post(`${REQUEST_ENDPOINT}/upload`, (c) =>
    handleRequestUploadRequest(c.req.raw, storeFor(c.env), linksFor(c.env), capStateFor(c.env), {
      ipLimiter: c.env.REQUEST_UPLOAD_RATE_LIMITER,
      linkLimiter: c.env.REQUEST_UPLOAD_LINK_RATE_LIMITER,
      db: c.env.DRIVE_DB,
      prepaidPause: prepaidPauseOn(c.env),
    }),
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

export default {
  async fetch(
    /** @type {Parameters<ReturnType<typeof entrypoints>["fetch"]>[0]} */ request,
    /** @type {Env} */ env,
    /** @type {ExecutionContext} */ context,
  ) {
    return entrypoints(env, context).fetch(request, env, context);
  },
  /**
   * @param {ScheduledController} event
   * @param {Env} env
   * @param {ExecutionContext} context
   * @param {import("./files.js").FileStore} [store]
   */
  async scheduled(event, env, context, store) {
    return entrypoints(env, context).scheduled(event, env, context, store);
  },
  /**
   * @param {{messages: readonly {body: unknown, ack(): void, retry(): void}[]}} batch
   * @param {Env} env
   * @param {ExecutionContext} context
   * @param {import("./files.js").FileStore} [store]
   */
  async queue(batch, env, context, store) {
    return entrypoints(env, context).queue(batch, env, context, store);
  },
};
