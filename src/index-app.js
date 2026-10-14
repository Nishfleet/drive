import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { methodNotAllowed } from "hono/method-not-allowed";
import { secureHeaders } from "hono/secure-headers";
import { trimTrailingSlash } from "hono/trailing-slash";
import { SIGNIN_LINK_PATH } from "../core/auth.js";
import { BILLING_CONFIG, QUOTE_ENDPOINT, USAGE_ENDPOINT } from "../core/billing.js";
import { handleQuoteRequest, handleUsageRequest } from "../core/billing-report.js";
import { CAP_ENDPOINT, handleCapRequest } from "../core/cap-request.js";
import { createD1DeviceStore } from "../core/devices.js";
import { handleSendEmailRequest } from "../core/email-send.js";
import { EXPORT_ENDPOINT, exportRoute } from "../core/export.js";
import { FILES_ENDPOINT } from "../core/files.js";
import { provisionAccountBucket } from "../core/files-memory.js";
import { scopeStore } from "../core/files-scope.js";
import { HISTORY_ENDPOINT, handleHistoryRequest } from "../core/history-addon.js";
import { keyProviderFor } from "../core/keyprovider-env.js";
import { balanceCents } from "../core/ledger.js";
import { failureMessage } from "../core/messages.js";
import { handleStorageEventRequest } from "../core/meter-events.js";
import { fairUseSnapshot } from "../core/meter-fair-use.js";
import { downloadRecorder, monthStart } from "../core/meter-usage.js";
import {
  AUTO_TOPUP_ENDPOINT,
  handleAutoTopUpRequest,
  prepaidPauseOn,
  size30DayUnpaid,
} from "../core/prepaid.js";
import { pauseAccountKeys } from "../core/prepaid-pause.js";
import { handleReceiptRequest, RECEIPT_ENDPOINT } from "../core/receipts.js";
import { mailFromEnv, sessionLabel } from "../core/security-event.js";
import {
  handleFirstRunStatusRequest,
  STATUS_ENDPOINT,
  unauthorizedResponse,
} from "../core/status.js";
import {
  BALANCE_ENDPOINT,
  BILLING_WEBHOOK_PATH,
  balanceLine,
  handleBalanceRequest,
  handleBillingWebhook,
  handleTopUpRequest,
  TOPUP_ENDPOINT,
} from "../core/topup.js";
import { handleUnsubscribe, UNSUBSCRIBE_PATH } from "../core/unsubscribe.js";
import { handleWebhookRequest, WEBHOOK_ENDPOINT } from "../core/webhook-routes.js";
import { ACCESS_SIGNIN_PATH, handleAccessSignin } from "./access-signin.js";
import {
  CLOSE_CANCEL_ENDPOINT,
  CLOSE_ENDPOINT,
  handleCloseCancelRequest,
  handleCloseRequest,
  handleCloseStatusRequest,
} from "./account-close.js";
import { branchJobsQueue } from "./branch-jobs.js";
import { BRANCHES_ENDPOINT } from "./branches.js";
import { handleBranchesRequest } from "./branches-routes.js";
import { DEVICES_ENDPOINT, handleDevicesRequest } from "./devices-page.js";
import { HEALTH_PATH, handleHealthRequest } from "./health.js";
import {
  API_PATH_PREFIX,
  AUTH_FAMILY,
  accountGate,
  authApiHandler,
  capStateFor,
  closeDepsFor,
  csrfWhenBrowser,
  dodoEnv,
  fairUseUploadOptions,
  filesHandler,
  forwardToApi,
  linksFor,
  liveDevicesFor,
  liveQueueFor,
  ownerFor,
  prepaidPauseFromEnv,
  SEND_EMAIL_PATH,
  sentryFor,
  snapshotsFor,
  storeFor,
  withFileStore,
} from "./index-support.js";
import { captureError } from "./monitoring.js";
import { handlePortalRequest, PORTAL_ENDPOINT } from "./portal.js";
import { handleRewindRequest, REWIND_ENDPOINT } from "./rewind.js";
import { handleSearchRequest, SEARCH_ENDPOINT } from "./search.js";
import { REQUEST_ENDPOINT, SHARE_ENDPOINT, SHARE_LINK_PREFIX } from "./share.js";
import { handleShareLinkVisit } from "./share-page.js";
import {
  handleRequestInfoRequest,
  handleRequestRequest,
  handleShareRequest,
} from "./share-routes.js";
import { handleRequestUploadRequest } from "./share-upload.js";
import { handleSigninLinkVerify, handleSigninRequest, SIGNIN_ENDPOINT } from "./signin.js";
import { handleStarterRequest, STARTER_ENDPOINT } from "./starter.js";
import { handleWaitlistRequest } from "./waitlist.js";

/** @typedef {import("./index.js").DriveApp} DriveApp */
/** @typedef {import("./index.js").DriveContext} DriveContext */

/**
 * Create the Hono app. All route logic lives here so the Worker export is a
 * thin shim and the app — including its route table — can be walked in tests.
 *
 * It takes no env and closes over no request: every handler reads its
 * bindings from Hono's own `c.env`, which the platform's `fetch(request, env)`
 * fills in. So one app is a pure route table that any env can be run against
 * — which is what lets the account-gate walk in test/account-gate.test.mjs
 * build it and read the real registry without a deployment behind it.
 * @returns {DriveApp}
 */
export function createApp() {
  /** @type {DriveApp} */
  const app = new Hono({ strict: false });

  app.use(trimTrailingSlash());

  app.use("*", secureHeaders());

  app.all("/api/keys/revoke", forwardToApi);

  app.use("/api/*", accountGate);

  app.use("/api/*", csrfWhenBrowser);

  app.on(["GET", "POST"], AUTH_FAMILY, authApiHandler);

  app.all("/v1/*", forwardToApi);

  app.get(STATUS_ENDPOINT, async (c) => {
    const account = c.get("account");
    const [upload, devices] = await Promise.all([
      account ? liveQueueFor(c.env, account) : null,
      account ? liveDevicesFor(c.env, account) : [],
    ]);
    return handleFirstRunStatusRequest(c.req.raw, account, upload, devices);
  });

  app.get(`${SEARCH_ENDPOINT}/*`, (c) => {
    const p = c.req.path;
    if (p !== SEARCH_ENDPOINT && p !== `${SEARCH_ENDPOINT}/`) {
      return c.env.ASSETS.fetch(c.req.raw);
    }
    return handleSearchRequest(c.req.raw, c.env.DRIVE_DB, c.get("account"));
  });

  app.get(FILES_ENDPOINT, filesHandler);
  app.post(FILES_ENDPOINT, filesHandler);
  app.get(`${FILES_ENDPOINT}/*`, filesHandler);
  app.post(`${FILES_ENDPOINT}/*`, filesHandler);

  /** @param {DriveContext} c */
  const starterHandler = (c) => {
    const account = c.get("account");
    if (!account) {
      return handleStarterRequest(c.req.raw, null, account);
    }
    return withFileStore(c, (store) =>
      handleStarterRequest(c.req.raw, scopeStore(store, account), account),
    );
  };
  app.get(STARTER_ENDPOINT, starterHandler);
  app.post(STARTER_ENDPOINT, starterHandler);

  /** @param {DriveContext} c */
  const branchesHandler = (c) =>
    handleBranchesRequest(
      c.req.raw,
      c.env.DRIVE_DB,
      snapshotsFor(c.env),
      storeFor(c.env),
      c.get("account"),
      {
        now: () => Date.now(),
        queue: branchJobsQueue(c.env),
        ipLimiter: c.env.BRANCH_RATE_LIMITER,
      },
    );
  app.get(BRANCHES_ENDPOINT, branchesHandler);
  app.post(BRANCHES_ENDPOINT, branchesHandler);
  app.get(`${BRANCHES_ENDPOINT}/*`, branchesHandler);
  app.post(`${BRANCHES_ENDPOINT}/*`, branchesHandler);

  /** @param {DriveContext} c */
  const rewindHandler = (c) =>
    handleRewindRequest(
      c.req.raw,
      c.env.DRIVE_DB,
      snapshotsFor(c.env),
      storeFor(c.env),
      c.get("account"),
      () => Date.now(),
      branchJobsQueue(c.env),
    );
  app.get(REWIND_ENDPOINT, rewindHandler);
  app.post(REWIND_ENDPOINT, rewindHandler);
  app.get(`${REWIND_ENDPOINT}/*`, rewindHandler);
  app.post(`${REWIND_ENDPOINT}/*`, rewindHandler);

  app.get(USAGE_ENDPOINT, async (c) => {
    const account = c.get("account");
    /** @type {number} */
    let capUsd = BILLING_CONFIG.defaultCapUsd;
    let cardOnFile = false;
    /** @type {Record<string, unknown>|null} */
    let usage = null;
    if (!account) return unauthorizedResponse();
    let openPublicLinks = 0;
    if (c.env.DRIVE_DB) {
      const store = createD1DeviceStore(c.env.DRIVE_DB);
      capUsd = await store.getCapUsd(account.id);
      cardOnFile = await store.cardAdded(account.id);
      usage = /** @type {Record<string, unknown>} */ (
        await store.monthUsage(account.id, { capUsd })
      );
      const now = Date.now();
      const links = linksFor(c.env);
      openPublicLinks =
        (await links.shares.countOpen(account.id, now)) +
        (await links.requests.countOpen(account.id, now));
    }
    const balance = c.env.DRIVE_DB
      ? balanceLine(await balanceCents(c.env.DRIVE_DB, account.id), {
          pauseOn: prepaidPauseOn(c.env),
        })
      : null;
    /** @type {Awaited<ReturnType<typeof fairUseSnapshot>>|undefined} */
    let fairUse;
    if (c.env.DRIVE_DB) {
      try {
        fairUse = await fairUseSnapshot(c.env.DRIVE_DB, account.id);
      } catch (error) {
        await captureError(error, "fair-use snapshot", sentryFor(c.env));
      }
    }
    return handleUsageRequest(
      c.req.raw,
      { ...account, capUsd, cardOnFile, usage, fairUse, openPublicLinks },
      await liveQueueFor(c.env, account),
      balance,
      new Date(monthStart(Date.now())).toISOString(),
    );
  });

  app.get(EXPORT_ENDPOINT, (c) => {
    const account = c.get("account");
    if (!account) return unauthorizedResponse();
    const db = c.env.DRIVE_DB;
    return exportRoute(c.req.raw, {
      store: {
        listKeys: (acct) => (db ? createD1DeviceStore(db).listPublic(acct) : Promise.resolve([])),
      },
      db: db ?? null,
      account,
      now: Date.now,
      url: new URL(c.req.url),
    });
  });

  app.get(BALANCE_ENDPOINT, async (c) => {
    const account = c.get("account");
    let size30Bytes;
    if (account && c.env.DRIVE_DB) {
      try {
        const store = createD1DeviceStore(c.env.DRIVE_DB);
        const month = /** @type {Record<string, unknown>} */ (
          await store.monthUsage(account.id, { capUsd: await store.getCapUsd(account.id) })
        );
        size30Bytes = month.size30Bytes;
      } catch (error) {
        await captureError(error, "balance runway", sentryFor(c.env));
      }
    }
    return handleBalanceRequest(c.req.raw, account, c.env.DRIVE_DB, {
      pauseOn: prepaidPauseOn(c.env),
      size30Bytes,
    });
  });
  app.get(HISTORY_ENDPOINT, async (c) => {
    const account = c.get("account");
    let size30Bytes = 0;
    if (account && c.env.DRIVE_DB) {
      try {
        const store = createD1DeviceStore(c.env.DRIVE_DB);
        const month = /** @type {Record<string, unknown>} */ (
          await store.monthUsage(account.id, { capUsd: await store.getCapUsd(account.id) })
        );
        size30Bytes = Number(month.size30Bytes ?? 0);
      } catch {}
    }
    return handleHistoryRequest(c.req.raw, account, c.env.DRIVE_DB, { size30Bytes });
  });
  app.post(HISTORY_ENDPOINT, (c) => {
    const account = c.get("account");
    return handleHistoryRequest(c.req.raw, account, c.env.DRIVE_DB, {
      apply: async (days) =>
        account ? provisionAccountBucket(c.env, account.id, { hiddenVersionDays: days }) : false,
    });
  });
  app.get(WEBHOOK_ENDPOINT, (c) =>
    handleWebhookRequest(c.req.raw, c.get("account"), c.env.DRIVE_DB),
  );
  app.post(WEBHOOK_ENDPOINT, (c) =>
    handleWebhookRequest(c.req.raw, c.get("account"), c.env.DRIVE_DB),
  );
  app.delete(`${WEBHOOK_ENDPOINT}/:id`, (c) =>
    handleWebhookRequest(c.req.raw, c.get("account"), c.env.DRIVE_DB, { id: c.req.param("id") }),
  );
  app.post(`${WEBHOOK_ENDPOINT}/:id/test`, (c) =>
    handleWebhookRequest(c.req.raw, c.get("account"), c.env.DRIVE_DB, {
      id: c.req.param("id"),
      action: "test",
    }),
  );
  app.get(`${WEBHOOK_ENDPOINT}/:id/deliveries`, (c) =>
    handleWebhookRequest(c.req.raw, c.get("account"), c.env.DRIVE_DB, {
      id: c.req.param("id"),
      action: "deliveries",
    }),
  );
  app.get(`${RECEIPT_ENDPOINT}/:id`, (c) =>
    handleReceiptRequest(c.req.raw, c.get("account"), c.env.DRIVE_DB, c.req.param("id")),
  );
  app.post(AUTO_TOPUP_ENDPOINT, (c) =>
    handleAutoTopUpRequest(c.req.raw, c.get("account"), c.env.DRIVE_DB),
  );
  app.post(TOPUP_ENDPOINT, (c) => {
    const dodo = dodoEnv(c.env);
    return handleTopUpRequest(c.req.raw, c.get("account"), {
      db: c.env.DRIVE_DB,
      apiKey: dodo.DODO_PAYMENTS_API_KEY,
      baseUrl: dodo.DODO_BASE_URL,
      productId: dodo.DODO_TOPUP_PRODUCT_ID,
      fetch: dodo.DODO_FETCH,
    });
  });

  app.get(PORTAL_ENDPOINT, (c) => {
    const dodo = dodoEnv(c.env);
    return handlePortalRequest(c.req.raw, c.get("account"), {
      db: c.env.DRIVE_DB,
      apiKey: dodo.DODO_PAYMENTS_API_KEY,
      baseUrl: dodo.DODO_BASE_URL,
      fetch: dodo.DODO_FETCH,
    });
  });

  /** @param {DriveContext} c */
  const devicesHandler = (c) => {
    const db = c.env.DRIVE_DB;
    const store = db
      ? createD1DeviceStore(db, { keyProvider: keyProviderFor(c.env) ?? undefined })
      : null;
    return handleDevicesRequest(c.req.raw, c.get("account"), store);
  };
  app.get(DEVICES_ENDPOINT, devicesHandler);
  app.delete(DEVICES_ENDPOINT, devicesHandler);
  app.get(`${DEVICES_ENDPOINT}/*`, devicesHandler);
  app.delete(`${DEVICES_ENDPOINT}/*`, devicesHandler);

  app.get(CAP_ENDPOINT, (c) => handleCapRequest(c.req.raw, c.get("account"), null));
  app.post(CAP_ENDPOINT, async (c) => {
    const db = c.env.DRIVE_DB;
    const store = db
      ? createD1DeviceStore(db, { keyProvider: keyProviderFor(c.env) ?? undefined })
      : null;
    const answered = await handleCapRequest(c.req.raw, c.get("account"), store, {
      ...mailFromEnv(c.env),
      deviceName: sessionLabel(c.req.raw),
    });
    const account = c.get("account");
    if (answered.ok && store && account && db) {
      await pauseAccountKeys(account.id, {
        db,
        devices: store,
        pauseOn: prepaidPauseOn(c.env),
      });
    }
    return answered;
  });

  app.get(CLOSE_ENDPOINT, async (c) => {
    const deps = closeDepsFor(c.env);
    if (!deps) {
      return c.json({ error: failureMessage("drive-not-configured") }, 503);
    }
    return handleCloseStatusRequest(c.req.raw, c.get("account"), deps);
  });
  app.post(CLOSE_ENDPOINT, async (c) => {
    const deps = closeDepsFor(c.env);
    if (!deps) {
      return c.json({ error: failureMessage("drive-not-configured") }, 503);
    }
    return handleCloseRequest(c.req.raw, c.get("account"), deps);
  });
  app.post(CLOSE_CANCEL_ENDPOINT, async (c) => {
    const deps = closeDepsFor(c.env);
    if (!deps) {
      return c.json({ error: failureMessage("drive-not-configured") }, 503);
    }
    return handleCloseCancelRequest(c.req.raw, c.get("account"), deps);
  });

  app.get(SHARE_ENDPOINT, (c) =>
    withFileStore(c, (store) =>
      handleShareRequest(c.req.raw, store, linksFor(c.env), c.get("account")),
    ),
  );
  app.post(SHARE_ENDPOINT, (c) =>
    withFileStore(c, (store) =>
      handleShareRequest(c.req.raw, store, linksFor(c.env), c.get("account"), {
        limiter: c.env.SHARE_MINT_RATE_LIMITER,
        db: c.env.DRIVE_DB,
        ...mailFromEnv(c.env),
        deviceName: sessionLabel(c.req.raw),
      }),
    ),
  );
  app.delete(SHARE_ENDPOINT, (c) =>
    withFileStore(c, (store) =>
      handleShareRequest(c.req.raw, store, linksFor(c.env), c.get("account")),
    ),
  );
  app.get(REQUEST_ENDPOINT, (c) =>
    withFileStore(c, (store) =>
      handleRequestRequest(c.req.raw, store, linksFor(c.env), c.get("account")),
    ),
  );
  app.post(REQUEST_ENDPOINT, (c) =>
    withFileStore(c, (store) =>
      handleRequestRequest(c.req.raw, store, linksFor(c.env), c.get("account"), {
        limiter: c.env.REQUEST_MINT_RATE_LIMITER,
        ...mailFromEnv(c.env),
        deviceName: sessionLabel(c.req.raw),
      }),
    ),
  );
  app.delete(REQUEST_ENDPOINT, (c) =>
    withFileStore(c, (store) =>
      handleRequestRequest(c.req.raw, store, linksFor(c.env), c.get("account")),
    ),
  );

  app.post("/api/waitlist", (c) =>
    handleWaitlistRequest(c.req.raw, c.env.WAITLIST_DB, c.env.WAITLIST_RATE_LIMITER),
  );

  app.get(QUOTE_ENDPOINT, (c) => handleQuoteRequest(c.req.raw));

  app.post("/api/storage-events", (c) =>
    handleStorageEventRequest(c.req.raw, c.env.METER_DB, c.env.METER_EVENT_TOKEN),
  );

  app.post(SIGNIN_ENDPOINT, (c) => handleSigninRequest(c.req.raw, c.env));
  app.get(SIGNIN_LINK_PATH, (c) => handleSigninLinkVerify(c.req.raw, c.env));
  app.get(ACCESS_SIGNIN_PATH, (c) => handleAccessSignin(c.req.raw, c.env));
  app.post(ACCESS_SIGNIN_PATH, (c) => handleAccessSignin(c.req.raw, c.env));

  app.get(`${SHARE_LINK_PREFIX}/*`, (c) =>
    withFileStore(c, (store) =>
      handleShareLinkVisit(c.req.raw, store, linksFor(c.env), {
        ipLimiter: c.env.SHARE_DOWNLOAD_RATE_LIMITER,
        recordDownload: downloadRecorder(c.env.DRIVE_DB),
      }),
    ),
  );
  app.get(`${REQUEST_ENDPOINT}/info`, (c) =>
    handleRequestInfoRequest(c.req.raw, linksFor(c.env), capStateFor(c.env), {
      owner: ownerFor(c.env),
    }),
  );
  app.post(`${REQUEST_ENDPOINT}/upload`, (c) =>
    withFileStore(c, (store) =>
      handleRequestUploadRequest(c.req.raw, store, linksFor(c.env), capStateFor(c.env), {
        ipLimiter: c.env.REQUEST_UPLOAD_RATE_LIMITER,
        linkLimiter: c.env.REQUEST_UPLOAD_LINK_RATE_LIMITER,
        db: c.env.DRIVE_DB,
        prepaidPause: prepaidPauseOn(c.env),
        ...fairUseUploadOptions(c.env),
        owner: ownerFor(c.env),
        ...mailFromEnv(c.env),
        size30DayUnpaid: c.env.DRIVE_DB
          ? (accountId, extraBytes) => size30DayUnpaid(c.env.DRIVE_DB, accountId, extraBytes)
          : undefined,
      }),
    ),
  );

  app.post(BILLING_WEBHOOK_PATH, (c) =>
    handleBillingWebhook(c.req.raw, {
      db: c.env.DRIVE_DB,
      secret: dodoEnv(c.env).DODO_WEBHOOK_SECRET,
      email: c.env.EMAIL,
      mailFrom: dodoEnv(c.env).MAIL_FROM ?? "",
      ...(prepaidPauseFromEnv(c.env) ?? {}),
    }),
  );

  app.get(UNSUBSCRIBE_PATH, (c) => handleUnsubscribe(c.req.raw, c.env));
  app.post(SEND_EMAIL_PATH, (c) => handleSendEmailRequest(c.req.raw, c.env));

  app.get(HEALTH_PATH, (c) => handleHealthRequest(c.req.raw, c.env));

  app.use("*", methodNotAllowed({ app }));
  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      if (c.req.path.startsWith(`${SEARCH_ENDPOINT}/`)) {
        return c.env.ASSETS.fetch(c.req.raw);
      }
      return c.json({ error: "Not found." }, 404);
    }
    return c.env.ASSETS.fetch(c.req.raw);
  });
  app.onError(async (err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    await captureError(err, `${c.req.method} ${c.req.path}`, sentryFor(c.env));
    console.error("[pricing] request failed:", err.message, err.stack, err);
    const accept = c.req.header("accept") ?? "";
    const isApiPath =
      c.req.path.startsWith("/api/") || c.req.path.startsWith(`${API_PATH_PREFIX}/`);
    if (accept.includes("text/html") && !isApiPath && c.env.ASSETS) {
      const errorUrl = new URL(c.req.url);
      errorUrl.pathname = "/500.html";
      errorUrl.search = "";
      return c.env.ASSETS.fetch(new Request(errorUrl, { headers: c.req.raw.headers }))
        .then(
          (asset) =>
            new Response(asset.body, {
              status: 500,
              headers: {
                "content-type": asset.headers.get("content-type") ?? "text/html; charset=utf-8",
                "cache-control": "no-store",
                "x-robots-tag": "noindex",
              },
            }),
        )
        .catch(() => c.json({ error: failureMessage("unexpected") }, 500));
    }
    return c.json({ error: failureMessage("unexpected") }, 500);
  });

  return app;
}
