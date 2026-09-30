// Storage access goes through a KeyProvider so the stand-in and the real
// iDrive e2 / Backblaze B2 implementations are interchangeable.

/**
 * What a key may do. `delete` is the only difference between a person's device
 * key and every agent-facing key (docs/build-spec.md, "Keys and safety").
 * @typedef {{prefix: string, capabilities: Array<"list"|"read"|"write"|"delete">}} KeyScope
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

export const KEY_KINDS = ["device", "agent", "s3", "branch"];

/**
 * The scope a kind of key gets for an account.
 * @param {"device"|"agent"|"s3"|"branch"} kind
 * @param {string} accountId
 * @param {{name?: string}} [options] `name` is the branch name for branch keys.
 * @returns {KeyScope}
 */
export function scopeFor(kind, accountId, options = {}) {
  const home = `u/${accountId}/`;
  switch (kind) {
    case "device":
      return { prefix: home, capabilities: ["list", "read", "write", "delete"] };
    case "agent":
    case "s3":
      return { prefix: home, capabilities: ["list", "read", "write"] };
    case "branch":
      if (!options.name) {
        throw new Error("A branch key needs a branch name.");
      }
      return {
        prefix: `${home}.branches/${options.name}/`,
        capabilities: ["list", "read", "write"],
      };
    default:
      throw new Error(`Unknown key kind: ${kind}`);
  }
}
