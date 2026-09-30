import { handleWaitlistRequest } from "./waitlist.js";
import { handleFirstRunStatusRequest } from "./status.js";
import { handleStorageEventRequest, runMeterCron } from "./meter.js";

// Static assets serve the pricing page and the first-run page; only /api/*
// reaches this Worker (see runWorkerFirst in cloudflare.config.ts). Anything
// that does reach it and is not an API falls through to the assets, so a
// stray path is a real 404 from the asset worker rather than a hand-rolled
// page.
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
    // The meter's event intake (issue #6). The storage provider's webhook
    // lands here; the dedup in src/meter.js makes the provider's own retries
    // safe, so no rate limiter is bound to this path.
    if (
      url.pathname === "/api/storage-events" ||
      url.pathname === "/api/storage-events/"
    ) {
      return handleStorageEventRequest(request, env.METER_DB);
    }
    // The first-run page's live flip (issue #32). runWorkerFirst sends every
    // /api/* here; the branch just has to come before the asset fallthrough.
    if (
      url.pathname === "/api/first-run-status" ||
      url.pathname === "/api/first-run-status/"
    ) {
      return handleFirstRunStatusRequest(request);
    }
    return env.ASSETS.fetch(request);
  },

  // The hourly meter (issue #6): roll the UTC hour that just closed into
  // usage_minutes, one row per account. A D1 failure throws, so Cloudflare
  // records the trigger as failed and retries; a failed rollup must never
  // read as a quiet zero. The schedule string lives in cloudflare.config.ts,
  // pinned to src/meter.js's METER_CRON by test/meter.test.mjs.
  async scheduled(controller, env) {
    return runMeterCron(env.METER_DB, controller.scheduledTime);
  },
};
