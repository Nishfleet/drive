// The download grant (drive#517): the proof of access the dl Worker asks for.
//
// rclone's S3 backend reads through a download host by appending the object's
// in-bucket path to a fixed base URL (`--s3-download-url`, backend/s3/s3.go
// `downloadFromURL`: `DownloadURL + bucketPath`, a plain unsigned GET with the
// caller's Range). It sends no storage signature and no header we control, so
// the only place a proof can ride is the base URL itself.
//
// The api Worker therefore mints, beside each account-folder storage key, a
// base URL of the shape `https://<dl host>/k/<grant>/`, where `<grant>` is an
// HMAC-SHA256-signed statement "key <keyId> of account <accountId>". The dl
// Worker checks the signature with the same secret, then checks that key's
// row in D1: it must belong to that account, be unrevoked and unexpired, hold
// the `read` capability, and its prefix must cover the file asked for. The
// grant names a key rather than carrying its own clock, so a revoke or an
// expiry of the key ends the URL at the next request, and a renewal of an
// agent key's hour keeps it working without a new URL.
//
// The secret is `DL_SIGNING_SECRET`, set on both Workers per deployment. It is
// read from the env and not declared as a `bindings.secret()`, the same way
// the storage master credential is (core/files.js StorageEnv): a deployment
// without it mints no download URL and the dl Worker serves nothing.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The grant format's version, so a later shape can be told apart. */
const GRANT_VERSION = 1;

/** The path segment a grant rides under on the dl host. */
export const GRANT_SEGMENT = "k";

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @param {string} text
 * @returns {Uint8Array<ArrayBuffer>|null}
 */
function fromBase64url(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    return null;
  }
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * @param {string} secret
 * @returns {Promise<CryptoKey>}
 */
function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Sign a grant for one key of one account.
 * @param {string} secret the shared signing secret
 * @param {{accountId: string, keyId: string}} subject
 * @returns {Promise<string>} the grant, safe as one URL path segment
 */
export async function signGrant(secret, subject) {
  if (typeof secret !== "string" || secret === "") {
    throw new TypeError("a download grant needs a signing secret");
  }
  const { accountId, keyId } = subject;
  if (
    typeof accountId !== "string" ||
    accountId === "" ||
    typeof keyId !== "string" ||
    keyId === ""
  ) {
    throw new TypeError("a download grant needs an account id and a key id");
  }
  const payload = base64url(
    encoder.encode(JSON.stringify({ v: GRANT_VERSION, a: accountId, k: keyId })),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)),
  );
  return `${payload}.${base64url(signature)}`;
}

/**
 * Read a grant back: its subject when the signature is this secret's, or null
 * for anything else (no grant, a forged or altered one, another format). The
 * compare is `crypto.subtle.verify`, which is constant-time.
 * @param {string} secret
 * @param {string} grant
 * @returns {Promise<{accountId: string, keyId: string}|null>}
 */
export async function readGrant(secret, grant) {
  if (typeof secret !== "string" || secret === "" || typeof grant !== "string") {
    return null;
  }
  const parts = grant.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts;
  const signatureBytes = fromBase64url(signature);
  const payloadBytes = fromBase64url(payload);
  if (signatureBytes === null || payloadBytes === null) {
    return null;
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signatureBytes,
    encoder.encode(payload),
  );
  if (!valid) {
    return null;
  }
  let body;
  try {
    body = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }
  if (
    body === null ||
    typeof body !== "object" ||
    body.v !== GRANT_VERSION ||
    typeof body.a !== "string" ||
    body.a === "" ||
    typeof body.k !== "string" ||
    body.k === ""
  ) {
    return null;
  }
  return { accountId: body.a, keyId: body.k };
}

/**
 * The base URL a key's mount reads through: the dl host, the grant segment,
 * and a trailing slash, because rclone appends the in-bucket path to it as it
 * is.
 * @param {string} baseUrl the dl host, e.g. `https://dl.example`
 * @param {string} grant
 * @returns {string}
 */
export function downloadUrlFor(baseUrl, grant) {
  return `${baseUrl.replace(/\/+$/, "")}/${GRANT_SEGMENT}/${grant}/`;
}
