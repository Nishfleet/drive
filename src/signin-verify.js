// The emailed sign-in link: the GET that mints the session (moved verbatim from
// src/signin.js).
import { attachPendingCardAccount } from "../core/abuse-guards.js";
import {
  AFTER_SIGNIN_COOKIE,
  AFTER_SIGNIN_PATH,
  authFor,
  safeAfterSigninPath,
  sessionAccount,
} from "../core/auth.js";
import { provisionAccountBucket } from "../core/files.js";
import { cookieHeaders, cookieValue, redirect, SIGNIN_PATH } from "./signin-link.js";
import { createWelcomeStore, sendWelcomeOnce } from "./welcome.js";

/** @typedef {import("./signin.js").SigninEnv} SigninEnv */

/**
 * Handles GET /api/signin/verify — the link a sign-in email carries.
 *
 *   GET /api/signin/verify?token=...
 *
 * The token is the whole proof, so the link needs no session: this is how a
 * person gets one. A good token mints the session, sets its cookie and
 * redirects to the drive; a spent, expired or made-up one redirects back to
 * the sign-in screen with nothing said about which, because telling a stranger
 * which of the three they hit is telling them about a mailbox they may not
 * own. The redirect rather than a JSON body is deliberate: this is a link a
 * browser follows, and a browser following it should land on files.
 *
 * This route requires no session — it is the one that mints them — so it is on
 * the public list test/account-gate.test.mjs walks, with the reason written
 * there.
 *
 * @param {Request} request
 * @param {SigninEnv} env
 * @returns {Promise<Response>}
 */
export async function handleSigninLinkVerify(request, env) {
  if (request.method !== "GET") {
    return new Response("Method not allowed. Follow the link, or post to sign in.", {
      status: 405,
      headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const auth = authFor(env);
  if (!auth) {
    return redirect(`${SIGNIN_PATH}?error=sign-in-closed`);
  }
  const token = new URL(request.url).searchParams.get("token");
  if (token === null || token === "") {
    return redirect(`${SIGNIN_PATH}?error=no-token`);
  }
  let verified;
  try {
    verified = await auth.api.magicLinkVerify({
      query: { token },
      headers: request.headers,
      asResponse: true,
    });
  } catch {
    return redirect(`${SIGNIN_PATH}?error=invalid-link`);
  }
  if (verified.status !== 200) {
    return redirect(`${SIGNIN_PATH}?error=invalid-link`);
  }
  const driveDb = env.DRIVE_DB;
  if (
    driveDb !== undefined &&
    driveDb !== null &&
    typeof driveDb === "object" &&
    "prepare" in driveDb
  ) {
    const cookies = verified.headers.getSetCookie();
    const cookie = cookies.map((line) => line.split(";")[0]).join("; ");
    const account = await sessionAccount(new Request(request.url, { headers: { cookie } }), auth);
    if (account !== null) {
      // The person is signed in by now: Better Auth set the cookie above. A
      // hold that cannot move (a clash with a card already on the account)
      // is logged loudly and the hold stays where it was, rather than
      // turning a good sign-in into a 500.
      try {
        await attachPendingCardAccount(/** @type {D1Database} */ (driveDb), {
          email: account.email,
          accountId: account.id,
        });
      } catch (cause) {
        console.error(`card-step hold for account ${account.id} did not move: ${String(cause)}`);
      }
      // The account's own bucket exists from the first sign-in (drive#540):
      // the verify step provisions `drv-<id>` through the one provisionBucket
      // call the key mint also makes, so a customer who only ever uses the
      // website has a bucket for the Files page and web upload, with no device
      // key minted. Idempotent, so a returning sign-in re-checks the bucket for
      // free and an account from before this call existed catches up here. A
      // provisioning failure is logged loudly and the sign-in lands anyway —
      // the Files page answers an empty folder for a bucket that is not there
      // yet, and the key mint keeps its own call as the safety net.
      try {
        await provisionAccountBucket(env, account.id);
      } catch (cause) {
        console.error(
          `bucket provisioning for account ${account.id} did not finish: ${String(cause)}`,
        );
      }
      // The welcome email, once (drive#522). Four customer templates had no
      // caller at all, so somebody could sign up, be charged, hit their cap
      // and never hear from us. This is the seam that is guaranteed to run for
      // a real account, and it is once-only because the claim lives on the
      // account row (src/welcome.js), not in this isolate.
      //
      // A welcome is the one of those four that does not wait on a billing
      // decision, so it ships here; the other three are still waiting on
      // #496, and test/email-callers.test.mjs names them so they cannot go
      // missing again quietly.
      //
      // Never throws: sendWelcomeOnce reports instead, because a failed
      // welcome must never cost somebody their sign-in.
      const secrets = /** @type {{MAIL_FROM?: string}} */ (env);
      await sendWelcomeOnce({
        db: /** @type {D1Database} */ (driveDb),
        devices: createWelcomeStore(/** @type {D1Database} */ (driveDb)),
        email: env.EMAIL,
        mailFrom: secrets.MAIL_FROM ?? "",
        account,
        now: Date.now(),
      });
    }
  }
  // The one thing this route does is take the cookie Better Auth set onto a
  // same-origin redirect of its own, so a person lands on the drive rather
  // than on a JSON body. When they opened the device-approve link while signed
  // out, that page left a return cookie so they come back to the code.
  const extra = cookieHeaders(verified);
  const cookies = extra["set-cookie"] ?? [];
  const returnTo = safeAfterSigninPath(cookieValue(request, AFTER_SIGNIN_COOKIE));
  cookies.push(`${AFTER_SIGNIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return redirect(returnTo || AFTER_SIGNIN_PATH, { "set-cookie": cookies });
}
