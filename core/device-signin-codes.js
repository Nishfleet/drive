import { DAY_MS } from "./units.js";

export const DEVICE_CODE_TTL_SECONDS = 15 * 60;
export const DEVICE_CODE_INTERVAL_SECONDS = 5;

export const DEVICE_TOKEN_TTL_SECONDS = (30 * DAY_MS) / 1000;

export const DEVICE_TOKEN_REFRESH_SECONDS = DAY_MS / 1000;

/**
 * The expiry a live device token carries after a request at `at`. One rule,
 * written here rather than in each store's SQL, so the in-memory stand-in and
 * the D1 store cannot renew by two different amounts and a test can name the
 * rule itself (drive#557).
 *
 * A token that is nowhere near its expiry keeps the one it has, so nothing is
 * written; a token inside the refresh age is handed a whole new window. The
 * renewal never shortens: two requests can read the same row and renew in
 * either order, and the write that lands second must not pull the window back
 * to the earlier value.
 *
 * This says nothing about powers. It is called only after the bearer lookup
 * has already refused a revoked row and a row past its expiry, so a dead token
 * is never renewed into a live one.
 *
 * @param {number} expiresAt the expiry the row carries now
 * @param {number} at epoch seconds, the injected clock's now
 * @returns {number} the expiry the row should carry
 */
export function renewDeviceTokenWindow(expiresAt, at) {
  if (expiresAt - at > DEVICE_TOKEN_REFRESH_SECONDS) {
    return expiresAt;
  }
  return Math.max(expiresAt, at + DEVICE_TOKEN_TTL_SECONDS);
}

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;

/**
 * A random user code, grouped as XXXX-XXXX for reading aloud. The alphabet's
 * 20 letters do not divide 256 evenly, so a byte above the last full group is
 * rejected rather than biased toward the alphabet's low end.
 * @param {() => Uint8Array} randomBytes
 */
export function newUserCode(randomBytes) {
  const bytes = randomBytes();
  const limit = Math.floor(256 / USER_CODE_ALPHABET.length) * USER_CODE_ALPHABET.length;
  let out = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    let byte = bytes[i];
    while (byte >= limit) {
      byte = randomBytes()[0];
    }
    out += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    if (i === 3) {
      out += "-";
    }
  }
  return out;
}

/**
 * The one account name before a person has one: named for where it signed in.
 * Used only by the in-memory store over a device name; the real flow names the
 * account at sign-in, not here.
 * @param {unknown} deviceName
 */
export function deviceLabel(deviceName) {
  const trimmed = typeof deviceName === "string" ? deviceName.trim() : "";
  return trimmed.length > 0 ? trimmed : "My drive";
}

/**
 * The account shape copied onto a code/token row.
 * @param {{id: string, name?: string, email?: string}} account
 */
export function accountFields(account) {
  return {
    id: account.id,
    name: typeof account.name === "string" && account.name.length > 0 ? account.name : account.id,
    email: typeof account.email === "string" ? account.email : "",
  };
}
