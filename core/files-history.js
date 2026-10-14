import { json, readJsonObject } from "./http.js";
import { failureMessage } from "./messages.js";
import { HIDDEN_VERSION_DAYS } from "./s3.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** @typedef {import("./files-scope.js").FileStore} FileStore */

/**
 * The earlier copies of one file that can still be restored.
 * @param {FileStore} store the account's scoped store
 * @param {string} path a validated drive path
 * @param {number} now
 * @param {number} days the account's history window
 */
async function earlierCopies(store, path, now, days) {
  const all = await store.listVersions(path, { exact: true });
  return all
    .filter(
      (version) =>
        version.path === path &&
        version.hiddenAt !== null &&
        version.deletedAt == null &&
        now < version.hiddenAt + days * DAY_MS,
    )
    .sort((a, b) => Number(b.hiddenAt) - Number(a.hiddenAt));
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {FileStore} store
 * @param {number} now
 * @param {(value: string) => {error?: string, path: string}} validate
 * @param {number} [days] the account's history window
 * @returns {Promise<Response>}
 */
export async function versionsRequest(
  request,
  url,
  store,
  now,
  validate,
  days = HIDDEN_VERSION_DAYS,
) {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed. GET the file's versions." }, 405);
  }
  const checked = validate(url.searchParams.get("path") || "");
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  const copies = await earlierCopies(store, checked.path, now, days);
  return json({
    path: checked.path,
    versions: copies.map((version) => ({
      versionId: version.b2FileId,
      size: version.sizeBytes,
      savedAt: new Date(version.createdAt).toISOString(),
      replacedAt: new Date(Number(version.hiddenAt)).toISOString(),
      restorableUntil: new Date(Number(version.hiddenAt) + days * DAY_MS).toISOString(),
    })),
  });
}

/**
 * @param {Request} request
 * @param {FileStore} store
 * @param {number} now
 * @param {(value: string) => {error?: string, path: string}} validate
 * @param {number} [days] the account's history window
 * @returns {Promise<Response>}
 */
export async function restoreVersionRequest(
  request,
  store,
  now,
  validate,
  days = HIDDEN_VERSION_DAYS,
) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed. POST the version to restore." }, 405);
  }
  const read = await readJsonObject(request);
  if ("error" in read) {
    return json({ error: failureMessage("json-object-needed") }, 400);
  }
  const { body } = read;
  const checked = validate(String(body.path ?? ""));
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  const versionId = typeof body.versionId === "string" ? body.versionId : "";
  const wanted = (await earlierCopies(store, checked.path, now, days)).find(
    (version) => version.b2FileId === versionId,
  );
  if (!wanted) {
    return json({ error: failureMessage("file-not-found") }, 404);
  }
  try {
    await store.copy(checked.path, checked.path, wanted.sizeBytes, { versionId });
  } catch (cause) {
    return json({ error: `We could not restore that copy: ${String(cause)}` }, 500);
  }
  return json({ ok: true, path: checked.path, size: wanted.sizeBytes });
}
