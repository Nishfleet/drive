import { handleWaitlistRequest } from "./waitlist.js";
import { handleFirstRunStatusRequest } from "./status.js";
import { handleUsageRequest } from "./billing.js";
import { handleSendEmailRequest } from "./email-send.js";

// The path the meter, the billing webhook and the tests post a drive email to
// (src/email-send.js). One route, so one place knows the provider.
const SEND_EMAIL_PATH = "/api/emails/send";

// Static assets serve the pricing page and the first-run page; only /api/*
// reaches this Worker (see runWorkerFirst in cloudflare.config.ts). Anything
// that does reach it and is not an API falls through to the assets, so a
// stray path is a real 404 from the asset worker rather than a hand-rolled
// page.
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
    if (
      url.pathname === "/api/first-run-status" ||
      url.pathname === "/api/first-run-status/"
    ) {
      return handleFirstRunStatusRequest(request);
    }
    // The usage page's and the CLI's read of the month's money (issue #7,
    // build step 6). Same rule: the branch comes before the asset fallthrough.
    if (url.pathname === "/api/usage" || url.pathname === "/api/usage/") {
      return handleUsageRequest(request);
    }
    if (url.pathname === SEND_EMAIL_PATH) {
      // The whole env, not just the binding: the route reads the token and
      // the sending address too (src/email-send.js handleSendEmailRequest).
      return handleSendEmailRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
