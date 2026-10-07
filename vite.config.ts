import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";
import { FIRST_RUN_COMMAND, FIRST_RUN_STEPS } from "./core/status.js";
import {
  assertSingleBeacon,
  BEACON_PAGES,
  BEACON_TOKEN_SETTING,
  beaconToken,
  withBeacon,
} from "./src/analytics.js";
import apiWorker from "./workers/api/cloudflare.config.ts";

export default defineConfig({
  plugins: [
    cloudflare({
      auxiliaryWorkers: [
        // The api Worker (drive issue #168). Its deploy config is
        // workers/api/cloudflare.config.ts, which the CLI's autoconfig never
        // reaches (CONFIG_FILENAME is resolved against the Vite root, and the
        // root's file is the site Worker's), so it is registered here as an
        // auxiliary Worker: the stock way a second Worker joins the build
        // output, and what makes the file a deploy config rather than dead
        // text. The build emits it beside the site Worker in the Build
        // Output, and a `cf deploy --worker drive-api` step ships it.
        { config: apiWorker },
      ],
    }),
    staticFirstRunShell(),
    webAnalyticsBeacon(),
    deadAuthCryptoShim(),
  ],
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            // The first-run page is a built entry (drive issue #70): its
            // <script type="module"> is bundled from src/get-started.js,
            // which imports the copy from core/status.js. Vite only treats an
            // HTML file as an entry when it is named here (index.html is the
            // implicit default), and the output keeps the entry's own file
            // name, so the page ships at /get-started.html as before. The
            // input is scoped to the client environment: the Worker build's
            // entry stays the src/index.js named in cloudflare.config.ts.
            "get-started": "./get-started.html",
          },
        },
      },
    },
  },
});

/**
 * The Cloudflare Web Analytics beacon, in the six pages drive#246 names, and
 * only when a beacon token is configured (drive issue #246).
 *
 * The pages ship as static assets: five are copied out of public/ verbatim and
 * one is the built Vite entry, and only the built entry reaches
 * `transformIndexHtml`. So the beacon is injected where both land, which is the
 * client environment's output directory, in `writeBundle` (after Vite has
 * written the files and before the Cloudflare plugin collects them as the
 * Worker's assets). That directory is taken from the client environment's own
 * resolved config, where `build.outDir` is already absolute: this repo's output
 * is `.cloudflare/output/...` inside the root, and joining the root onto the
 * resolved path walks it a second time. The six pages are the site's most-read
 * documents, served straight from the asset layer so that no page view costs a
 * Worker invocation (cloudflare.config.ts), and a request-time rewrite to add an
 * analytics script would spend one.
 *
 * The token comes from the environment, and an unset setting is the
 * switched-off case: the tag is not written at all, so the pages are byte for
 * byte what they ship today. Set it to the dashboard's 32-hex token to measure:
 *
 *   DRIVE_CF_BEACON_TOKEN=<32 hex> npm run build
 *
 * and in a deploy, a GitHub Actions variable of that name on the build step
 * (it is a variable, not a secret: the token is in every page's HTML).
 * src/analytics.js holds the token's shape and the tag, so both are unit
 * tested, and test/web-analytics.test.mjs fails if this plugin is dropped.
 * @returns {Plugin}
 */
function webAnalyticsBeacon(): Plugin {
  // The client environment's output directory, taken from the environment this
  // plugin is applied to rather than from the top-level config, which is the
  // Worker build's. Vite has already resolved it to an absolute path here.
  let assetsDir = "";
  return {
    name: "drive-web-analytics-beacon",
    applyToEnvironment(environment) {
      if (environment.name !== "client") return false;
      assetsDir = environment.config.build.outDir;
      // A relative value would join page names onto the wrong tree, and
      // readFileSync would then fail on a path that looks plausible.
      if (assetsDir !== "" && !isAbsolute(assetsDir)) {
        throw new Error(
          `drive-web-analytics-beacon (environment client): build.outDir resolved to ${assetsDir}, which is not an absolute path`,
        );
      }
      return true;
    },
    writeBundle() {
      // An empty directory would make every readFileSync below throw ENOENT with a
      // path that says nothing about why it is wrong, so it is named here.
      if (assetsDir === "") {
        throw new Error("drive-web-analytics-beacon found no client build output directory");
      }
      // Read once, before the loop: a mis-set token fails the build before any
      // file is touched, so a failed build leaves no half-instrumented output.
      const token = beaconToken(process.env[BEACON_TOKEN_SETTING]);
      if (token === "") return;
      for (const page of BEACON_PAGES) {
        const file = join(assetsDir, page);
        const html = readFileSync(file, "utf8");
        const withTag = withBeacon(html, token);
        if (withTag !== html) writeFileSync(file, withTag);
        // The gate on the bytes as written, not on the bytes as computed: the
        // file on disk is what ships, so the file on disk is what is checked.
        assertSingleBeacon(readFileSync(file, "utf8"), page);
      }
    },
  };
}

/**
 * Better Auth's JWT and password crypto, replaced in the Worker builds
 * (drive issue #851).
 *
 * The problem. Better Auth registers every route its router knows even when a
 * deployment's config means the route can never run, and its modules import
 * their crypto statically. So the site Worker's entry parsed jose (~76 KB of
 * JWT code) and @noble/hashes on every request even though core/auth.js signs
 * in with magic links only: sessions live in D1 (not JWT or JWE cookies),
 * email and password sign-in is off, social providers are empty, and nothing
 * in the app sends verification email. PR #848/#849 moved the two-factor
 * plugins into an on-demand chunk; jose itself stayed in the entry's static
 * graph through better-auth's crypto/jwt.mjs, cookies/jwt.mjs and
 * api/routes/email-verification.mjs, which import it (or its jose code)
 * whether or not a flow that uses them is configured.
 *
 * The fix is a build-time alias, not a fork: when a Worker module imports one
 * of the dead modules below, this plugin hands back a stub that keeps the
 * module's export names but throws on every call. The bundles no longer carry
 * jose or the hashed-crypto code those modules alone pulled in; the flows this
 * deployment does run (magic link tokens, passkey assertions, TOTP and backup
 * codes, database sessions) use other modules that stay real.
 *
 * What is replaced, and the config line that makes it dead:
 *
 * - `jose`, the package: only reachable through the flows named below.
 * - better-auth/dist/crypto/jwt.mjs: sign and verify run for JWT/JWE session
 *   cookie storage (session.store.sessionStrategy), the session cookie cache
 *   (session.cookieCache) and email verification tokens. drive uses database
 *   sessions, has no cookieCache and sends no verification email.
 * - better-auth/dist/cookies/jwt.mjs: verifies a session cache cookie signed
 *   against a JWKS — the cookieCache setup drive does not have.
 * - better-auth/dist/crypto/purpose.mjs: derives the key for the social
 *   sign-in state cookie; socialProviders is {}.
 * - better-auth/dist/crypto/password.mjs: hashes passwords;
 *   emailAndPassword.enabled is false.
 *
 * The constants in cookies/jwt.mjs keep their real values: they are inert
 * strings that live code reads. Every stub that throws names this plugin and
 * the config to change, so a future core/auth.js that enables a replaced flow
 * fails at the call site with the fix in the message instead of failing a
 * cryptic assertion elsewhere.
 *
 * The detector is test/bundle-auth-crypto.test.mjs: it reads the built
 * manifest's reachable chunks and fails if jose or @noble/hashes reappears.
 * @returns {Plugin}
 */
function deadAuthCryptoShim(): Plugin {
  // The NUL prefix marks a virtual module: rolldown never looks for it on
  // disk, and the built chunks carry it as a region marker, not a path.
  const shimId = (name: string) => `\0drive-auth-shim/${name}`;

  // Every shim's source below is one static string: no value from this file is
  // ever interpolated into generated code. CodeQL reads a value interpolated
  // into a code string as construction from an unsanitised input
  // (js/improper-code-sanitization), and the only way to keep that line quiet
  // is to keep a shim's text literal — so each stub writes its own failure
  // text out, and the repeats (the hatch sentence, the stub-class helper) are
  // the price. Do not "tidy" these back into a mapped builder: that is the
  // finding, not a style fix. The detector is
  // test/bundle-auth-crypto.test.mjs, and it checks the built bundle, not this
  // text — so a hand-edited stub still runs.
  //
  // `errors` keeps real classes because better-auth reads a member's `code` at
  // module level, and `base64url` keeps its object shape because jose exports
  // it as one.

  // jose/errors (a subpath import): the classes the stubs stand in for.
  const joseErrorShim = `
const stubError = (name, code) =>
  class extends Error {
    static code = code;
    constructor(message) { super(message); this.name = name; }
  };
export const JOSEError = stubError("JOSEError", "ERR_JOSE_GENERIC");
export const JWKSTimeout = stubError("JWKSTimeout", "ERR_JWKS_TIMEOUT");
export const JWKSInvalid = stubError("JWKSInvalid", "ERR_JWKS_INVALID");
export const JWKSMultipleMatchingKeys = stubError("JWKSMultipleMatchingKeys", "ERR_JWKS_MULTIPLE_MATCHING_KEYS");
export const JWKSNoMatchingKey = stubError("JWKSNoMatchingKey", "ERR_JWKS_NO_MATCHING_KEY");
export const JWSSignatureVerificationFailed = stubError("JWSSignatureVerificationFailed", "ERR_JWS_SIGNATURE_VERIFICATION_FAILED");
export const JWTExpired = stubError("JWTExpired", "ERR_JWT_EXPIRED");
export const JWTClaimValidationFailed = stubError("JWTClaimValidationFailed", "ERR_JWT_CLAIM_VALIDATION_FAILED");
`;

  // jose, the package: the surface the kept better-auth modules import, as the
  // union across its dist files. Functions throw on use, and `errors` carries
  // the classes above for the importers that read them as members.
  const joseShim = `
const stubError = (name, code) =>
  class extends Error {
    static code = code;
    constructor(message) { super(message); this.name = name; }
  };
const driveShimWhy = "the package only reached the Worker entry through the better-auth flows this deployment disables";
const driveShimHatch = "If this error fired, core/auth.js now enables a flow that needs it: remove the matching stub in vite.config.ts (the deadAuthCryptoShim plugin), rebuild, and re-measure the bundle with test/bundle-auth-crypto.test.mjs.";
const driveShimFail = (what) => {
  throw new Error(
    "drive issue #851: " + what + " is dead code that the deadAuthCryptoShim plugin in vite.config.ts removed from the Worker bundle, because " +
      driveShimWhy + ". " + driveShimHatch
  );
};
export function EncryptJWT() { driveShimFail("jose EncryptJWT"); }
export function SignJWT() { driveShimFail("jose SignJWT"); }
export function UnsecuredJWT() { driveShimFail("jose UnsecuredJWT"); }
export function calculateJwkThumbprint() { driveShimFail("jose calculateJwkThumbprint"); }
export function createLocalJWKSet() { driveShimFail("jose createLocalJWKSet"); }
export function createRemoteJWKSet() { driveShimFail("jose createRemoteJWKSet"); }
export function customFetch() { driveShimFail("jose customFetch"); }
export function decodeJwt() { driveShimFail("jose decodeJwt"); }
export function decodeProtectedHeader() { driveShimFail("jose decodeProtectedHeader"); }
export function exportJWK() { driveShimFail("jose exportJWK"); }
export function generateKeyPair() { driveShimFail("jose generateKeyPair"); }
export function importJWK() { driveShimFail("jose importJWK"); }
export function importPKCS8() { driveShimFail("jose importPKCS8"); }
export function jwtDecrypt() { driveShimFail("jose jwtDecrypt"); }
export function jwtVerify() { driveShimFail("jose jwtVerify"); }
export const base64url = { encode: () => driveShimFail("jose base64url.encode"), decode: () => driveShimFail("jose base64url.decode") };
export const errors = {
  JOSEError: stubError("JOSEError", "ERR_JOSE_GENERIC"),
  JWKSTimeout: stubError("JWKSTimeout", "ERR_JWKS_TIMEOUT"),
  JWKSInvalid: stubError("JWKSInvalid", "ERR_JWKS_INVALID"),
  JWKSMultipleMatchingKeys: stubError("JWKSMultipleMatchingKeys", "ERR_JWKS_MULTIPLE_MATCHING_KEYS"),
  JWKSNoMatchingKey: stubError("JWKSNoMatchingKey", "ERR_JWKS_NO_MATCHING_KEY"),
  JWSSignatureVerificationFailed: stubError("JWSSignatureVerificationFailed", "ERR_JWS_SIGNATURE_VERIFICATION_FAILED"),
  JWTExpired: stubError("JWTExpired", "ERR_JWT_EXPIRED"),
  JWTClaimValidationFailed: stubError("JWTClaimValidationFailed", "ERR_JWT_CLAIM_VALIDATION_FAILED"),
};
`;

  // better-auth/dist/crypto/jwt.mjs's own export surface.
  const authJwtShim = `
const driveShimWhy = "JWT and JWE cookie crypto runs only for JWT/JWE session storage (session.store.sessionStrategy), the session cookie cache (session.cookieCache) and email verification tokens, none of which this deployment enables";
const driveShimHatch = "If this error fired, core/auth.js now enables a flow that needs it: remove the matching stub in vite.config.ts (the deadAuthCryptoShim plugin), rebuild, and re-measure the bundle with test/bundle-auth-crypto.test.mjs.";
const driveShimFail = (what) => {
  throw new Error(
    "drive issue #851: " + what + " is dead code that the deadAuthCryptoShim plugin in vite.config.ts removed from the Worker bundle, because " +
      driveShimWhy + ". " + driveShimHatch
  );
};
export function signJWT() { driveShimFail("better-auth crypto/jwt.mjs signJWT"); }
export function symmetricEncodeJWT() { driveShimFail("better-auth crypto/jwt.mjs symmetricEncodeJWT"); }
export function symmetricDecodeJWT() { driveShimFail("better-auth crypto/jwt.mjs symmetricDecodeJWT"); }
export function verifyJWT() { driveShimFail("better-auth crypto/jwt.mjs verifyJWT"); }
`;

  // better-auth/dist/cookies/jwt.mjs: constants keep their real values.
  const cookiesJwtShim = `
export const SESSION_COOKIE_JWT_TYPE = "better-auth.session-cache+jwt";
export const SESSION_COOKIE_JWT_AUDIENCE = "better-auth:session-cache";
export const SESSION_COOKIE_JWT_ISSUER = "better-auth:session-cache";
const driveShimWhy = "a JWKS-verified session cookie cache cookie only runs with session.cookieCache, which this deployment does not enable";
const driveShimHatch = "If this error fired, core/auth.js now enables a flow that needs it: remove the matching stub in vite.config.ts (the deadAuthCryptoShim plugin), rebuild, and re-measure the bundle with test/bundle-auth-crypto.test.mjs.";
const driveShimFail = (what) => {
  throw new Error(
    "drive issue #851: " + what + " is dead code that the deadAuthCryptoShim plugin in vite.config.ts removed from the Worker bundle, because " +
      driveShimWhy + ". " + driveShimHatch
  );
};
export function getSessionCookieJwtVerifyOptions() { driveShimFail("better-auth cookies/jwt.mjs getSessionCookieJwtVerifyOptions"); }
export function parseSessionCookieJwtPayload() { driveShimFail("better-auth cookies/jwt.mjs parseSessionCookieJwtPayload"); }
export function verifySessionCookieJwtWithJwks() { driveShimFail("better-auth cookies/jwt.mjs verifySessionCookieJwtWithJwks"); }
`;

  const purposeShim = `
const driveShimWhy = "it derives the key for the social sign-in state cookie, and socialProviders is empty in core/auth.js";
const driveShimHatch = "If this error fired, core/auth.js now enables a flow that needs it: remove the matching stub in vite.config.ts (the deadAuthCryptoShim plugin), rebuild, and re-measure the bundle with test/bundle-auth-crypto.test.mjs.";
const driveShimFail = (what) => {
  throw new Error(
    "drive issue #851: " + what + " is dead code that the deadAuthCryptoShim plugin in vite.config.ts removed from the Worker bundle, because " +
      driveShimWhy + ". " + driveShimHatch
  );
};
export function derivePurposeKey() { driveShimFail("better-auth crypto/purpose.mjs derivePurposeKey"); }
`;

  const passwordShim = `
const driveShimWhy = "password hashing runs only for email and password sign-in, and emailAndPassword.enabled is false in core/auth.js";
const driveShimHatch = "If this error fired, core/auth.js now enables a flow that needs it: remove the matching stub in vite.config.ts (the deadAuthCryptoShim plugin), rebuild, and re-measure the bundle with test/bundle-auth-crypto.test.mjs.";
const driveShimFail = (what) => {
  throw new Error(
    "drive issue #851: " + what + " is dead code that the deadAuthCryptoShim plugin in vite.config.ts removed from the Worker bundle, because " +
      driveShimWhy + ". " + driveShimHatch
  );
};
export function hashPassword() { driveShimFail("better-auth crypto/password.mjs hashPassword"); }
export function verifyPassword() { driveShimFail("better-auth crypto/password.mjs verifyPassword"); }
`;

  /** The shim each virtual id carries. */
  const shims = {
    jose: joseShim,
    "jose-subpath": joseErrorShim,
    "better-auth-crypto-jwt": authJwtShim,
    "better-auth-cookies-jwt": cookiesJwtShim,
    "better-auth-crypto-purpose": purposeShim,
    "better-auth-crypto-password": passwordShim,
  };
  // The better-auth dist files, as paths relative to better-auth/dist, whose
  // importers are redirected to the shim above. A file is here only because a
  // core/auth.js config line makes its code unreachable (see the list above).
  const distFiles = {
    "crypto/jwt.mjs": "better-auth-crypto-jwt",
    "cookies/jwt.mjs": "better-auth-cookies-jwt",
    "crypto/purpose.mjs": "better-auth-crypto-purpose",
    "crypto/password.mjs": "better-auth-crypto-password",
  };

  return {
    name: "drive-dead-auth-crypto-shim",
    // Pre: win the resolve before Vite's own resolver answers for the bare
    // `jose` specifier and the dist files' relative imports.
    enforce: "pre",
    applyToEnvironment(environment) {
      // The Worker builds are the bundle that must not carry the dead code;
      // the client pages import neither better-auth nor jose, and a future
      // one that did should get the real package rather than this stub.
      return environment.name !== "client";
    },
    resolveId(source, importer) {
      // `jose` and its subpaths: better-auth's api/routes/email-verification.mjs
      // imports its JWTExpired error class from "jose/errors", so the whole
      // prefix goes to the shim, not just the bare package name.
      if (source === "jose" || source.startsWith("jose/")) {
        return source === "jose" ? shimId("jose") : shimId("jose-subpath");
      }
      if (importer === undefined || !source.startsWith(".")) return null;
      // Relative imports from a module on disk: resolve them the way the
      // resolver would, so the match is on the file better-auth ships, not
      // on the spelling of one importer's specifier.
      const target = resolve(dirname(importer), source).split(sep).join("/");
      for (const [file, name] of Object.entries(distFiles)) {
        if (target.endsWith(`/better-auth/dist/${file}`)) return shimId(name);
      }
      return null;
    },
    load(id) {
      const name = id.startsWith("\0drive-auth-shim/")
        ? id.slice("\0drive-auth-shim/".length)
        : undefined;
      return name !== undefined && name in shims ? shims[name as keyof typeof shims] : null;
    },
  };
}

/**
 * The walk-through and the one command, printed into the built
 * get-started.html (drive#225). The page shipped its <ol id="steps"> and its
 * <code id="install-command"> empty and let the module fill them in, so the
 * first paint had a blank list: the page was not usable until the script ran,
 * and when the script filled the list the page jumped (a 0.23 CLS on the
 * Lighthouse run measured 2026-10-02). The words are core/status.js's, so the
 * HTML carrying them statically is a build step and not a third copy to drift:
 * this runs in the same build that already reads that module for the module
 * script, and throws when a marker it replaces is not in the page, so a page
 * that moved under it fails the build rather than shipping an empty list again.
 * @returns {Plugin}
 */
function staticFirstRunShell(): Plugin {
  /** @param {string} text @returns {string} */
  const text = (value) =>
    value.replace(/[&<>]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt" }[c]};`);
  return {
    name: "drive-static-first-run-shell",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const steps = FIRST_RUN_STEPS.map(
          (step) => `        <li><h3>${text(step.title)}</h3><p>${text(step.body)}</p></li>`,
        ).join("\n");
        const withSteps = html.replace(
          '      <ol class="steps" id="steps">\n        <!-- Filled by get-started.js from core/status.js -->\n      </ol>',
          `      <ol class="steps" id="steps">\n${steps}\n      </ol>`,
        );
        const withCommand = withSteps.replace(
          '<code id="install-command"></code>',
          `<code id="install-command">${text(FIRST_RUN_COMMAND)}</code>`,
        );
        if (withSteps === html || withCommand === withSteps) {
          throw new Error(
            "get-started.html moved: the static first-run shell found neither its steps list nor its command",
          );
        }
        return withCommand;
      },
    },
  };
}
