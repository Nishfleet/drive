import { withSentry } from "@sentry/cloudflare";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { methodNotAllowed } from "hono/method-not-allowed";
import { secureHeaders } from "hono/secure-headers";
import { trimTrailingSlash } from "hono/trailing-slash";
import { SIGNIN_LINK_PATH } from "../core/auth.js";
import {
  BILLING_CONFIG,
  handleQuoteRequest,
  handleUsageRequest,
  QUOTE_ENDPOINT,
  USAGE_ENDPOINT,
} from "../core/billing.js";
import { CAP_ENDPOINT, handleCapRequest } from "../core/cap.js";
import { createD1DeviceStore } from "../core/devices.js";
import { handleSendEmailRequest } from "../core/email-send.js";
import { FILES_ENDPOINT, scopeStore } from "../core/files.js";
import { keyProviderFor } from "../core/keyprovider-env.js";
import { balanceCents } from "../core/ledger.js";
import { failureMessage } from "../core/messages.js";
import { downloadRecorder, handleStorageEventRequest, monthStart } from "../core/meter.js";
import { AUTO_TOPUP_ENDPOINT, handleAutoTopUpRequest, prepaidPauseOn } from "../core/prepaid.js";
import {
  handleFirstRunStatusRequest,
  STATUS_ENDPOINT,
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
  handleCloseCancelRequest,
  handleCloseRequest,
  handleCloseStatusRequest,
} from "./account-close.js";
import { branchJobsQueue } from "./branch-jobs.js";
import { BRANCHES_ENDPOINT, handleBranchesRequest } from "./branches.js";
import { HEALTH_PATH, handleHealthRequest } from "./health.js";
import {
  API_PATH_PREFIX,
  accountGate,
  capStateFor,
  closeDepsFor,
  csrfWhenBrowser,
  dodoEnv,
  filesHandler,
  forwardToApi,
  linksFor,
  liveDevicesFor,
  liveQueueFor,
  SEND_EMAIL_PATH,
  snapshotsFor,
  storeFor,
  withFileStore,
} from "./index-env.js";
import { queue, scheduled } from "./index-scheduled.js";
import { captureError } from "./monitoring.js";
import { handlePortalRequest, PORTAL_ENDPOINT } from "./portal.js";
import { handleRewindRequest, REWIND_ENDPOINT } from "./rewind.js";
import { handleSearchRequest, SEARCH_ENDPOINT } from "./search.js";
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
import { handleWaitlistRequest } from "./waitlist.js";

export { PUBLIC_ROUTES, TEST_FILES_STORE } from "./index-env.js";

/** @typedef {import("./index-env.js").DriveApp} DriveApp */
/** @typedef {import("./index-env.js").DriveContext} DriveContext */
/** @typedef {import("./index-env.js").DriveVariables} DriveVariables */

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
    return createApp().fetch(request, env);
  },
  scheduled,
  queue,
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
