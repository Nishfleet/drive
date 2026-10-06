// Key-row access helpers. Extracted from workers/api/src/keystore.js
// (drive issue #617) with no behaviour change; keystore.js re-exports them.

import { CAPABILITIES_BY_KIND, keyTtlSeconds, renewTtlSeconds } from "./keyprovider.js";

/** @typedef {import("./keystore.js").Device} Device */

/**
 * The hour, restarted: the expiry a live credential carries after a request at
 * `at`. This is the one renewal rule, written once so the in-memory stand-in
 * (keystore.js `authenticate`) and the D1 store (devices.js `authenticate`)
 * cannot renew by two different amounts, and a test can name it.
 *
 * Two cases do not renew, and both are deliberate:
 *
 *   - A kind with no lifetime (`KEY_TTL_SECONDS[kind] === null`) has nothing
 *     to renew, so the row is handed back untouched. A person's own device
 *     key must not grow an expiry because a request came in.
 *   - A revoked row is never renewed. Revocation is checked before this runs
 *     in both stores, so this is the second gate, not the only one: a
 *     cancelled agent cannot have its hour restarted by a request that
 *     arrived first.
 *
 * The window length is the lifetime this row's own mint gave it, with the
 * kind's hour as the ceiling (keyprovider.js `renewTtlSeconds`), so a
 * renewal can never hand out a longer life than the mint did — a provider
 * session of 15 minutes is not renewed into an hour. A row's capabilities are
 * not touched here at all — renewing is about time, never about powers.
 *
 * A renewal also never shortens the window the row already carries. Two
 * requests can read the same row and renew in either order, and a write that
 * lands second must not pull the hour back to the earlier one's value: a key
 * that is something is using is the one thing this must not cut short. The
 * rule is written once here rather than in each store's SQL, so the answer a
 * store returns and the row it wrote are the same claim.
 * @param {Device} device
 * @param {number} at epoch seconds, the injected clock's now
 * @returns {Device} the row with its expiry moved to `at + ttl`
 */
export function renewKeyWindow(device, at) {
  const ceiling = keyTtlSeconds(device.kind);
  if (ceiling === null || device.revokedAt !== null) {
    return device;
  }
  const next = at + renewTtlSeconds(device, ceiling);
  const held = device.expiresAt;
  const expiresAt = held === undefined || held === null ? next : Math.max(next, held);
  return { ...device, expiresAt };
}

/**
 * A device row with nothing secret in it: what /v1/keys returns.
 * @param {Device} device
 */
export function publicDevice(device) {
  return {
    keyId: device.id,
    name: device.name,
    kind: device.kind,
    prefix: device.prefix,
    capabilities: device.capabilities,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
    expiresAt: device.expiresAt ?? null,
  };
}

/**
 * Whether a path is inside the key's own prefix. The prefix is the safety
 * boundary (keyprovider.js `scopeFor`): a key may only ever name a path under
 * its own account folder, so a path that escapes it is a refusal, and `..`
 * or a leading slash are the shapes that would escape it. The path is
 * returned normalized (no leading slash) so callers compare one form.
 * @param {{prefix: string}} device
 * @param {unknown} rawPath
 * @returns {{path: string}|{error: string}}
 */
export function authorizePath(device, rawPath) {
  const path = typeof rawPath === "string" ? rawPath.replace(/^\/+/, "") : "";
  if (path.split("/").includes("..")) {
    return { error: "outside-prefix" };
  }
  if (!path.startsWith(device.prefix)) {
    return { error: "outside-prefix" };
  }
  return { path };
}

/**
 * Whether a key may delete. An agent, s3 or branch key may not
 * (docs/build-spec.md, "Keys and safety"); the one table is the source, so a
 * corrupted row cannot grant it. A row that carries its own capabilities wins
 * over the kind's: a team key (drive#20) is minted with the `device` kind so
 * the kind table's lookup still answers, but its row lists the role's own
 * capabilities, and a read-only member's key must not read as delete-capable
 * because of the label. A row with no capabilities field (the tests' bare
 * `{kind}` shape) falls back to the kind table.
 * @param {{kind: string, capabilities?: string[]}} device
 */
export function canDelete(device) {
  if (Array.isArray(device.capabilities)) {
    return device.capabilities.includes("delete");
  }
  const kind = /** @type {import("./keyprovider.js").KeyKind} */ (device.kind);
  return CAPABILITIES_BY_KIND[kind].includes("delete");
}
