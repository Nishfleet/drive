// Cloudflare Access identity, verified (drive#342's live test address).
//
// While drive has no domain of its own, the site is on its workers.dev address
// behind Cloudflare Access, so every request that reaches this Worker already
// passed Access. Access proves who the person is with a signed JWT in the
// `Cf-Access-Jwt-Assertion` header. Email sign-in cannot work on that address
// (no sending domain until drive#199), so the test address signs a person in
// with the identity Access already proved, and nothing else.
//
// The header alone proves nothing: a header is a string any caller can send.
// What makes it a proof is the check below, which is Cloudflare's documented
// one (developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/
// validating-json/): the RS256 signature against the team's own public keys
// (`<team domain>/cdn-cgi/access/certs`), `aud` equal to this Access
// application's tag, `iss` equal to the team domain, and `exp`/`nbf`. jose is
// the stock library for it; `jwtVerify` checks exp and nbf itself.
//
// The whole feature is off unless both ACCESS_AUD and ACCESS_TEAM_DOMAIN are
// set on the deployment: `accessConfig` returns null and the route answers as
// a path that does not exist. They are set by hand on the test address only,
// and deleting them turns the feature off without a deploy.

import { createRemoteJWKSet, jwtVerify } from "jose";

/** The header Cloudflare Access puts the signed identity in. */
export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/** Where an Access team publishes the keys its JWTs are signed with. */
export const ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";

/**
 * @typedef {{aud: string, issuer: string}} AccessConfig
 * @typedef {Parameters<typeof jwtVerify>[1]} AccessKeySet
 */

/**
 * The deployment's Access settings, or null when the feature is off. The team
 * domain must be an https origin; anything else is treated as unset rather
 * than trusted, so a typo turns the feature off instead of opening it.
 * @param {{ACCESS_AUD?: unknown, ACCESS_TEAM_DOMAIN?: unknown}} env
 * @returns {AccessConfig|null}
 */
export function accessConfig(env) {
  const aud = typeof env.ACCESS_AUD === "string" ? env.ACCESS_AUD.trim() : "";
  const team = typeof env.ACCESS_TEAM_DOMAIN === "string" ? env.ACCESS_TEAM_DOMAIN.trim() : "";
  if (aud === "" || team === "") {
    return null;
  }
  let url;
  try {
    url = new URL(team);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }
  return { aud, issuer: url.origin };
}

/** One remote key set per team, so an isolate fetches the certs once. */
const KEY_SETS = new Map();

/**
 * @param {string} issuer
 * @returns {AccessKeySet}
 */
function keySetFor(issuer) {
  let keySet = KEY_SETS.get(issuer);
  if (keySet === undefined) {
    keySet = createRemoteJWKSet(new URL(ACCESS_CERTS_PATH, issuer));
    KEY_SETS.set(issuer, keySet);
  }
  return keySet;
}

/** The same address shape the email sign-in accepts (src/signin.js). */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The email Access proved for this request, or null. Null for a missing
 * header, a bad signature, a token for another application or another team,
 * an expired or not-yet-valid token, and a token with no email (an Access
 * service token): every one of them is "not signed in", never a reason.
 * @param {Request} request
 * @param {AccessConfig} config
 * @param {AccessKeySet} [keySet] the keys to verify against; the team's own by default
 * @returns {Promise<{email: string}|null>}
 */
export async function accessIdentity(request, config, keySet = keySetFor(config.issuer)) {
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (token === null || token === "") {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, keySet, {
      algorithms: ["RS256"],
      audience: config.aud,
      issuer: config.issuer,
    });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    return EMAIL_SHAPE.test(email) ? { email } : null;
  } catch {
    return null;
  }
}
