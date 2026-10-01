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

// A prefix is the storage safety boundary: whatever lands in it can only ever
// name paths inside one account's folder. `..` and `/` are what would point a
// prefix outside it, so neither character set admits them, and the length cap
// keeps a junk id from becoming a junk key name upstream.
const ACCOUNT_ID_SAFE = /^[A-Za-z0-9_-]{1,64}$/;
const BRANCH_NAME_SAFE = /^[A-Za-z0-9_.-]{1,64}$/;

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
