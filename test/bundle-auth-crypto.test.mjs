// The dead-auth-crypto shim (drive issue #851).
//
// Better Auth registers every route its router knows, even when the
// deployment's config means a route can never run, and its modules import
// their crypto statically — so the site Worker parsed jose (~76 KB of JWT
// code) and @noble/hashes on every request while core/auth.js signs people in
// with magic links only: database sessions, no password sign-in, no social
// providers, no verification email. vite.config.ts's deadAuthCryptoShim
// plugin aliases the dead modules to throwing stubs at build time, and the
// bundles dropped 104,260 bytes (3,004,752 -> 2,900,492; drive#851).
//
// This file is the detector. The shim is an alias at the bundler boundary, so
// Node tests run the real library code and cannot see it; the shape the
// Worker actually ships is only visible in the build output. Two things must
// hold, and each has its own probe:
//
//   1. The built bundle carries no jose and no @noble/hashes regions, and
//      still carries @noble/ciphers — the live crypto (two-factor backup-code
//      and OTP encryption, and the library's own state machinery) that a
//      future shim must not also alias away.
//   2. The config lines that make the replaced modules dead are still in
//      core/auth.js: the stubs throw if a flow they serve is ever enabled, so
//      an enabled flow and the shim cannot both pass silently — but the pin
//      makes the conflict visible at test time, not at a customer's request.
//
// Probes:
//   1. Bundle regions: jose gone, @noble/hashes gone, @noble/ciphers here.
//   2. The core/auth.js anchors the shim's deadness is argued from.
//   3. The shim still lists every module it replaces.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Every JavaScript file the Worker build wrote, entry and chunks, in the
 * shape the ratchet test walks (test/speed-ratchet.test.mjs): the build
 * output directory with Vite's own metadata skipped. Region markers
 * (`//#region node_modules/<pkg>`) are how the bundle names the module that
 * produced a stretch of code, so a marker is the evidence a package shipped.
 * @param {string} dir
 * @returns {string[]}
 */
function bundleScripts(dir) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} folder */
  function walk(folder) {
    for (const name of readdirSync(folder).sort()) {
      if (name === ".vite") continue;
      const path = join(folder, name);
      const info = statSync(path);
      if (info.isDirectory()) {
        walk(path);
        continue;
      }
      if (info.isFile() && /\.(js|mjs)$/.test(name)) files.push(path);
    }
  }
  walk(dir);
  return files;
}

/** @param {string} file */
const regions = (file) =>
  Array.from(readFileSync(file, "utf8").matchAll(/\/\/#region (node_modules\/[^\s]+)/g)).map(
    (m) => m[1],
  );

test("the Worker bundle ships no jose and no @noble/hashes, and still ships @noble/ciphers", (t) => {
  const dir = fileURLToPath(
    new URL("../.cloudflare/output/v0/workers/default/bundle/", import.meta.url),
  );
  if (!existsSync(dir)) {
    t.skip("no Worker build output; CI runs npm run build before npm test");
    return;
  }
  const files = bundleScripts(dir);
  assert.ok(files.length > 0, "the Worker output directory exists but has no scripts");
  /** @type {string[]} */
  const jose = [];
  /** @type {string[]} */
  const hashes = [];
  /** @type {string[]} */
  const ciphers = [];
  for (const file of files) {
    for (const region of regions(file)) {
      if (region.startsWith("node_modules/jose")) jose.push(`${file}: ${region}`);
      if (region.startsWith("node_modules/@noble/hashes")) hashes.push(`${file}: ${region}`);
      if (region.startsWith("node_modules/@noble/ciphers")) ciphers.push(`${file}: ${region}`);
    }
  }
  assert.deepEqual(
    jose,
    [],
    "jose is back in the Worker bundle. Every flow drive configures uses other " +
      "crypto (database sessions, magic-link tokens, passkey, TOTP); if a new " +
      "flow needs JWTs, widen or remove the deadAuthCryptoShim plugin in " +
      "vite.config.ts and re-measure the bundle. Regions: " +
      jose.join(", "),
  );
  assert.deepEqual(
    hashes,
    [],
    "@noble/hashes is back in the Worker bundle. The modules that pulled it in " +
      "(better-auth's crypto/jwt.mjs, crypto/purpose.mjs, crypto/password.mjs) " +
      "are all dead in drive's config; see the deadAuthCryptoShim plugin in " +
      "vite.config.ts. Regions: " +
      hashes.join(", "),
  );
  assert.ok(
    ciphers.length > 0,
    "no @noble/ciphers regions in the Worker bundle. The live crypto must " +
      "stay: two-factor encrypts backup codes and stored OTPs with it, and " +
      "better-auth's state module reaches it statically. If it moved to an " +
      "on-demand chunk on purpose, narrow this probe; if a shim ate it, the " +
      "second factor is broken at runtime.",
  );
  t.diagnostic(
    `bundle: ${files.length} scripts, jose=0, @noble/hashes=0, @noble/ciphers=${ciphers.length} regions`,
  );
});

test("core/auth.js still says what makes the replaced crypto dead", () => {
  const auth = read("core/auth.js");
  assert.match(
    auth,
    /emailAndPassword:\s*\{\s*enabled:\s*false\s*\}/,
    "email and password sign-in is on: better-auth's crypto/password.mjs now " +
      "runs for real, so remove it from the deadAuthCryptoShim plugin in " +
      "vite.config.ts and re-measure the bundle",
  );
  assert.match(
    auth,
    /socialProviders:\s*\{\s*\}/,
    "social sign-in is configured: better-auth's crypto/purpose.mjs (the state " +
      "cookie key) now runs for real, so remove it from the deadAuthCryptoShim " +
      "plugin in vite.config.ts and re-measure the bundle",
  );
  for (const anchor of ["cookieCache\\s*:", "sessionStrategy\\s*:", "emailVerification\\s*:"]) {
    assert.doesNotMatch(
      auth,
      new RegExp(anchor),
      `core/auth.js configures ${anchor.replace("\\s*:", "")}: better-auth's JWT ` +
        "session crypto (crypto/jwt.mjs, cookies/jwt.mjs) now runs for real, so " +
        "remove them from the deadAuthCryptoShim plugin in vite.config.ts and " +
        "re-measure the bundle",
    );
  }
});

test("the deadAuthCryptoShim plugin still lists every module it replaces", () => {
  const config = read("vite.config.ts");
  assert.match(
    config,
    /deadAuthCryptoShim\(\)/,
    "the plugin is not registered in the plugins array; the bundle test above " +
      "fails with it removed, so this is the pointer, not the gate",
  );
  for (const replaced of [
    '"crypto/jwt.mjs"',
    '"cookies/jwt.mjs"',
    '"crypto/purpose.mjs"',
    '"crypto/password.mjs"',
  ]) {
    assert.ok(
      config.includes(replaced),
      `the shim list no longer names ${replaced}: either the module was removed ` +
        "on purpose (re-measure the bundle, then drop this probe) or the list " +
        "drifted from better-auth's dist layout and the code is back in the " +
        "bundle silently",
    );
  }
});
