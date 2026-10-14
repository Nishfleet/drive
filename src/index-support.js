import { authFor, authForPasskey, SIGNIN_LINK_PATH, twoFactorAuthFor } from "../core/auth.js";
import { QUOTE_ENDPOINT } from "../core/billing.js";
import { capStateForAccount } from "../core/cap-request.js";
import { createD1DeviceSigninStore } from "../core/device-signin.js";
import { createD1DeviceStore } from "../core/devices.js";
import { isSameOriginRequest } from "../core/email-send.js";
import { handleFilesRequest } from "../core/files-handlers.js";
import { storageBucketForKey, storageVarsFromEnv } from "../core/files-memory.js";
import { createS3Store } from "../core/files-s3.js";
import { bearerToken, errorResponse } from "../core/http.js";
import { keyProviderFor } from "../core/keyprovider-env.js";
import { failureMessage } from "../core/messages.js";
import { fairUseUploadCheck } from "../core/meter-fair-use.js";
import { downloadRecorder } from "../core/meter-usage.js";
import { prepaidPauseOn, size30DayUnpaid } from "../core/prepaid.js";
import { fairUseRefuseOn } from "../core/pricing.js";
import { createD1QueueStore } from "../core/queues.js";
import { signedInAccount, unauthorizedResponse } from "../core/status.js";
import { BILLING_WEBHOOK_PATH } from "../core/topup.js";
import { ACCESS_SIGNIN_PATH } from "./access-signin.js";
import { createKvSnapshotStore } from "./branches.js";
import { HEALTH_PATH } from "./health.js";
import { captureError, sentrySender } from "./monitoring.js";
import { withIndex } from "./search.js";
import { REQUEST_ENDPOINT, SHARE_LINK_PREFIX } from "./share.js";
import { createD1LinkStore } from "./share-store.js";
import { SIGNIN_ENDPOINT, signinClosedBody } from "./signin.js";

/**
 * The Sentry seam for one invocation, read off the environment per
 * invocation: the DSN is a per-deployment var like the storage pair and
 * EMAIL_SEND_TOKEN, never a declared binding (a declared one is required at
 * deploy). With no DSN every call in src/monitoring.js is a safe no-op, so a
 * deployment that has not configured Sentry still runs every cron (issue
 * #520).
 *
 * Per invocation rather than per isolate, because `env` is what carries the
 * DSN and an isolate outlives one invocation. Building a sender is a DSN
 * parse and three closures.
 * @param {Env | undefined} env
 * @returns {import("./monitoring.js").Sentry}
 */
export const sentryFor = (env) =>
  sentrySender(/** @type {{SENTRY_DSN?: string} | undefined} */ (env)?.SENTRY_DSN);

export const SEND_EMAIL_PATH = "/api/emails/send";

export const API_PATH_PREFIX = "/v1";

/**
 * The per-request value Hono's context carries. `account` is resolved once by
 * the gate middleware below and read from the context by every handler, so a
 * handler cannot disagree with the gate about who is calling. It is the same
 * shape core/status.js `signedInAccount` returns and every handler's own
 * `account` parameter takes, so the gate's answer needs no narrowing where it
 * is handed on.
 * @typedef {{account: {id: string, name: string, email: string|null}|null}} DriveVariables
 */

/**
 * The app's own type: the Worker's generated `Env` as Hono's bindings (so
 * `c.env` is `Env`, not `unknown`) and the context value above as its
 * variables (so `c.get("account")` is typed rather than a key the library has
 * never heard of). Typed once here and reused by every handler's annotation,
 * the same way workers/api/src/index.js types its dispatcher.
 * @typedef {import("hono").Hono<{Bindings: Env, Variables: DriveVariables}>} DriveApp
 */

/**
 * The Hono context every route handler and middleware on this app receives.
 * @typedef {import("hono").Context<{Bindings: Env, Variables: DriveVariables}>} DriveContext
 */

export const AUTH_FAMILY = "/api/auth/*";

export const PUBLIC_ROUTES = Object.freeze([
  "/api/waitlist",
  "/api/storage-events",
  AUTH_FAMILY,
  SEND_EMAIL_PATH,
  HEALTH_PATH,
  SIGNIN_ENDPOINT,
  SIGNIN_LINK_PATH,
  ACCESS_SIGNIN_PATH,
  `${SHARE_LINK_PREFIX}/*`,
  `${REQUEST_ENDPOINT}/info`,
  `${REQUEST_ENDPOINT}/upload`,
  QUOTE_ENDPOINT,
  BILLING_WEBHOOK_PATH,
]);

/**
 * The Dodo settings this Worker reads, none of them declared bindings: each is
 * unset until Nish sets the live account up (#325), and every route that needs
 * one answers a closed door without it. DODO_FETCH is the tests' recorder.
 * @param {Env} env
 */
export function dodoEnv(env) {
  return /** @type {{DODO_PAYMENTS_API_KEY?: string, DODO_BASE_URL?: string, DODO_TOPUP_PRODUCT_ID?: string, DODO_WEBHOOK_SECRET?: string, DODO_FETCH?: typeof fetch, MAIL_FROM?: string, PREPAID_PAUSE?: string, FAIR_USE_REFUSE?: string}} */ (
    /** @type {unknown} */ (env)
  );
}

/** @param {string} pathname */
function isPublic(pathname) {
  const clean = pathname.replace(/\/+$/, "") || "/";
  return PUBLIC_ROUTES.some((p) => {
    const route = p.endsWith("/*") ? p.slice(0, -2) : p;
    return clean === route || clean.startsWith(`${route}/`);
  });
}

export const TEST_FILES_STORE = Symbol("drive.testFilesStore");
/** @type {import("../core/files.js").FileStore|undefined} */
let filesStore;
const missingFilesStoreLogged = new WeakSet();
/**
 * Storage config vars. They are set per deployment, never declared as
 * bindings in cloudflare.config.ts: a declared secret is required at deploy,
 * and a deployment with none of them answers 503 rather than an in-memory
 * store (drive#505). The names match the api Worker's iDrive pair so the site
 * Worker can read the buckets a minted key writes to, plus the older
 * FILES_S3_* stand-in pair a local `rclone serve s3` still uses. The typedef's
 * one definition is core/files.js's, beside the one reader of the vars.
 * @typedef {import("../core/files-memory.js").StorageEnv} StorageEnv
 * @param {Env} env
 * @returns {StorageEnv}
 */
function devStorage(env) {
  return /** @type {StorageEnv} */ (env);
}

/**
 * The close handlers' dependencies, or null when this deployment has no
 * customer database or no storage endpoint. A missing database or store is a
 * 503 from the route, not an in-memory close that would vanish on the next
 * isolate (drive#505).
 * @param {Env} env
 */
export function closeDepsFor(env) {
  if (!env.DRIVE_DB) {
    return null;
  }
  const store = storeFor(env);
  if (!store) {
    return null;
  }
  const secrets = /** @type {Env & {MAIL_FROM?: string}} */ (env);
  return {
    devices: createD1DeviceStore(env.DRIVE_DB, {
      keyProvider: keyProviderFor(env) ?? undefined,
    }),
    store,
    email: env.EMAIL,
    mailFrom: secrets.MAIL_FROM ?? "",
    now: () => Date.now(),
  };
}

/**
 * The prepaid key swap's live deps (drive#589): the same D1 device store the
 * cap walk uses, so a $0 pause hits the same rows. Missing DRIVE_DB is null,
 * and the callers skip the swap rather than inventing an in-memory store.
 * @param {Env} env
 * @returns {{pauseOn: boolean, devices: ReturnType<typeof createD1DeviceStore>}|null}
 */
export function prepaidPauseFromEnv(env) {
  if (!env.DRIVE_DB) {
    return null;
  }
  return {
    pauseOn: prepaidPauseOn(env),
    devices: createD1DeviceStore(env.DRIVE_DB, {
      keyProvider: keyProviderFor(env) ?? undefined,
    }),
  };
}

/**
 * The api Worker's service binding (drive#156/#341, #342), declared as `API`
 * in cloudflare.config.ts. The deploy ships drive-api before this Worker,
 * because Cloudflare fails a deploy against a service binding whose target
 * does not exist. It is still read as optional here, so an env without it (a
 * test, a local run) answers the /v1/* closed door rather than throwing.
 * @param {Env} env
 * @returns {Env & {API?: Fetcher}}
 */
function apiBinding(env) {
  return /** @type {Env & {API?: Fetcher}} */ (env);
}

/**
 * The forward to the api Worker over the service binding, shared by the two
 * routes this Worker forwards: the /v1/* family and the one /api/* route
 * registered ahead of the account gate. The request goes over unchanged —
 * method, path, query, headers and body — and the api Worker's own dispatcher
 * answers it with its own gate, its own edge limits and its own words.
 * Nothing either family serves is re-implemented on this side.
 *
 * A deployment with no binding is the closed door, not an open one: the api
 * Worker is a separate deployable that no deploy has shipped yet (its deploy
 * step is the one line the worker App's token cannot push), and a declared
 * binding to a Worker that does not exist fails this Worker's own deploy. So
 * until drive-api is deployed and the binding is declared, both routes say so
 * in the message table's words rather than falling through to the asset layer
 * and serving a 404 page to a CLI mid sign-in.
 * @param {DriveContext} c
 * @returns {Response | Promise<Response>}
 */
export function forwardToApi(c) {
  const api = apiBinding(c.env).API;
  if (!api) return errorResponse(503, failureMessage("unexpected"));
  return api.fetch(c.req.raw);
}

/**
 * @param {Env} env
 * @returns {import("../core/files.js").FileStore | null}
 */
export function storeFor(env) {
  const injected =
    /** @type {{[key: symbol]: import("../core/files.js").FileStore | undefined}} */ (env)[
      TEST_FILES_STORE
    ];
  if (injected) {
    return injected;
  }
  if (!filesStore) {
    const { endpoint, accessKeyId, secretAccessKey, region } = storageVarsFromEnv(devStorage(env));
    if (!endpoint) {
      if (!missingFilesStoreLogged.has(env)) {
        missingFilesStoreLogged.add(env);
        console.error("files: no storage endpoint is set, so this deployment cannot serve files");
      }
      return null;
    }
    const signed =
      accessKeyId !== undefined && secretAccessKey !== undefined && region !== undefined;
    filesStore = createS3Store({
      endpoint,
      bucketFor: storageBucketForKey,
      ...(signed
        ? {
            region,
            credentials: {
              accessKeyId: /** @type {string} */ (accessKeyId),
              secretAccessKey: /** @type {string} */ (secretAccessKey),
            },
          }
        : {}),
    });
  }
  return filesStore;
}

/**
 * Run a files-backed route, or answer 503 when this deployment has no store.
 * @param {DriveContext} c
 * @param {(store: import("../core/files.js").FileStore) => Response | Promise<Response>} run
 */
export function withFileStore(c, run) {
  const store = storeFor(c.env);
  if (!store) {
    return c.json({ error: failureMessage("drive-not-configured") }, 503);
  }
  return run(store);
}

/**
 * @param {Env} env
 * @returns {import("./share.js").LinkStore}
 */
export function linksFor(env) {
  return createD1LinkStore(env.DRIVE_DB);
}

// D1 caps a row at 1 MiB (https://developers.cloudflare.com/d1/platform/limits/).
/**
 * @param {Env} env
 * @returns {import("./branches.js").SnapshotStore|null}
 */
export function snapshotsFor(env) {
  const kv = env.BRANCH_SNAPSHOTS;
  return kv ? createKvSnapshotStore(kv) : null;
}

/**
 * @param {Env} env
 * @param {{id: string}} account
 * @returns {Promise<import("../core/queues.js").UploadQueue|null>}
 */
export async function liveQueueFor(env, account) {
  if (!env.DRIVE_DB) {
    return null;
  }
  return createD1QueueStore(env.DRIVE_DB).latest(account.id);
}

/**
 * @param {Env} env
 * @param {{id: string}} account
 * @returns {Promise<Array<{id: string, name: string, kind: string, lastSeenAt: number|null}>>}
 */
export async function liveDevicesFor(env, account) {
  if (!env.DRIVE_DB) {
    return [];
  }
  return createD1DeviceStore(env.DRIVE_DB).listLive(account);
}

/**
 * The resolver the public upload-request links ask about the account that owns
 * the link (`capStateForAccount`, src/cap.js, drive#496). It is bound to the
 * environment because the cap is in D1, so the answer for one deployment's
 * account has to come from that deployment's rows and not from a module-level
 * constant.
 *
 * Before the meter, this answered the empty month for every account, so
 * "active", and a public upload link never stopped at its owner's cap. It now
 * reads the account's own cap and the metered month the invoice reads, which
 * is what makes the 403 below a real refusal rather than a rehearsal.
 *
 * The device store is built per call rather than cached, because the
 * resolver is handed straight to the route table and a Worker isolates globals
 * across requests; a per-request store is also the only store that can be
 * built for the env a particular request carries.
 *
 * @param {Env} env
 * @returns {(accountId: string) => Promise<"active"|"read_only">}
 */
export function capStateFor(env) {
  return (accountId) => capStateForAccount(createD1DeviceStore(env.DRIVE_DB), accountId);
}

/**
 * The resolver the public upload page asks for a link owner's display name
 * (drive issue #684): the Better Auth `user` row for the account that minted
 * the link, so a stranger opening the link sees whose drive it is. It is the
 * same per-call device store `capStateFor` uses, and the same resolver feeds
 * the nightly arrival digest (`sendArrivalDigests`), so the name on the page
 * and the name in the mail come from one read.
 * @param {Env} env
 * @returns {(accountId: string) => Promise<{id: string, name: string, email: string}|null>}
 */
export function ownerFor(env) {
  return (accountId) => createD1DeviceStore(env.DRIVE_DB).accountById(accountId);
}

export async function accountGate(
  /** @type {DriveContext} */ c,
  /** @type {import("hono").Next} */ next,
) {
  if (isPublic(c.req.path)) return next();
  /** @type {DriveVariables["account"]} */
  let account = await signedInAccount(c.req.raw, authFor(c.env));
  if (!account) {
    const token = bearerToken(c.req.raw);
    if (token !== null && c.env.DRIVE_DB) {
      account = await createD1DeviceSigninStore(c.env.DRIVE_DB).accountForDeviceToken(token);
    }
  }
  if (!account) return unauthorizedResponse();
  c.set("account", account);
  await next();
}

const CSRF_EXEMPT_PATHS = new Set(["/api/waitlist", SEND_EMAIL_PATH]);
/**
 * Same-origin CSRF on every write except the two public POSTs that keep
 * their own handler copies.
 * @type {import("hono").MiddlewareHandler<{Bindings: Env, Variables: DriveVariables}>}
 */
export const csrfWhenBrowser = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
    return next();
  }
  const path = c.req.path.replace(/\/+$/, "") || "/";
  if (CSRF_EXEMPT_PATHS.has(path)) return next();
  if (!isSameOriginRequest(c.req.raw)) {
    return c.json({ error: failureMessage("cross-site") }, 403);
  }
  return next();
};

const PASSKEY_AUTH_PATH = /^\/api\/auth\/passkey\/[a-z-]+\/?$/;
const AUTH_FAMILY_ALLOWED =
  /^\/api\/auth\/(?:get-session|two-factor\/[a-z-]+|passkey\/[a-z-]+)\/?$/;

const TWO_FACTOR_PATH = /^\/api\/auth\/two-factor\/[a-z-]+\/?$/;

export const authApiHandler = async (/** @type {DriveContext} */ c) => {
  if (!AUTH_FAMILY_ALLOWED.test(c.req.path)) {
    return c.json({ error: "Not found." }, 404);
  }
  const auth = TWO_FACTOR_PATH.test(c.req.path)
    ? await twoFactorAuthFor(c.env)
    : PASSKEY_AUTH_PATH.test(c.req.path)
      ? await authForPasskey(c.env)
      : authFor(c.env);
  if (!auth) {
    return c.json(signinClosedBody(), 503);
  }
  return auth.handler(c.req.raw);
};

/** @param {DriveContext} c */
export const filesHandler = async (c) => {
  const account = c.get("account");
  return handleFilesRequest(
    c.req.raw,
    account ? withIndex(storeFor(c.env), c.env.DRIVE_DB, account) : null,
    account,
    Date.now(),
    c.env.DRIVE_DB
      ? {
          db: c.env.DRIVE_DB,
          prepaidPause: prepaidPauseOn(c.env),
          size30DayUnpaid: (accountId, extraBytes) =>
            size30DayUnpaid(c.env.DRIVE_DB, accountId, extraBytes),
          accountState: createD1DeviceStore(c.env.DRIVE_DB).accountState,
          recordDownload: downloadRecorder(c.env.DRIVE_DB),
          ...fairUseUploadOptions(c.env),
        }
      : { prepaidPause: prepaidPauseOn(c.env) },
  );
};

/**
 * The fair-use upload check (drive#364): one snapshot, one check, record every
 * decision, mail a would-refuse at most once per 30 days. A throw fails open
 * and is reported, so a missing meter never pauses an upload by guesswork.
 * @param {Env} env
 */
export function fairUseUploadOptions(env) {
  const db = env.DRIVE_DB;
  if (!db) {
    return {};
  }
  const refuse = fairUseRefuseOn(env);
  const secrets = dodoEnv(env);
  return {
    fairUseRefuse: refuse,
    onFairUseError: (/** @type {unknown} */ error) =>
      captureError(error, "fair-use snapshot", sentryFor(env)),
    fairUseForUpload: fairUseUploadCheck(db, {
      refuse,
      onError: (/** @type {unknown} */ error, /** @type {string} */ where) =>
        captureError(error, where, sentryFor(env)),
      email: env.EMAIL,
      from: secrets.MAIL_FROM ?? "",
    }),
  };
}
