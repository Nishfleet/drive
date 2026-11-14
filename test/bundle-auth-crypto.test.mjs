import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
    t.skip(
      "no Worker build output; run npm run build first (CI's verify job runs " +
        "that step before npm test)",
    );
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
