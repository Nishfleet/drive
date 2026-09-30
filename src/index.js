import { handleWaitlistRequest } from "./waitlist.js";
import { handleFirstRunStatusRequest, signedInAccount, STATUS_ENDPOINT } from "./status.js";
import {
  FILES_ENDPOINT,
  createMemoryStore,
  createS3Store,
  handleFilesRequest,
} from "./files.js";
import { USAGE_ENDPOINT, handleUsageRequest } from "./billing.js";
import { handleSendEmailRequest } from "./email-send.js";

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
    // (issue #45), so an anonymous poll gets 401 and no device data. The path
    // is the module's own constant, so the route and the page cannot drift.
    if (
      url.pathname === STATUS_ENDPOINT ||
      url.pathname === `${STATUS_ENDPOINT}/`
    ) {
      return handleFirstRunStatusRequest(request, signedInAccount(request));
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
      // signed-in callers and tells a stranger nothing about itself.
      const account = signedInAccount(request);
      return handleFilesRequest(request, account ? storeFor(env) : null, account);
    }
    // The usage page's and the CLI's read of the month's money (issues #7 and
    // #53, build step 6). Same rule: the branch comes before the asset
    // fallthrough, and the account gate is what keeps one account's numbers
    // from being shown to another (issue #73).
    if (
      url.pathname === USAGE_ENDPOINT ||
      url.pathname === `${USAGE_ENDPOINT}/`
    ) {
      return handleUsageRequest(request, signedInAccount(request));
    }
    if (url.pathname === SEND_EMAIL_PATH) {
      // The whole env, not just the binding: the route reads the token and
      // the sending address too (src/email-send.js handleSendEmailRequest).
      return handleSendEmailRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
