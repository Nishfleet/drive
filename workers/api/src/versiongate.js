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
// floor itself is a deployment setting: MIN_CLI_VERSION here is the default,
// and the api Worker's MIN_CLI_VERSION variable overrides it, the same lever
// shape as the site Worker's bindings.text() vars.
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

const DRIVE_USER_AGENT = /^\s*drive\/(\S+)/;

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
 * A version's dotted numeric parts, after the v prefix and anything a
 * pre-release dash or build metadata plus introduces. A part that is not a
 * number reads as 0, the way the CLI's own compare does.
 * @param {string} version
 * @returns {number[]}
 */
function versionParts(version) {
  return version
    .replace(/^v/, "")
    .split(/[-+]/, 1)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

/**
 * Whether the version is below the floor. Equal versions are not: the floor
 * is the oldest build still served.
 * @param {string} version
 * @param {string} floor
 * @returns {boolean}
 */
export function versionBelowFloor(version, floor) {
  const left = versionParts(version);
  const right = versionParts(floor);
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
 * The floor this request is judged against: the deployment's own
 * MIN_CLI_VERSION variable when it sets one, the module default otherwise.
 * @param {unknown} env
 * @returns {string}
 */
export function floorFor(env) {
  const configured = /** @type {{MIN_CLI_VERSION?: unknown}|null|undefined} */ (env)
    ?.MIN_CLI_VERSION;
  if (typeof configured === "string" && configured.trim() !== "") {
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
