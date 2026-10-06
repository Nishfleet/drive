// The version gate (drive#560). The CLI names itself on every request with
// `User-Agent: drive/<version> (<os>/<arch>)` (cmd/drive/api.go), and this
// module reads the version out of that header. A version below the floor this
// deployment still serves is refused with 426 Upgrade Required and the
// message table's cli-too-old words, so an api shape change under an old CLI
// names the fix — `drive update` — instead of surfacing as an answer the old
// CLI cannot read (the api-answer dead end that motivated the issue).
//
// The gate only refuses what it can read as a drive version, and never a
// whole header: a health probe, a browser on a device approval page and an
// unparseable version all pass through to the gates and routes below. The
// floor is MIN_CLI_VERSION in this module. A request env that carries a
// readable MIN_CLI_VERSION uses that instead; an unset or unreadable value
// is the module default, never a silent "serve everyone".
//
// Version compares are the CLI's own compareVersions shape (rclonecheck.go):
// dotted numeric parts, padded with zeros, so 0.9 sorts below 0.10 the way a
// person expects. Build metadata and pre-release dashes are cut before the
// compare, so a `go install ...@main` pseudo-version
// (v0.1.1-0.20261005...-abcdef) is never read as older than the release it is
// built ahead of — a mangled read must not brick the one working tool.

/**
 * The minimum CLI version a deployment serves when it sets none. Raised in
 * the deployment when an api shape changes under it.
 */
export const MIN_CLI_VERSION = "0.1.0";

const DRIVE_USER_AGENT = /^\s*drive\/([^\s/]+)/;

/**
 * The drive version a User-Agent names, or null when the header names none.
 * @param {string|null|undefined} userAgent
 * @returns {string|null}
 */
export function parseDriveVersion(userAgent) {
  if (typeof userAgent !== "string") {
    return null;
  }
  const match = DRIVE_USER_AGENT.exec(userAgent);
  return match === null ? null : match[1];
}

/**
 * A version's dotted numeric parts, or null when the token is not a version at
 * all. The v prefix and anything a pre-release dash or build metadata plus
 * introduces are cut first, so a `go install ...@main` pseudo-version
 * (v0.1.1-0.20261005...-abcdef) is never read as older than the release it is
 * built ahead of. Every remaining part must be a number: a version that cannot
 * be read is refused by nobody, because the one working tool on a machine is
 * often the one built from a working tree.
 * @param {string} version
 * @returns {number[]|null}
 */
function versionParts(version) {
  const numeric = version.replace(/^v/, "").split(/[-+]/, 1)[0];
  const parts = numeric.split(".");
  const values = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    values.push(Number.parseInt(part, 10));
  }
  return values;
}

/**
 * Whether the version is below the floor. A version either side cannot be
 * read is not compared at all, so an unreadable one is never a 426.
 * @param {string} version
 * @param {string} floor
 * @returns {boolean}
 */
export function versionBelowFloor(version, floor) {
  const left = versionParts(version);
  const right = versionParts(floor);
  if (left === null || right === null) {
    return false;
  }
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) {
      return a < b;
    }
  }
  return false;
}

/**
 * The floor this request is judged against: env.MIN_CLI_VERSION when that
 * value is a version this module can read, the module default otherwise. A
 * misconfigured floor must never widen the gate into refusing nothing, so
 * an unreadable one is no setting at all.
 * @param {unknown} env
 * @returns {string}
 */
export function floorFor(env) {
  if (env == null || typeof env !== "object") {
    return MIN_CLI_VERSION;
  }
  const configured = /** @type {{MIN_CLI_VERSION: unknown}} */ (env).MIN_CLI_VERSION;
  if (typeof configured === "string" && versionParts(configured.trim()) !== null) {
    return configured.trim();
  }
  return MIN_CLI_VERSION;
}

/**
 * Whether this request must be answered 426: it names a drive version, and
 * that version is below the deployment's floor.
 * @param {string|null|undefined} userAgent
 * @param {unknown} env
 * @returns {boolean}
 */
export function cliTooOld(userAgent, env) {
  const version = parseDriveVersion(userAgent);
  return version !== null && versionBelowFloor(version, floorFor(env));
}
