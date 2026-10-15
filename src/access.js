const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

const ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";

/** @typedef {{aud: string, issuer: string}} AccessConfig */

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

const KEY_TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, {at: number, keys: JsonWebKey[]}>} */
const KEY_SETS = new Map();

/**
 * The team's public keys, fetched once per isolate and refreshed after the
 * TTL, or at once when a token names a key id the cache does not hold.
 * @param {string} issuer
 * @param {boolean} fresh skip the cache
 * @returns {Promise<(JsonWebKey & {kid?: string})[]>}
 */
async function teamKeys(issuer, fresh) {
  const cached = KEY_SETS.get(issuer);
  if (!fresh && cached !== undefined && Date.now() - cached.at < KEY_TTL_MS) {
    return cached.keys;
  }
  const response = await fetch(new URL(ACCESS_CERTS_PATH, issuer));
  if (!response.ok) {
    throw new Error(`Access certs answered ${response.status}`);
  }
  const body = /** @type {{keys?: unknown}} */ (await response.json());
  const keys = Array.isArray(body.keys) ? body.keys : [];
  KEY_SETS.set(issuer, { at: Date.now(), keys });
  return keys;
}

/**
 * @param {string} part a base64url JWT segment
 * @returns {Uint8Array<ArrayBuffer>}
 */
function fromBase64Url(part) {
  const padded = part
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(part.length / 4) * 4, "=");
  const text = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i);
  }
  return bytes;
}

/**
 * The payload of a token whose RS256 signature checks out against one of the
 * team's keys, or null.
 * @param {string} token
 * @param {string} issuer
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function verifiedPayload(token, issuer) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [head, body, signature] = parts;
  const header = JSON.parse(new TextDecoder().decode(fromBase64Url(head)));
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    return null;
  }
  let key = (await teamKeys(issuer, false)).find((candidate) => candidate.kid === header.kid);
  if (key === undefined) {
    key = (await teamKeys(issuer, true)).find((candidate) => candidate.kid === header.kid);
  }
  if (key === undefined) {
    return null;
  }
  const imported = await crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${head}.${body}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    imported,
    fromBase64Url(signature),
    signed,
  );
  return valid ? JSON.parse(new TextDecoder().decode(fromBase64Url(body))) : null;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The email Access proved for this request, or null. Null for a missing
 * header, a bad signature, a token for another application or another team,
 * an expired or not-yet-valid token, and a token with no email (an Access
 * service token): every one of them is "not signed in", never a reason.
 * @param {Request} request
 * @param {AccessConfig} config
 * @returns {Promise<{email: string}|null>}
 */
export async function accessIdentity(request, config) {
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (token === null || token === "") {
    return null;
  }
  try {
    const payload = await verifiedPayload(token, config.issuer);
    if (payload === null || payload.iss !== config.issuer) {
      return null;
    }
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audience.includes(config.aud)) {
      return null;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
      return null;
    }
    if (
      payload.nbf !== undefined &&
      (typeof payload.nbf !== "number" || payload.nbf > nowSeconds)
    ) {
      return null;
    }
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    return EMAIL_SHAPE.test(email) ? { email } : null;
  } catch {
    return null;
  }
}
