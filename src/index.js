import { handleWaitlistRequest } from "./waitlist.js";
import { handleFirstRunStatusRequest, signedInAccount, STATUS_ENDPOINT } from "./status.js";
import {
  FILES_ENDPOINT,
  createMemoryStore,
  createS3Store,
  handleFilesRequest,
} from "./files.js";
import { USAGE_ENDPOINT, handleUsageRequest } from "./billing.js";
import { handleSendEmailRequest, sendEmail } from "./email-send.js";
import { HEALTH_PATH, handleHealthRequest } from "./health.js";
import { SIGNIN_ENDPOINT, handleSigninRequest } from "./signin.js";
import { createAccountStore } from "./accounts.js";

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

// The account store for sign-in: one place to plug the api Worker's D1 in
// (#2), so the sign-in route never reads a binding of its own and a test can
// hand the handler a fake. One store per Worker isolate, holding the accounts,
// their one-time codes and their sessions (src/accounts.js). The real D1
// store is #2; swapping it is one factory with the same three methods.
let accountsStore;
function accountsStoreFor(env) {
  // A store passed on the env wins, and that is how a test drives the real
  // dispatch (test/account-gate.test.mjs reads the emailed code through the
  // fake EMAIL binding and the store it builds). A deployment never sets it,
  // so the one-isolate cache below is what production uses.
  if (env.ACCOUNTS_STORE) {
    return env.ACCOUNTS_STORE;
  }
  if (!accountsStore) {
    accountsStore = createAccountStore({
      // The code leaves by email through the same provider every drive email
      // uses (src/email-send.js). With no EMAIL binding the store is built
      // without a mailer, and a start that cannot be mailed is reported as
      // failed rather than as a code sent — the route reads the store's answer
      // either way, so nothing here decides what a person is told.
      sendCode: env.EMAIL
        ? async ({ to, code }) => {
            await sendEmail(env.EMAIL, {
              to,
              kind: "signin-code",
              from: env.MAIL_FROM,
              rendered: signinCodeEmail(code),
            });
          }
        : undefined,
    });
  }
  return accountsStore;
}

// The one email the sign-in code arrives in. It is rendered here rather than in
// src/emails.js because it carries a secret and that module's templates are the
// five the spec names for customers (welcome, cap, read-only, payment, receipt)
// — a secret is not one of them, and a template table that also held codes
// would be a place to leak one from.
function signinCodeEmail(code) {
  return {
    subject: `Your drive sign-in code: ${code}`,
    text: `Your drive sign-in code is ${code}. It is good for 10 minutes. If you did not ask to sign in, ignore this email.`,
    html: `<p>Your drive sign-in code is <strong>${code}</strong>.</p><p>It is good for 10 minutes. If you did not ask to sign in, ignore this email.</p>`,
  };
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
      return handleFirstRunStatusRequest(request, await signedInAccount(request, accountsStoreFor(env)));
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
      const account = await signedInAccount(request, accountsStoreFor(env));
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
      return handleUsageRequest(request, await signedInAccount(request, accountsStoreFor(env)));
    }
    // The sign-in screen's start and finish (build step 9, issue #10). The
    // account store (src/accounts.js) records the one-time code against the
    // address and, on the finish step, mints the session cookie every account
    // route above is gated on. It is registered here, ahead of the asset
    // fallthrough, because /api/signin must reach the Worker.
    if (url.pathname === SIGNIN_ENDPOINT || url.pathname === `${SIGNIN_ENDPOINT}/`) {
      return handleSigninRequest(request, accountsStoreFor(env));
    }
    if (url.pathname === SEND_EMAIL_PATH) {
      // The whole env, not just the binding: the route reads the token and
      // the sending address too (src/email-send.js handleSendEmailRequest).
      return handleSendEmailRequest(request, env);
    }
    // The health endpoint the outside monitor polls (issue #96, #36). It
    // comes before the asset fallthrough and takes the whole env because the
    // check reads the dependencies off the bindings: a trivially-read D1 on
    // each database and a fetch of the asset layer. The whole env is the
    // honest argument — a check that only saw the bindings it was told about
    // would be a check that could not fail.
    if (url.pathname === HEALTH_PATH || url.pathname === `${HEALTH_PATH}/`) {
      return handleHealthRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
