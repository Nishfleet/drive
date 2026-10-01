// AWS Signature Version 4: the one signing scheme every S3-compatible
// endpoint accepts, and the only way the api Worker can hold a storage master
// key without ever handing a plain-text secret to a caller (build step 1,
// drive#2).
//
// Signing is protocol, not product logic, so this file is the whole of it: the
// canonical request, the string to sign, the four-step key derivation and the
// Authorization header, built from WebCrypto alone so the same module runs in
// the Worker isolate and under `node --test`. There is no node:crypto import
// here, because this code is bundled into the Worker.
//
// SigV4 signs what is in the request, so a request signed twice with different
// bytes gets a different signature and S3 answers SignatureDoesNotMatch. The
// canonical form below is therefore produced once, in `signRequest`, and the
// URL it returns is the URL that must be sent: `send()` in s3.js always
// fetches the URL this returns, never the one it was handed.

const encoder = new TextEncoder();
const HEX = "0123456789abcdef";

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toHex(bytes) {
  let out = "";
  for (const byte of bytes) {
    out += HEX[byte >> 4] + HEX[byte & 15];
  }
  return out;
}

/**
 * The bytes as a WebCrypto `BufferSource`. The runtime value is always a view
 * over a plain ArrayBuffer — a string's own bytes, or a copy of a caller's
 * view — so copying is the whole translation: the type system types a view that
 * arrived through an option as `Uint8Array<ArrayBufferLike>`, and WebCrypto's
 * parameter accepts only an ArrayBuffer-backed one.
 * @param {string|Uint8Array} bytes
 * @returns {BufferSource}
 */
function bufferSource(bytes) {
  const source = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return /** @type {BufferSource} */ (copy);
}

/**
 * Hex SHA-256 of a string or a view.
 * @param {string|Uint8Array} data
 * @returns {Promise<string>}
 */
async function sha256Hex(data) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bufferSource(data))));
}

/**
 * One HMAC-SHA256 step: the bytes WebCrypto signs, ready to be hashed again or
 * hex-encoded.
 * @param {CryptoKey} key
 * @param {string} data
 * @returns {Promise<Uint8Array>}
 */
async function hmac(key, data) {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bufferSource(data)));
}

/**
 * RFC 3986 percent-encoding. `encodeURIComponent` leaves `!'()*` alone and AWS
 * escapes them, so they are escaped here as well; a key with an apostrophe in
 * it would otherwise produce a signature S3 refuses.
 * @param {string} value
 * @returns {string}
 */
export function uriEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The canonical URI: each path segment escaped, the slashes kept. A segment is
 * decoded first so an already-escaped URL is not escaped twice, which is what
 * makes the canonical form and the sent URL the same string.
 * @param {string} pathname
 * @returns {string}
 */
function canonicalUri(pathname) {
  const segments = pathname.split("/").map((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // A segment that is not a valid escape is kept as it arrived: the server
      // sees the same bytes, and re-encoding what it will reject would only
      // hide the address.
    }
    return uriEncode(decoded);
  });
  return segments.join("/") || "/";
}

/**
 * The canonical query string: every parameter sorted by name and then by
 * value, both escaped. S3 compares this string, so `?versions` and `?versions=`
 * and a differently ordered pair are different requests.
 * @param {string} search
 * @returns {string}
 */
function canonicalQuery(search) {
  const parameters = [...new URLSearchParams(search).entries()];
  parameters.sort(([name, value], [otherName, otherValue]) =>
    name === otherName
      ? (value < otherValue ? -1 : value > otherValue ? 1 : 0)
      : name < otherName ? -1 : 1,
  );
  return parameters.map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`).join("&");
}

/**
 * The four-step signing key: AWS4 + secret, then date, region and service.
 * @param {string} secretAccessKey
 * @param {string} dateStamp `YYYYMMDD`
 * @param {string} region
 * @param {string} service `s3` or `sts`
 * @returns {Promise<Uint8Array>}
 */
async function signingKey(secretAccessKey, dateStamp, region, service) {
  /** @param {string|Uint8Array} material */
  const importRaw = (material) =>
    crypto.subtle.importKey("raw", bufferSource(material), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

  const date = await hmac(await importRaw(`AWS4${secretAccessKey}`), dateStamp);
  const regionKey = await hmac(await importRaw(date), region);
  const serviceKey = await hmac(await importRaw(regionKey), service);
  return hmac(await importRaw(serviceKey), "aws4_request");
}

/**
 * A credential the endpoint can verify: an access key id, its secret, and the
 * session token a temporary credential also carries.
 * @typedef {object} SigV4Credentials
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} [sessionToken] required for a temporary credential
 */

/**
 * @typedef {object} SignOptions
 * @property {string} method
 * @property {string} url
 * @property {SigV4Credentials} credentials
 * @property {string} region
 * @property {string} service
 * @property {Record<string, string>} [headers] sent, and signed, verbatim
 * @property {string|Uint8Array} [body]
 * @property {Date} [now] injected so a test can pin the clock
 */

/**
 * @typedef {object} SignedRequest
 * @property {string} url the canonical URL, which is the one to send
 * @property {Record<string, string>} headers
 */

/**
 * Signs one request. The returned URL and headers are the request: sending any
 * other address, or a header with a different value, breaks the signature and
 * S3 answers SignatureDoesNotMatch.
 * @param {SignOptions} options
 * @returns {Promise<SignedRequest>}
 */
export async function signRequest(options) {
  const { method, url, credentials, region, service, headers = {}, body = "", now = new Date() } = options;
  const target = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);

  // `host` is signed and sent together, so it is written once here; a caller
  // that also passes it would only be able to disagree with the URL.
  const sent = {
    host: target.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}),
    ...headers,
  };
  /** @type {Record<string, string>} */
  const byLowerName = {};
  for (const [name, value] of Object.entries(sent)) {
    byLowerName[name.toLowerCase()] = value;
  }
  const names = Object.keys(byLowerName).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${byLowerName[name].trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");

  const path = canonicalUri(target.pathname);
  const query = canonicalQuery(target.search);
  const canonicalRequest = [
    method.toUpperCase(),
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = toHex(await hmac(
    await crypto.subtle.importKey(
      "raw",
      bufferSource(await signingKey(credentials.secretAccessKey, dateStamp, region, service)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    stringToSign,
  ));

  return {
    url: `${target.origin}${path}${query ? `?${query}` : ""}`,
    headers: {
      ...byLowerName,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
