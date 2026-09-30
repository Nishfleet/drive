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
import { USAGE_ENDPOINT, handleUsageRequest, usageSummary, BILLING_CONFIG } from "./billing.js";
import {
  REQUEST_ENDPOINT,
  SHARE_ENDPOINT,
  SHARE_LINK_PREFIX,
  createMemoryLinkStore,
  handleRequestInfoRequest,
  handleRequestRequest,
  handleRequestUploadRequest,
  handleShareFileRequest,
  handleShareRequest,
} from "./share.js";
import { handleSendEmailRequest } from "./email-send.js";

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

// One link store per Worker isolate, the same stand-in shape storeFor() uses
// for files: the in-memory LinkStore stands in until the accounts store lands
// (#55), where the shares and upload_requests rows move to D1 behind the same
// interface (src/share.js). Sharing the FileStore above is what makes a file
// dropped through an upload page appear on the owner's drive at its next
// listing.
let linksStore;
function linksFor() {
  if (!linksStore) {
    linksStore = createMemoryLinkStore();
  }
  return linksStore;
}

// The owner's spending-cap state for the public upload routes, read from the
// same src/billing.js summary the usage page shows. Until the accounts store
// and the meter land (#6, #55) an account has no usage rows, so this is the
// empty month the usage endpoint already answers with — the honest cap for a
// drive with nothing stored. One swap point.
function capStateFor() {
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
    if (
      url.pathname === FILES_ENDPOINT ||
      url.pathname === `${FILES_ENDPOINT}/` ||
      url.pathname.startsWith(`${FILES_ENDPOINT}/`)
    ) {
      return handleFilesRequest(request, storeFor(env), resolveAccount(request));
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
    // Share links and upload requests (issue #19). The share/request routes
    // are the owner's side (the same stand-in account /api/files uses until
    // the sign-in gate lands, #73); /s/<token> and the request pages are the
    // logged-out side, and they are the only routes here that serve a caller
    // who is not the owner.
    if (
      url.pathname === SHARE_ENDPOINT ||
      url.pathname === `${SHARE_ENDPOINT}/`
    ) {
      return handleShareRequest(request, storeFor(env), linksFor(), resolveAccount(request));
    }
    if (url.pathname.startsWith(`${SHARE_LINK_PREFIX}/`)) {
      return handleShareFileRequest(request, storeFor(env), linksFor());
    }
    if (
      url.pathname === REQUEST_ENDPOINT ||
      url.pathname === `${REQUEST_ENDPOINT}/`
    ) {
      return handleRequestRequest(request, storeFor(env), linksFor(), resolveAccount(request));
    }
    // The two public request routes are matched after the owner's /api/request
    // root so the exact root is never mistaken for its own child.
    if (url.pathname === `${REQUEST_ENDPOINT}/info`) {
      return handleRequestInfoRequest(request, linksFor(), capStateFor());
    }
    if (url.pathname === `${REQUEST_ENDPOINT}/upload`) {
      return handleRequestUploadRequest(request, storeFor(env), linksFor(), capStateFor());
    }
    if (url.pathname === SEND_EMAIL_PATH) {
      // The whole env, not just the binding: the route reads the token and
      // the sending address too (src/email-send.js handleSendEmailRequest).
      return handleSendEmailRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
