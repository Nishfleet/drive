import { handleWaitlistRequest } from "./waitlist.js";
import { handleFirstRunStatusRequest } from "./status.js";
import {
  FILES_ENDPOINT,
  createMemoryStore,
  createS3Store,
  handleFilesRequest,
  resolveAccount,
} from "./files.js";
import { handleUsageRequest } from "./billing.js";

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

// Static assets serve the pricing page, the first-run page and the Web Files
// page; only /api/* reaches this Worker (see runWorkerFirst in
// cloudflare.config.ts). Anything that does reach it and is not an API falls
// through to the assets, so a stray path is a real 404 from the asset worker
// rather than a hand-rolled page.
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
    if (
      url.pathname === "/api/first-run-status" ||
      url.pathname === "/api/first-run-status/"
    ) {
      return handleFirstRunStatusRequest(request);
    }
    // The Web Files page's listing, download, upload and restore (issue #31).
    if (
      url.pathname === FILES_ENDPOINT ||
      url.pathname === `${FILES_ENDPOINT}/` ||
      url.pathname.startsWith(`${FILES_ENDPOINT}/`)
    ) {
      return handleFilesRequest(request, storeFor(env), resolveAccount(request));
    }
    // The usage page's and the CLI's read of the month's money (issue #7,
    // build step 6). Same rule: the branch comes before the asset fallthrough.
    if (url.pathname === "/api/usage" || url.pathname === "/api/usage/") {
      return handleUsageRequest(request);
    }
    return env.ASSETS.fetch(request);
  },
};
