import { handleWaitlistRequest } from "./waitlist.js";
import { handleFirstRunStatusRequest } from "./status.js";

// Static assets serve the pricing page and the first-run page; only /api/*
// reaches this Worker (see runWorkerFirst in cloudflare.config.ts). Anything
// that does reach it and is not an API falls through to the assets, so a
// stray path is a real 404 from the asset worker rather than a hand-rolled
// page.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/waitlist" || url.pathname === "/api/waitlist/") {
      return handleWaitlistRequest(request, env.WAITLIST_DB);
    }
    // The first-run page's live flip (issue #32). Handled before the assets
    // because runWorkerFirst only covers /api/*.
    if (
      url.pathname === "/api/first-run-status" ||
      url.pathname === "/api/first-run-status/"
    ) {
      return handleFirstRunStatusRequest(request);
    }
    return env.ASSETS.fetch(request);
  },
};
