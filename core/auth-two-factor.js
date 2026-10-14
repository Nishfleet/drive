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
