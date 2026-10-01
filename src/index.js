import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { trimTrailingSlash } from "hono/trailing-slash";
import { methodNotAllowed } from "hono/method-not-allowed";
import { secureHeaders } from "hono/secure-headers";
import { csrf } from "hono/csrf";

import { handleWaitlistRequest } from "./waitlist.js";
import {
  handleFirstRunStatusRequest,
  signedInAccount,
  STATUS_ENDPOINT,
  unauthorizedResponse,
} from "./status.js";
import {
  FILES_ENDPOINT,
  createMemoryStore,
  createS3Store,
  handleFilesRequest,
} from "./files.js";
import { USAGE_ENDPOINT, handleUsageRequest } from "./billing.js";
import { handleSendEmailRequest } from "./email-send.js";
import { HEALTH_PATH, handleHealthRequest } from "./health.js";
import { failureMessage } from "./messages.js";

// Public routes: reachable without a signed-in account. Every other
// /api/ route is account-gated by default (deny-by-default).
export const PUBLIC_ROUTES = Object.freeze(["/api/waitlist", "/api/emails/send", HEALTH_PATH]);

function isPublic(pathname) {
  const clean = pathname.replace(/\/+$/, "") || "/";
  return PUBLIC_ROUTES.some(
    (p) => clean === p || clean.startsWith(p + "/"),
  );
}

// One store per Worker isolate, holding every account's files under its
// own prefix. With no storage configured the in-memory store holds what the
// page uploaded this run, so the Web Files page is real in dev and in the
// tests; FILES_S3_ENDPOINT and FILES_S3_BUCKET point the same handlers at
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

/**
 * Create the Hono app. All route logic lives here so the Worker export
 * is a thin shim and the app can be tested in isolation.
 * @param {{ASSETS: {fetch: Function}, [key: string]: any}} env
 */
export function createApp(env) {
  const app = new Hono({ strict: false });

  // Trailing slashes handled by the library (redirects to canonical).
  app.use(trimTrailingSlash());

  // Secure headers on every response (X-Content-Type-Options, X-Frame-Options, etc.).
  app.use("*", secureHeaders());

  // Same-origin / CSRF protection on the public state-changing endpoints,
  // using Hono's built-in middleware. The waitlist and email-send handlers
  // keep their own isSameOriginRequest checks as defence-in-depth.
  app.use("/api/waitlist", csrf());
  app.use("/api/emails/send", csrf());

  // Deny-by-default auth gate on /api/*. Public routes are declared explicitly
  // in PUBLIC_ROUTES above. The gate runs before any handler, so an anonymous
  // request is answered 401 without the store being built or the handler
  // running.
  app.use("/api/*", async (c, next) => {
    if (isPublic(c.req.path)) return next();
    const account = signedInAccount(c.req.raw);
    if (!account) return unauthorizedResponse();
    c.set("account", account);
    await next();
  });

  // Account-gated routes. Each is registered by method so Hono's
  // methodNotAllowed middleware answers 405 with an Allow header; the account
  // gate above already answered an anonymous caller 401.
  app.get(STATUS_ENDPOINT, (c) =>
    handleFirstRunStatusRequest(c.req.raw, c.get("account"))
  );
  const filesHandler = (c) => {
    const account = c.get("account");
    return handleFilesRequest(
      c.req.raw,
      account ? storeFor(c.env) : null,
      account,
    );
  };
  app.get(FILES_ENDPOINT, filesHandler);
  app.post(FILES_ENDPOINT, filesHandler);
  app.get(`${FILES_ENDPOINT}/*`, filesHandler);
  app.post(`${FILES_ENDPOINT}/*`, filesHandler);
  app.get(USAGE_ENDPOINT, (c) =>
    handleUsageRequest(c.req.raw, c.get("account"))
  );

  // Public routes
  app.post("/api/waitlist", (c) =>
    handleWaitlistRequest(c.req.raw, c.env.WAITLIST_DB, c.env.WAITLIST_RATE_LIMITER)
  );
  app.get(HEALTH_PATH, (c) => handleHealthRequest(c.req.raw, c.env));
  app.post("/api/emails/send", (c) => handleSendEmailRequest(c.req.raw, c.env));

  // Method handling, 404 and 405 from the library
  app.use("*", methodNotAllowed({ app }));
  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "Not found." }, 404);
    }
    return c.env.ASSETS.fetch(c.req.raw);
  });
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error("[pricing] request failed:", err.message, err.stack, err);
    return c.json({ error: failureMessage("unexpected") }, 500);
  });

  return app;
}

export default {
  async fetch(request, env) {
    return createApp(env).fetch(request, env);
  },
};