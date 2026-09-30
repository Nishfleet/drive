import { handleWaitlistRequest } from "./waitlist.js";

// Static assets serve the pricing page; only /api/* reaches this Worker (see
// runWorkerFirst in cloudflare.config.ts). Anything that does reach it and is
// not the waitlist API falls through to the assets, so a stray path is a real
// 404 from the asset worker rather than a hand-rolled page.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/waitlist" || url.pathname === "/api/waitlist/") {
      return handleWaitlistRequest(request, env.WAITLIST_DB);
    }
    return env.ASSETS.fetch(request);
  },
};
