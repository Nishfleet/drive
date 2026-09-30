import { handleWaitlistRequest } from "./waitlist.js";
import { handleFirstRunStatusRequest } from "./status.js";
import {
  FILES_ENDPOINT,
  createMemoryStore,
  createS3Store,
  handleFilesRequest,
  resolveAccount,
} from "./files.js";
import { signedInAccount } from "./status.js";
import { USAGE_ENDPOINT, handleUsageRequest } from "./billing.js";
import { handleSendEmailRequest } from "./email-send.js";
import { SEARCH_ENDPOINT, handleSearchRequest, reconcileIndex, withIndex } from "./search.js";

// The path the meter, the billing webhook and the tests post a drive email to
// (src/email-send.js). One route, so one place knows the provider.
const SEND_EMAIL_PATH = "/api/emails/send";

// One drive per Worker isolate (build step 1's stand-in). With no storage
// configured the in-memory store holds what the page uploaded this run, so the
// Web Files page is real in dev and in the tests; FILES_S3_ENDPOINT and
// FILES_S3_BUCKET point the same handlers at `rclone serve s3` instead. The
// real scoped-key adapter lands with #2 behind the same FileStore interface.
let filesStore;
function storeFor(env) {
  if (!filesStore) {
    filesStore =
      env.FILES_S3_ENDPOINT && env.FILES_S3_BUCKET
        ? createS3Store({
            endpoint: env.FILES_S3_ENDPOINT,
            bucket: env.FILES_S3_BUCKET,
          })
        : createMemoryStore();
  }
  return filesStore;
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
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/waitlist" || url.pathname === "/api/waitlist/") {
      return handleWaitlistRequest(
        request,
        env.WAITLIST_DB,
        env.WAITLIST_RATE_LIMITER,
      );
    }
    // The first-run page's live flip (issue #32). runWorkerFirst sends every
    // /api/* here; the branch just has to come before the asset fallthrough.
    // The handler is closed until the sign-in flow resolves an account
    // (issue #45), so an anonymous poll gets 401 and no device data.
    if (
      url.pathname === "/api/first-run-status" ||
      url.pathname === "/api/first-run-status/"
    ) {
      return handleFirstRunStatusRequest(request, signedInAccount(request));
    }
    // The Web Files page's listing, download, upload and restore (issue #31).
    // Search reads only the D1 file index (issue #18), behind the account
    // gate every drive read that names files goes through (`signedInAccount`,
    // issue #45): an anonymous caller gets 401 and no names, and a signed-in
    // one reads only their own rows. The write half of the same module keeps
    // the index current by wrapping the store, so an upload, a delete or a
    // restore is in the index before the next search, and the search itself
    // never lists the bucket. The rebuild is not a web route: it runs from
    // the scheduled handler below.
    if (
      url.pathname === SEARCH_ENDPOINT ||
      url.pathname === `${SEARCH_ENDPOINT}/`
    ) {
      return handleSearchRequest(
        request,
        env.WAITLIST_DB,
        signedInAccount(request),
      );
    }
    if (
      url.pathname === FILES_ENDPOINT ||
      url.pathname === `${FILES_ENDPOINT}/` ||
      url.pathname.startsWith(`${FILES_ENDPOINT}/`)
    ) {
      return handleFilesRequest(
        request,
        withIndex(storeFor(env), env.WAITLIST_DB, resolveAccount(request)),
        resolveAccount(request),
      );
    }
    // The usage page's and the CLI's read of the month's money (issues #7 and
    // #53, build step 6). Same rule: the branch comes before the asset
    // fallthrough.
    if (
      url.pathname === USAGE_ENDPOINT ||
      url.pathname === `${USAGE_ENDPOINT}/`
    ) {
      return handleUsageRequest(request);
    }
    if (url.pathname === SEND_EMAIL_PATH) {
      // The whole env, not just the binding: the route reads the token and
      // the sending address too (src/email-send.js handleSendEmailRequest).
      return handleSendEmailRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  },

  // The nightly reconciler (build-spec.md piece 6, drive issue #18):
  // `reconcileIndex` walks the store once and rebuilds the index rows, so an
  // event the write path missed is corrected within a day. One schedule, one
  // account, keyed by schedule: the run is invoked and cannot be started by a
  // browser request, which a route on /api/search/index would have allowed.
  // One drive until the accounts table lands (src/files.js resolveAccount's
  // swap point, #5); when it does, this loop widens to the accounts that
  // have rows.
  async scheduled(event, env, context) {
    context.waitUntil(
      reconcileIndex(env.WAITLIST_DB, storeFor(env), resolveAccount()).catch(
        (error) => {
          throw new Error(`the nightly reindex failed: ${error.message}`);
        },
      ),
    );
  },
};
