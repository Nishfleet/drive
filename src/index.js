import { authFor, SIGNIN_LINK_PATH } from "./auth.js";
import { BILLING_CONFIG, handleUsageRequest, USAGE_ENDPOINT, usageSummary } from "./billing.js";
import { BRANCHES_ENDPOINT, handleBranchesRequest } from "./branches.js";
import { handleSendEmailRequest } from "./email-send.js";
import {
  createMemoryStore,
  createS3Store,
  FILES_ENDPOINT,
  handleFilesRequest,
  scopeStore,
} from "./files.js";
import { HEALTH_PATH, handleHealthRequest } from "./health.js";
import { handleStorageEventRequest, METER_CRON, runMeterCron } from "./meter.js";
import { handleRewindRequest, REWIND_ENDPOINT } from "./rewind.js";
import {
  handleSearchRequest,
  indexAccounts,
  reconcileIndex,
  SEARCH_ENDPOINT,
  withIndex,
} from "./search.js";
import {
  createMemoryLinkStore,
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
import { handleFirstRunStatusRequest, STATUS_ENDPOINT, signedInAccount } from "./status.js";
import { handleWaitlistRequest } from "./waitlist.js";

// The path the meter, the billing webhook and the tests post a drive email to
// (src/email-send.js). One route, so one place knows the provider.
const SEND_EMAIL_PATH = "/api/emails/send";

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

// One link store per Worker isolate, the same stand-in shape storeFor() uses
// for files: the in-memory LinkStore stands in until the accounts store lands
// (#55), where the shares and upload_requests rows move to D1 behind the same
// interface (src/share.js). Sharing the FileStore above is what makes a file
// dropped through an upload page appear on the owner's drive at its next
// listing.
/** @type {import("./share.js").LinkStore|undefined} */
let linksStore;
function linksFor() {
  if (!linksStore) {
    linksStore = createMemoryLinkStore();
  }
  return linksStore;
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

// Static assets serve the pricing page, the first-run page, the Web Files page
// and the usage page; only /api/* reaches this Worker (see runWorkerFirst in
// cloudflare.config.ts). Anything that does reach it and is not an API falls
// through to the assets, so a stray path is a real 404 from the asset worker
// rather than a hand-rolled page.
//
// The send-email route is mounted behind its deployment's token and the
// same-origin rule (src/email-send.js), which together keep it from mailing
// an arbitrary person from our domain: with EMAIL_SEND_TOKEN unset the route
// answers 403, so the deployment is closed until the token is set, and the
// first producers are the meter's cap emails and the billing webhook
// (build step 6, drive#7).
/**
 * @type {ExportedHandler<Env>}
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/waitlist" || url.pathname === "/api/waitlist/") {
      return handleWaitlistRequest(request, env.WAITLIST_DB, env.WAITLIST_RATE_LIMITER);
    }
    // The meter's event intake (issue #6). The storage provider's event rule
    // lands here with the shared token in a header; the dedup in
    // src/meter.js makes the provider's own retries safe, so no rate limiter
    // is bound to this path.
    if (url.pathname === "/api/storage-events" || url.pathname === "/api/storage-events/") {
      return handleStorageEventRequest(request, env.METER_DB, env.METER_EVENT_TOKEN);
    }
    // The first-run page's live flip (issue #32). runWorkerFirst sends every
    // /api/* here; the branch just has to come before the asset fallthrough.
    // The handler is closed until the sign-in flow resolves an account
    // (issue #45), so an anonymous poll gets 401 and no device data. The path
    // is the module's own constant, so the route and the page cannot drift.
    if (url.pathname === STATUS_ENDPOINT || url.pathname === `${STATUS_ENDPOINT}/`) {
      return handleFirstRunStatusRequest(request, await signedInAccount(request, authFor(env)));
    }
    // Search reads only the D1 file index (issue #18), behind the same account
    // gate every drive read that names files goes through (`signedInAccount`,
    // issues #45 and #73): an anonymous caller gets 401 and no names, and a
    // signed-in one reads only their own rows. The write half of the same
    // module keeps the index current by wrapping the store, so an upload, a
    // delete or a restore is in the index before the next search, and the
    // search itself never lists the bucket. The rebuild is not a web route:
    // it runs from the scheduled handler below. The index is customer data, so
    // it reads DRIVE_DB, never the waitlist's database (issue #170).
    if (url.pathname === SEARCH_ENDPOINT || url.pathname === `${SEARCH_ENDPOINT}/`) {
      return handleSearchRequest(
        request,
        env.DRIVE_DB,
        await signedInAccount(request, authFor(env)),
      );
    }
    // The files handler is behind the same account gate as the page's poll
    // (issue #73): it answers 401 with no data for a request that cannot prove
    // an account, and scopes every read and write to that account's prefix.
    if (
      url.pathname === FILES_ENDPOINT ||
      url.pathname === `${FILES_ENDPOINT}/` ||
      url.pathname.startsWith(`${FILES_ENDPOINT}/`)
    ) {
      // The gate is asked before the store is built. A request that cannot
      // prove an account is answered by the handler's own 401 with no store
      // in the call at all, so a misconfigured deployment fails for its own
      // signed-in callers and tells a stranger nothing about itself. The
      // index wrapper sits outside the scope the handler applies, so it sees
      // the account's own storage keys and writes only that account's rows.
      const account = await signedInAccount(request, authFor(env));
      return handleFilesRequest(
        request,
        account ? withIndex(storeFor(env), env.DRIVE_DB, account) : null,
        account,
      );
    }
    // Branches (build step 7, drive#8): the folder copy, the diff, approve and
    // discard. The same account gate as every other route that names files,
    // and the store is handed in unscoped (the handler scopes it) and without
    // withIndex, so a branch's own copies never land in the search index.
    if (url.pathname === BRANCHES_ENDPOINT || url.pathname.startsWith(`${BRANCHES_ENDPOINT}/`)) {
      const account = await signedInAccount(request, authFor(env));
      return handleBranchesRequest(request, env.DRIVE_DB, account ? storeFor(env) : null, account);
    }
    // Agent undo (build step 11, issue #13): the one-click rewind of an
    // agent's work, on the branch copy src/branches.js already keeps. Same
    // account gate and the same store handling as the branches route above —
    // unscoped in, scoped by the handler — so a rewind can only ever name one
    // of the signed-in account's own branches. A rewind is a discard, so it
    // reads and writes the one branches table and the one file store; there is
    // no second copy of the agent's work anywhere.
    if (url.pathname === REWIND_ENDPOINT || url.pathname.startsWith(`${REWIND_ENDPOINT}/`)) {
      const account = await signedInAccount(request, authFor(env));
      return handleRewindRequest(request, env.DRIVE_DB, account ? storeFor(env) : null, account);
    }
    // The usage page's and the CLI's read of the month's money (issues #7 and
    // #53, build step 6). Same rule: the branch comes before the asset
    // fallthrough, and the account gate is what keeps one account's numbers
    // from being shown to another (issue #73).
    if (url.pathname === USAGE_ENDPOINT || url.pathname === `${USAGE_ENDPOINT}/`) {
      return handleUsageRequest(request, await signedInAccount(request, authFor(env)));
    }
    // The sign-in screen's two steps (build step 9, issue #10; Better Auth
    // over D1, #181). The start step mails a single-use link; the sign-out
    // step revokes the session. The link itself is the next branch below.
    // Registered here, ahead of the asset fallthrough, because /api/signin
    // must reach the Worker. The handler enforces the two edge limits (issue
    // #147, env.SIGNIN_RATE_LIMITER / env.SIGNIN_GLOBAL_RATE_LIMITER) before
    // it reads the body, so a start that mails a real email is bounded at the
    // edge and a refused request costs no parse and no send.
    if (url.pathname === SIGNIN_ENDPOINT || url.pathname === `${SIGNIN_ENDPOINT}/`) {
      return handleSigninRequest(request, env);
    }
    // The link a sign-in email carries (drive#181): GET only, the token is
    // the whole proof. The route verifies it against Better Auth, sets the
    // session cookie the account routes are gated on, and sends a signed-in
    // person to their files. No session is required to reach it — signing
    // in is the only way to get one, so it must be reachable without one —
    // and the closed-door check inside handleSigninLinkVerify keeps a
    // deployment with no auth bound from minting sessions it cannot stand
    // behind.
    if (url.pathname === SIGNIN_LINK_PATH || url.pathname === `${SIGNIN_LINK_PATH}/`) {
      return handleSigninLinkVerify(request, env);
    }
    // Share links and upload requests (issue #19). The share/request roots
    // are the owner's side and stand behind the same gate as /api/files
    // (issue #73): a caller that cannot prove an account gets 401 with no
    // link, no file and no list. /s/<token>, the request info and the upload
    // route are the logged-out side and carry the token in the path or the
    // query instead of a session, so they do not ask the gate for an account
    // — the token is the whole proof, and one that expires or is revoked
    // answers 404 (src/share.js).
    if (url.pathname === SHARE_ENDPOINT || url.pathname === `${SHARE_ENDPOINT}/`) {
      return handleShareRequest(
        request,
        storeFor(env),
        linksFor(),
        await signedInAccount(request, authFor(env)),
      );
    }
    if (url.pathname.startsWith(`${SHARE_LINK_PREFIX}/`)) {
      return handleShareFileRequest(request, storeFor(env), linksFor());
    }
    if (url.pathname === REQUEST_ENDPOINT || url.pathname === `${REQUEST_ENDPOINT}/`) {
      return handleRequestRequest(
        request,
        storeFor(env),
        linksFor(),
        await signedInAccount(request, authFor(env)),
      );
    }
    // The two public request routes are matched after the owner's /api/request
    // root so the exact root is never mistaken for its own child.
    if (url.pathname === `${REQUEST_ENDPOINT}/info`) {
      return handleRequestInfoRequest(request, linksFor(), capStateFor);
    }
    if (url.pathname === `${REQUEST_ENDPOINT}/upload`) {
      return handleRequestUploadRequest(request, storeFor(env), linksFor(), capStateFor);
    }
    if (url.pathname === SEND_EMAIL_PATH) {
      // The whole env, not just the binding: the route reads the token and
      // the sending address too (src/email-send.js handleSendEmailRequest).
      return handleSendEmailRequest(request, env);
    }
    // The health endpoint the outside monitor polls (issue #96, #36). It
    // comes before the asset fallthrough and takes the whole env because the
    // check reads the dependencies off the bindings: a trivially-read D1 on
    // each database and a fetch of the asset layer. The whole env is the
    // honest argument — a check that only saw the bindings it was told about
    // would be a check that could not fail.
    if (url.pathname === HEALTH_PATH || url.pathname === `${HEALTH_PATH}/`) {
      return handleHealthRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  },

  // Two Cron Triggers share this one handler, and the platform's cron string
  // tells them apart, so neither trigger spends the other's work:
  //   - The meter's hourly rollup (issue #6): roll every closed UTC hour that
  //     has not been rolled yet into usage_minutes, oldest first
  //     (src/meter.js runMeterCron). A D1 failure throws, so Cloudflare
  //     records the trigger as failed and retries, and the catch-up takes
  //     the next one over - a failed rollup must never read as a quiet zero.
  //     The schedule string lives in cloudflare.config.ts, pinned to
  //     src/meter.js's METER_CRON by test/meter.test.mjs.
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
      await runMeterCron(env.METER_DB, event.scheduledTime);
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
