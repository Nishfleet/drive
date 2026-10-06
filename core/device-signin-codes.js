// The device sign-in typedefs, windows and code helpers (drive issue #617:
// split out of device-signin.js, code unchanged). `device-signin.js`
// re-exports every public name here.

/**
 * Any device sign-in store: the shape the routes read. The in-memory
 * implementation is a stand-in; the D1 one is the real store. Every caller
 * awaits, and both implementations are async (the D1 statements are), so the
 * interface below is Promise-only: a stand-in cannot accidentally be read as a
 * plain value, and a caller cannot forget the await and get `undefined`.
 *
 * `approveDeviceCode`'s account is optional because the in-memory store's own
 * older call shape can name one from the device (a deployment with no account
 * store still walks the flow); the D1 store never takes that path, because the
 * approve route is an account route and its account is always the sign-in
 * flow's.
 * @typedef {object} DeviceSigninStore
 * @property {Map<string, {id: string, name: string, email: string|null}>} [accounts]
 *        only the in-memory store holds one, for a test that models a
 *        lost account row
 * @property {(request?: {name?: string}) => Promise<DeviceCodeResult>} requestDeviceCode
 * @property {(userCode: string) => Promise<PendingDeviceApproval|null>} pendingDeviceApproval
 * @property {(userCode: string, account?: {id: string, name?: string, email?: string}) => Promise<ApproveResult>} approveDeviceCode
 * @property {(deviceCode: string) => Promise<PollResult>} pollDeviceCode
 * @property {(token: string) => Promise<{id: string, name: string, email: string|null}|null>} accountForDeviceToken
 * @property {(token: string) => Promise<RevokeResult>} revokeDeviceToken
 * @property {(account: {id: string}) => Promise<{revoked: number}>} revokeAllDeviceTokens
 * @property {(at?: number) => Promise<number>} sweepDeviceTokens
 */

/**
 * A freshly started device code: the CLI's secret and the short code a person
 * types on the approval page.
 * @typedef {{deviceCode: string, userCode: string, expiresIn: number, interval: number}} DeviceCodeResult
 */

/**
 * A pending device code the approval page can name without putting the code
 * in the form. `createdAt` and `expiresAt` are epoch seconds.
 * @typedef {{name: string, createdAt: number, expiresAt: number}} PendingDeviceApproval
 */

/**
 * An approval's answer: the account it attached, or a named refusal.
 * @typedef {{accountId?: string, name?: string, error?: string}} ApproveResult
 */

/**
 * A poll's answer: `pending` until the page approves, then the device token
 * (shown once) and the account it names.
 * @typedef {{status: "unknown"|"expired"|"pending"}|{status: "approved", deviceToken: string, account: {id: string, name: string, email: string|null}}} PollResult
 */

/**
 * A revoke's answer: what the row says, or a named refusal for a token the
 * store never held.
 * @typedef {{revoked: true, expiresAt: number, revokedAt: number}|{error: "not-found"}} RevokeResult
 */

/**
 * A bulk revoke's answer: how many of the account's live tokens went dead. It
 * counts the rows it changed, never the rows it found, so "0" means every
 * token on this account was already dead and the answer is about the new ones.
 * @typedef {{revoked: number}} RevokeAllResult
 */

// How long a device code is good for, and how often the CLI may poll
// (RFC 8628's device_code and interval). Ten minutes is long enough to find a
// phone, short enough that a code left on a terminal screen dies.
export const DEVICE_CODE_TTL_SECONDS = 600;
export const DEVICE_CODE_INTERVAL_SECONDS = 5;

// How long a minted device token is good for. A device token is the CLI's whole
// credential for the account gate, so a token that never dies is a credential a
// leak keeps: the store would hold it until the person deleted their account,
// and the only way to kill it would be to delete that account's keys. Thirty
// days is the session TTL core/auth.js already chose, and for the same reason
// ("the drive is reached on every visit, so signing in every week would be a
// support ticket, not a security win"): a month bounds what a leak is worth
// without asking a person to approve a code every few days. The number is
// written here rather than imported so this module keeps no dependency on the
// account store; keystore.test.js pins the two to each other, so they cannot
// drift into two different months.
export const DEVICE_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

// The user code a person types on the approval page. The alphabet leaves out
// vowels (so a code cannot spell a word) and the look-alike 0/O and 1/I/L
// (so a code read aloud cannot be mistyped into another valid one).
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
      // Reached only when the injected generator returns a high byte; the
      // platform generator (crypto.getRandomValues) feeds it fresh bytes.
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
