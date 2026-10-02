// Storage access goes through a KeyProvider so the stand-in and the real
// iDrive e2 / Backblaze B2 implementations are interchangeable.

/**
 * What a key may do. `delete` is the only difference between a person's device
 * key and every agent-facing key (docs/build-spec.md, "Keys and safety").
 * @typedef {"list"|"read"|"write"|"delete"} Capability
 * @typedef {{prefix: string, capabilities: ReadonlyArray<Capability>}} KeyScope
 *
 * The secret is shown once and never stored by the api.
 * @typedef {{keyId: string, accessKeyId: string, secret: string}} MintedKey
 *
 * @typedef {object} KeyProvider
 * @property {(scope: KeyScope) => Promise<MintedKey>} mint
 * @property {(keyId: string) => Promise<void>} revoke
 * @property {(keyId: string) => Promise<MintedKey>} swapToReadOnly Replaces a
 *   write-capable key with a read-only one on the same prefix (cap reached).
 */

/** @typedef {"device"|"agent"|"s3"|"branch"} KeyKind */

/** @type {ReadonlyArray<KeyKind>} */
export const KEY_KINDS = ["device", "agent", "s3", "branch"];

/**
 * The one kind to capabilities table (docs/build-spec.md, "Keys and safety").
 * It is declared here and nowhere else: scopeFor() below builds storage scopes
 * from it, and the pricing Worker's cap logic (src/cap.js) re-exports this same
 * frozen object as WRITE_SCOPE_BY_KIND instead of keeping a second copy, so a
 * kind cannot end up with different powers in two places. The import crosses
 * the two src trees on purpose (drive#77): each Worker bundles its own module
 * copy at build time, so there is never one shared mutable instance at runtime,
 * and a change to the table reaches both Workers from this one file.
 * @type {Readonly<Record<KeyKind, ReadonlyArray<Capability>>>}
 */
export const CAPABILITIES_BY_KIND = Object.freeze({
  device: Object.freeze(
    /** @type {ReadonlyArray<Capability>} */ (["list", "read", "write", "delete"]),
  ),
  agent: Object.freeze(/** @type {ReadonlyArray<Capability>} */ (["list", "read", "write"])),
  s3: Object.freeze(/** @type {ReadonlyArray<Capability>} */ (["list", "read", "write"])),
  branch: Object.freeze(/** @type {ReadonlyArray<Capability>} */ (["list", "read", "write"])),
});

/** @typedef {"read_only"|"read_write"} TeamRole */

/** @type {ReadonlyArray<TeamRole>} */
export const TEAM_ROLES = ["read_only", "read_write"];

/**
 * The one role to capabilities table for a team member (drive#20). A team key
 * is scoped to the team prefix `t/<teamId>/` rather than an account folder,
 * and the role is what decides its powers: a read-only member may list and
 * read the shared drive and may not write it. Declared here and nowhere else,
 * for the same reason CAPABILITIES_BY_KIND is: `teamScopeFor()` below builds
 * the scope from this table, and the storage write route reads a device's own
 * row rather than a second copy of the rule, so a role cannot end up with two
 * different powers in two places.
 * @type {Readonly<Record<TeamRole, ReadonlyArray<Capability>>>}
 */
export const TEAM_ROLE_CAPABILITIES = Object.freeze({
  read_only: Object.freeze(/** @type {ReadonlyArray<Capability>} */ (["list", "read"])),
  read_write: Object.freeze(
    /** @type {ReadonlyArray<Capability>} */ (["list", "read", "write"]),
  ),
});

// A prefix is the storage safety boundary: whatever lands in it can only ever
// name paths inside one account's folder. `..` and `/` are what would point a
// prefix outside it, so neither character set admits them, and the length cap
// keeps a junk id from becoming a junk key name upstream.
const ACCOUNT_ID_SAFE = /^[A-Za-z0-9_-]{1,64}$/;
const BRANCH_NAME_SAFE = /^[A-Za-z0-9_.-]{1,64}$/;
// A team id is the same shape as an account id (`newId("team")` makes
// `team_<hex>`), so it is checked with the same rule: it goes into the shared
// prefix, and a `/` or `..` in it would point that prefix at another drive.
const TEAM_ID_SAFE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {unknown} accountId
 * @returns {string}
 */
function checkedAccountId(accountId) {
  if (typeof accountId !== "string" || !ACCOUNT_ID_SAFE.test(accountId)) {
    throw new TypeError(
      `An account id is 1 to 64 characters of letters, digits, dash or underscore, got ${JSON.stringify(accountId)}.`,
    );
  }
  return accountId;
}

/**
 * @param {unknown} teamId
 * @returns {string}
 */
function checkedTeamId(teamId) {
  if (typeof teamId !== "string" || !TEAM_ID_SAFE.test(teamId)) {
    throw new TypeError(
      `A team id is 1 to 64 characters of letters, digits, dash or underscore, got ${JSON.stringify(teamId)}.`,
    );
  }
  return teamId;
}

/**
 * @param {unknown} role
 * @returns {TeamRole}
 */
export function checkedTeamRole(role) {
  if (typeof role !== "string" || !TEAM_ROLES.includes(/** @type {TeamRole} */ (role))) {
    throw new TypeError(
      `A team role is one of ${TEAM_ROLES.join(", ")}, got ${JSON.stringify(role)}.`,
    );
  }
  return /** @type {TeamRole} */ (role);
}

/**
 * The scope a team member's key gets: the team prefix `t/<teamId>/` and the
 * capabilities their role carries. The id is checked before it goes in the
 * prefix for the same reason scopeFor() checks the account id: a `..` or a
 * slash would build a prefix pointing at another team's drive.
 * @param {TeamRole} role
 * @param {string} teamId
 * @returns {KeyScope}
 */
export function teamScopeFor(role, teamId) {
  const checked = checkedTeamRole(role);
  return {
    prefix: `t/${checkedTeamId(teamId)}/`,
    capabilities: TEAM_ROLE_CAPABILITIES[checked],
  };
}

/**
 * @param {unknown} name
 * @returns {string}
 */
export function checkedBranchName(name) {
  if (typeof name !== "string" || !BRANCH_NAME_SAFE.test(name) || name.includes("..")) {
    throw new TypeError(
      `A branch name is 1 to 64 characters of letters, digits, dot, dash or underscore, without "..", got ${JSON.stringify(name)}.`,
    );
  }
  return name;
}

/**
 * The scope a kind of key gets for an account. Both the account id and the
 * branch name are checked before they are placed in the prefix: a branch name
 * like `../../x` or `a/b`, or an account id with a slash in it, would build a
 * prefix pointing outside the account's own folder, and this is the one place
 * that would let it.
 * @param {KeyKind} kind
 * @param {string} accountId
 * @param {{name?: string}} [options] `name` is the branch name for branch keys.
 * @returns {KeyScope}
 */
export function scopeFor(kind, accountId, options = {}) {
  if (!KEY_KINDS.includes(kind)) {
    throw new Error(`Unknown key kind: ${kind}. Known kinds: ${KEY_KINDS.join(", ")}.`);
  }
  const home = `u/${checkedAccountId(accountId)}/`;
  const capabilities = CAPABILITIES_BY_KIND[kind];
  if (kind === "branch") {
    if (options === null || typeof options !== "object") {
      throw new TypeError("A branch key needs options with a branch name.");
    }
    if (!options.name) {
      throw new TypeError("A branch key needs a branch name.");
    }
    return {
      prefix: `${home}.branches/${checkedBranchName(options.name)}/`,
      capabilities,
    };
  }
  return { prefix: home, capabilities };
}
