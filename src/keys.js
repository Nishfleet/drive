// What a key can and cannot do (drive issue #98).
//
// The powers are decisions from docs/build-spec.md ("Keys and safety"), and
// they are read from one place: workers/api/src/keyprovider.js holds the one
// kind-to-capabilities table, and src/cap.js already re-exports it so the
// pricing Worker and the api Worker cannot disagree. This module adds nothing
// of its own; it turns that table into the plain booleans the docs pages need,
// so the Security and Agents pages and the enforcement code read the same
// source instead of two copies that can drift.
import { deleteSwitchesFor, IDRIVE_KEY_REACH } from "../workers/api/src/idrive-keys.js";
import { CAPABILITIES_BY_KIND } from "../workers/api/src/keyprovider.js";
import { HIDDEN_VERSION_DAYS } from "../workers/api/src/s3.js";

// The agent tools `drive init` connects. The CLI's own list is in Go
// (cmd/drive/tools.go); the docs cannot import Go, so the list is declared
// once here in the order the CLI prints it, and test/docs.test.mjs pins the two
// lists to each other, so adding a tool in Go without the docs fails CI.
export const AGENT_TOOLS = Object.freeze(["claude", "codex", "gemini", "cursor", "kiro"]);

/** @typedef {{canRead: boolean, canWrite: boolean, canDelete: boolean, capabilities: ReadonlyArray<string>}} Powers */

/**
 * The powers one key kind has, as the plain booleans a person reads. A kind
 * that is not in the table is an error rather than an empty set of powers: a
 * typo would otherwise read as "cannot do anything", which is a different
 * claim from "no such key".
 * @param {"device"|"agent"|"s3"|"branch"} kind
 * @returns {Powers}
 */
function powersFor(kind) {
  const capabilities = CAPABILITIES_BY_KIND[kind];
  if (!capabilities) {
    throw new TypeError(`no such key kind: ${String(kind)}`);
  }
  return {
    canRead: capabilities.includes("read"),
    canWrite: capabilities.includes("write"),
    canDelete: capabilities.includes("delete"),
    capabilities,
  };
}

// The two kinds a person actually meets: their own device key and the key an
// agent tool gets. Both read the same table the api Worker enforces.
export const KEY_POWERS = Object.freeze({
  device: powersFor("device"),
  agent: powersFor("agent"),
  s3: powersFor("s3"),
  branch: powersFor("branch"),
});

/**
 * What the storage provider itself enforces on one key kind (drive#502).
 * powersFor() is what the api Worker grants. This is what the key can really
 * do once it talks to iDrive e2 directly, read from the switches the mint
 * sends (workers/api/src/idrive-keys.js) and the bucket's hidden-version rule
 * (workers/api/src/s3.js). The docs state these, not the capability table,
 * wherever the two differ.
 * @typedef {{
 *   canDelete: boolean,
 *   canDestroyHidden: boolean,
 *   undoDays: number,
 *   reachesWholeDrive: boolean,
 * }} StoragePowers
 * @param {"device"|"agent"|"s3"|"branch"} kind
 * @returns {StoragePowers}
 */
export function storagePowersFor(kind) {
  const switches = deleteSwitchesFor(powersFor(kind).capabilities);
  return {
    // The provider refuses a delete only when the mint sets this switch.
    canDelete: !switches.disable_delete_object,
    // Whether the key can also remove the hidden copy a delete leaves.
    canDestroyHidden: !switches.disable_delete_version,
    // How long a delete by this key can be undone. A key that can destroy the
    // hidden copy gives no guarantee, so that is zero.
    undoDays: switches.disable_delete_version ? HIDDEN_VERSION_DAYS : 0,
    // A key limited to a bucket reaches every file in the account's bucket.
    reachesWholeDrive: IDRIVE_KEY_REACH === "bucket",
  };
}

export const STORAGE_POWERS = Object.freeze({
  device: storagePowersFor("device"),
  agent: storagePowersFor("agent"),
  s3: storagePowersFor("s3"),
  branch: storagePowersFor("branch"),
});
