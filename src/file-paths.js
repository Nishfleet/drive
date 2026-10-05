// Drive paths and the drive's own folders (.trash, .branches), with the
// one validator the browser's path passes through, the words for every
// answer and the trash and restore helpers the Recently deleted screen
// uses. Extracted from src/files.js (drive issue #617) with no
// behaviour change; src/files.js re-exports every name here, so no
// importer moved.

/** @typedef {import("./file-store.js").FileEntry} FileEntry */
export const CONTROL_OR_BACKSLASH = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}\\\\]`,
);
/** The same control range with a slash in it, for a name the browser hands over. */
export const CONTROL_OR_SLASH = new RegExp(
  `[/\\\\${String.fromCharCode(0)}-${String.fromCharCode(31)}]`,
  "g",
);
/** The folder a deleted file is parked in so Recently deleted can put it back. */
export const TRASH_FOLDER = ".trash";
/** The drive path of that folder. */
export const TRASH_PATH = `/${TRASH_FOLDER}`;
/**
 * The folder every branch of this drive is copied into (build step 7,
 * drive#8). It lives here beside the trash folder because this is the one
 * module that knows which folders are the drive's own rather than a person's:
 * both are hidden in the drive root, and deeper in the tree both are an
 * ordinary folder. `BRANCHES_PATH` is the drive path, and src/branches.js copies
 * folders there and walks `.branches` on its own side, so a branch's own copy
 * can never be walked into a copy of itself.
 */
export const BRANCHES_FOLDER = ".branches";
/** The drive path branches are copied into. */
export const BRANCHES_PATH = `/${BRANCHES_FOLDER}`;
/** How long a deleted file stays restorable (build-spec.md "Old versions"). */
export const RECENTLY_DELETED_DAYS = 30;

/**
 * A drive path is absolute, uses "/" between segments, and never climbs out of
 * the drive. This is the one validator every path from the browser passes
 * through, so a path cannot reach another account's keys or escape the root.
 * @param {unknown} path
 * @returns {{path: string, error?: undefined}|{path: "", error: string}} the
 *   drive path, or a result whose `error` is the sentence to show. Both arms
 *   carry a `path` (the error arm an empty one) and `error` is the
 *   discriminant, so the `if (checked.error) return …` every call site already
 *   writes narrows `checked.path` to a string on the other side.
 */
export function validatePath(path) {
  if (typeof path !== "string" || path.length === 0) {
    return { path: "", error: "Send a file path." };
  }
  if (path.length > 1024) {
    return { path: "", error: "That path is too long." };
  }
  if (!path.startsWith("/")) {
    return { path: "", error: "Paths start with a slash." };
  }
  if (path === "/") {
    return { path: "/" };
  }
  if (CONTROL_OR_BACKSLASH.test(path)) {
    return { path: "", error: "That path contains a character we cannot use." };
  }
  const segments = path.split("/").slice(1);
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return { path: "", error: "That path is not valid." };
    }
  }
  return { path: `/${segments.join("/")}` };
}

/**
 * A listing as the page shows it: folders first, then files, each sorted by
 * name the way a person reads them (case-insensitive, numbers in order).
 * @param {unknown} entries
 * @returns {Array<{name: string, kind?: string}>}
 */
export function sortEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("sortEntries needs an array of entries");
  }
  /** @param {{name: string, kind?: string}} entry */
  const rank = (entry) => (entry.kind === "folder" ? 0 : 1);
  return [...entries].sort((a, b) => {
    if (rank(a) !== rank(b)) {
      return rank(a) - rank(b);
    }
    return String(a.name).localeCompare(String(b.name), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

/**
 * Split a listing into the two groups the page renders.
 * @param {Array<{name: string, kind?: string}>} entries
 * @returns {{folders: Array<{name: string, kind?: string}>, files: Array<{name: string, kind?: string}>}}
 */
export function splitEntries(entries) {
  const folders = entries.filter((entry) => entry.kind === "folder");
  const files = entries.filter((entry) => entry.kind !== "folder");
  return { folders: sortEntries(folders), files: sortEntries(files) };
}

/** The folders the drive keeps for itself: hidden in the drive root, and
 * skipped by every walk that builds a copy of a person's files
 * (src/branches.js) or an index of them (src/search.js). */
export const SYSTEM_FOLDERS = Object.freeze([TRASH_FOLDER, BRANCHES_FOLDER]);

/**
 * A drive listing without the folders the drive keeps for itself.
 * Recently deleted is its own tab, so a person should never meet the `.trash`
 * folder as a folder they can open and a row they have to walk past, and
 * `drive branches` is its own command, so `.branches` is not a folder a person
 * opens. Both are hidden in the drive root only, so a file of that name deeper
 * in the tree is still an ordinary folder.
 * @param {FileEntry[]} entries
 * @param {string} path the drive path the listing was for
 */
export function withoutTrash(entries, path) {
  if (path !== "/") {
    return entries;
  }
  return entries.filter(
    (entry) => !(entry.kind === "folder" && SYSTEM_FOLDERS.includes(entry.name)),
  );
}

/**
 * The child path a file is parked under when deleted, relative to the trash
 * folder. The original path IS the key (drive#570): a deleted `/Photos/a.txt`
 * lives at `.trash/Photos/a.txt/<ts>`, so every version of one path shares
 * one prefix and restoring it is one narrow LIST instead of a walk of the
 * whole trash. The deleted-at time is the last segment, so Recently deleted
 * can say when, and two versions of one path order by key next to each other.
 * @param {string} path a validated drive path
 * @param {number} at epoch milliseconds
 */
export function trashName(path, at) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new TypeError(`trashName needs a drive path, got ${String(path)}`);
  }
  if (!Number.isFinite(at) || at <= 0) {
    throw new TypeError(`trashName needs a deleted-at time, got ${String(at)}`);
  }
  return `${path.slice(1)}/${at}`;
}

/**
 * The reverse: the drive path and deleted-at time a trash name carries, or
 * null for anything that is not one of ours. The name is the key relative to
 * the trash folder, `<original path>/<ts>`; the last segment is the time and
 * everything before it is the path that was deleted. A name still in the old
 * flat layout (`<ts>__<encoded path>`, the shape before drive#570) parses
 * too: nothing writes it now, but a file parked under it stays visible in
 * Recently deleted and restorable, and the purge that walks the whole
 * trash (drive#521) reclaims it on its own schedule.
 * @param {unknown} name
 */
export function parseTrashName(name) {
  if (typeof name !== "string") {
    return null;
  }
  const flat = parseFlatTrashName(name);
  if (flat) {
    return flat;
  }
  const cut = name.lastIndexOf("/");
  if (cut <= 0) {
    return null;
  }
  const at = Number(name.slice(cut + 1));
  if (!Number.isFinite(at) || at <= 0 || !/^[0-9]+$/.test(name.slice(cut + 1))) {
    return null;
  }
  const checked = validatePath(`/${name.slice(0, cut)}`);
  if (checked.error) {
    return null;
  }
  return { path: checked.path, deletedAt: at };
}

/**
 * The flat trash layout that shipped before drive#570: `<ts>__<encoded
 * path>`, one key directly under `.trash`. Nothing writes it now, so this
 * exists only to read the keys that are already parked. The separator is
 * the first `__` because an encoded path cannot contain one: `encodeURI`
 * escapes `_`? no — `_` is unreserved, but `__` cannot appear because the
 * writer put exactly one between the time and the encoded path, and the
 * encoded path keeps any `_` it had after that first separator, so the
 * first `__` is the one that splits them. `undefined` (not null) marks
 * "not the flat layout", so a caller that also tries the nested layout can
 * fall through; `null` marks "flat-shaped but unparseable", which stays
 * unreachable because no writer ever produced an invalid one.
 * @param {string} name
 * @returns {{path: string, deletedAt: number}|null|undefined}
 */
export function parseFlatTrashName(name) {
  const cut = name.indexOf("__");
  if (cut <= 0) {
    return undefined;
  }
  const at = Number(name.slice(0, cut));
  if (!Number.isFinite(at) || at <= 0 || !/^[0-9]+$/.test(name.slice(0, cut))) {
    return undefined;
  }
  let path;
  try {
    path = decodeURIComponent(name.slice(cut + 2));
  } catch {
    return undefined;
  }
  const checked = validatePath(path);
  if (checked.error) {
    return undefined;
  }
  return { path: checked.path, deletedAt: at };
}

/**
 * The drive path of a parked file.
 * @param {string} name
 * @returns {string}
 */
export function trashStorePath(name) {
  return `${TRASH_PATH}/${name}`;
}

/**
 * The parked name for a drive path, newest first, or null when that path is
 * not in Recently deleted.
 * @param {Array<{name: string}>} entries the trash listing
 * @param {string} path the drive path to find
 */
export function findTrashName(entries, path) {
  let found = null;
  for (const entry of entries) {
    const parsed = parseTrashName(entry.name);
    if (parsed && parsed.path === path && (!found || parsed.deletedAt > found.deletedAt)) {
      found = { name: entry.name, ...parsed };
    }
  }
  return found;
}

/**
 * Whether a deleted file is still inside the window the page promises.
 * @param {number} deletedAt epoch milliseconds
 * @param {number} now epoch milliseconds
 */
export function isRestorable(deletedAt, now = Date.now()) {
  const age = now - deletedAt;
  return age >= 0 && age <= RECENTLY_DELETED_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * A time as a person reads it: today shows the clock, this year shows the day
 * and month, older shows the year too. `now` is injected so the tests pin one.
 * @param {string|number|Date} value
 * @param {number} now
 */
export function formatWhen(value, now = Date.now()) {
  // A Date's own epoch value; a number is already epoch milliseconds. Date.parse
  // takes the string, so the union is narrowed to the form it can parse.
  const time =
    typeof value === "number" ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new TypeError(`formatWhen needs a date, got ${String(value)}`);
  }
  const date = new Date(time);
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) {
    return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The day a deleted file leaves Recently deleted, in words.
 * @param {number} deletedAt epoch milliseconds
 * @returns {string}
 */
export function restorableUntil(deletedAt) {
  const until = deletedAt + RECENTLY_DELETED_DAYS * 24 * 60 * 60 * 1000;
  return `Restorable until ${new Date(until).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  })}.`;
}
