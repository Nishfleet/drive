import { deleteSwitchesFor, IDRIVE_KEY_REACH } from "../core/idrive-keys.js";
import { CAPABILITIES_BY_KIND } from "../core/keyprovider.js";
import { HIDDEN_VERSION_DAYS } from "../core/s3.js";

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
function storagePowersFor(kind) {
  const switches = deleteSwitchesFor(powersFor(kind).capabilities);
  return {
    canDelete: !switches.disable_delete_object,
    canDestroyHidden: !switches.disable_delete_version,
    undoDays: switches.disable_delete_version ? HIDDEN_VERSION_DAYS : 0,
    reachesWholeDrive: IDRIVE_KEY_REACH === "bucket",
  };
}

export const STORAGE_POWERS = Object.freeze({
  device: storagePowersFor("device"),
  agent: storagePowersFor("agent"),
  s3: storagePowersFor("s3"),
  branch: storagePowersFor("branch"),
});
