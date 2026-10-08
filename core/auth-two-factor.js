// The second factor, loaded only when a second-factor request arrives
// (drive#848).
//
// Why this file exists. The second factor's plugin and the recovery-code
// crypto it alone pulls in are dead weight in the main Worker entry: no
// sign-in, no session read and no file operation touches them, and the entry
// chunk is what every request pays to parse. So `core/auth.js` — the module
// the main entry imports on every request — builds its instance WITHOUT the
// factor, and this module is the only place that imports the plugin itself.
// `twoFactorAuthFor` in core/auth.js reaches it through `await import()`, so
// the bundler puts this file and everything only it needs in its own chunk.
//
// What it exports is the plugin factory, not an instance. The instance still
// comes from `createAuth` in core/auth.js with the same database, secret and
// base URL the factorless instance was built from: one Better Auth instance
// per (database, secret, URL) each way, one without the factor for ordinary
// requests and one with it for /api/auth/two-factor/* and the api Worker's
// device approval. Two instances over one database is the same arrangement
// the two Workers already have, not a second store.
//
// The settings are the ones the factor documents, unchanged from where they
// lived before this file: passwordless enrollment, because no drive account
// carries a password to check (the sign-in flow is the emailed link), so
// `allowPasswordless` drops the body schema's password requirement. The
// account gate is untouched — the factor arms an already-signed-in browser
// session, it does not gate the email link — and the tables are migration
// 0034 (migrations/drive/), still pinned by test/auth.test.mjs against the
// library's expected schema.
import { twoFactor } from "better-auth/plugins/two-factor";

/**
 * The plugin factory `core/auth.js` puts in its chain when the request is a
 * second-factor one. Exported as a value, not called at module scope, so the
 * caller chooses the options and the plugin is constructed inside the chain
 * `createAuth` assembles.
 *
 * The return type is the library factory's own inferred return, named here
 * through a type-only import. That is what keeps `enableTwoFactor`,
 * `verifyTOTP` and `verifyBackupCode` on the instance's inferred `api`: the
 * library's `Auth` type reads its endpoints off the plugin's declared type,
 * and widening this to `BetterAuthPlugin` would quietly drop them. A
 * type-only import is erased at build, so naming the type costs the entry
 * chunk nothing — the static value import above is the only one that reaches
 * the bundle, and it lives in this on-demand file.
 * @param {{allowPasswordless: boolean}} options
 * @returns {ReturnType<typeof twoFactor>}
 */
export const twoFactorPlugin = (options) => twoFactor(options);
