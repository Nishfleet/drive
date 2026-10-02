// The optional notes starter (drive issue #15): a ready-made Obsidian-shaped
// vault a person can choose to create in their own drive, and the one endpoint
// that creates it.
//
// Two rules shape every line here, and both come from the issue itself:
//
//   - Optional, and off by default. Nothing calls `createStarter`. The only
//     caller is POST /api/starter, which is behind the same account gate as
//     every other route that names files (src/index.js `accountGate`), so the
//     starter exists only after a signed-in person asks for it. The test that
//     walks the module's callers fails if that ever stops being true.
//   - It never requires anything. Every file is written into a folder of the
//     caller's own making, and re-running it only fills in what is missing, so
//     a person who already has a `Notes` folder is never overwritten.
//
// The template's words live here, not in the page. public/starter.html is a
// static asset that cannot import this module, so test/starter.test.mjs reads
// the shipped page and fails CI when its copy, its endpoint or its file list
// drift from here — the same gate test/signin.test.mjs runs for src/signin.js
// and test/usage.test.mjs for src/usage.js.
//
// No price is written down here. The one line the page shows about cost comes
// from src/pricing.js (PRICE), the single price source, so a re-priced product
// moves this page and the pricing page together.
import { agentCannotDeleteSentence } from "./docs.js";
import { validatePath } from "./files.js";
import { failureMessage } from "./messages.js";

/** The page, served from public/starter.html by the asset layer. */
export const STARTER_PATH = "/starter";
/** The one endpoint the page posts to. */
export const STARTER_ENDPOINT = "/api/starter";

/** The folder the starter writes into. A person who already has one keeps it. */
export const STARTER_FOLDER = "/Notes";

/**
 * The one action the endpoint accepts. A GET is the describe, not the create:
 * reading the starter must never be able to write it, so "create" is the only
 * word in a body that changes the drive.
 */
export const STARTER_ACTION = "create";

/**
 * The files a fresh starter writes, in the order it writes them. Every path is
 * inside STARTER_FOLDER, and `starterFiles` re-checks that on every call, so a
 * later edit that moves one out of the folder fails the module's own test
 * rather than scattering files across a drive.
 *
 * Each is small and plain: one folder, four Markdown files, no binary assets,
 * so the starter costs a person nothing to store and nothing to delete.
 */
export const STARTER_FILE_LIST = Object.freeze([
  Object.freeze({
    path: `${STARTER_FOLDER}/README.md`,
    contentType: "text/markdown; charset=utf-8",
    body: `# Notes

This folder is on your drive, so it syncs to every machine you sign in on and
your agent reads and writes the same files you do.

Open your drive folder in Obsidian as a vault, or point your notes app at this
folder. Nothing here is required: delete any file you do not want and it goes
to Recently deleted, where one tap puts it back.

- \`Inbox.md\` is where a thought lands before it is filed.
- \`Templates/Daily note.md\` is the note Obsidian's daily-notes plugin starts.
- \`AGENTS.md\` is the note an agent reads when it works in this folder.
`,
  }),
  Object.freeze({
    path: `${STARTER_FOLDER}/Inbox.md`,
    contentType: "text/markdown; charset=utf-8",
    body: `# Inbox

Anything you have not filed yet. Move a line into a note and delete the line.
`,
  }),
  Object.freeze({
    path: `${STARTER_FOLDER}/Templates/Daily note.md`,
    contentType: "text/markdown; charset=utf-8",
    body: `---
date: {{date:YYYY-MM-DD}}
---

# {{date:YYYY-MM-DD}}

-
`,
  }),
  Object.freeze({
    path: `${STARTER_FOLDER}/AGENTS.md`,
    contentType: "text/markdown; charset=utf-8",
    body: `# Notes, for an agent

These notes are in the user's Drive folder. Treat them as their files.

- Read and write freely in this folder, and anywhere else on the drive.
- ${agentCannotDeleteSentence()} If you decide a file is finished, leave it in
  place. A person decides what leaves the drive.
- Before a large edit, take a branch: \`drive branch\` copies the folder, and
  \`drive approve\` or \`drive discard\` decides what happens to the copy.
- One note per idea, in Markdown, with the note's own filename as its title.
`,
  }),
]);

/** @returns {ReadonlyArray<{path: string, contentType: string, body: string}>} */
export function starterFiles() {
  for (const file of STARTER_FILE_LIST) {
    const checked = validatePath(file.path);
    if (checked.error) {
      throw new Error(
        `the starter's ${file.path} is not a drive path: ${checked.error}`,
      );
    }
    if (!checked.path.startsWith(`${STARTER_FOLDER}/`)) {
      throw new Error(
        `the starter's ${file.path} is outside ${STARTER_FOLDER}; every file it writes belongs to the folder it names`,
      );
    }
  }
  return STARTER_FILE_LIST;
}

/**
 * What the page shows and what the endpoint answers. The `what`/`next` pairs
 * are the shape every other surface in this repo uses for a state (build-spec.md
 * "Nothing missing"): what happened, then the one thing to do next.
 */
export const STARTER_COPY = Object.freeze({
  title: "Notes starter",
  // The issue's own constraint, in the customer's words, on the page itself:
  // optional and off by default, never required.
  lede: "Optional. Off by default, and never required.",
  ledeNext: "Create it only if you want it. Your drive is the same either way.",
  intro:
    "A ready-made notes folder: a vault your notes app can open, a starter inbox and daily note, and one note your agent reads when it works with you.",
  noCard: "No card asked.",
  button: "Create the notes starter",
  working: "Creating…",
  // What a create answers, in the same `what`/`next` shape.
  created: Object.freeze({
    what: "Your notes starter is in the drive.",
    next: "Open your drive folder and point your notes app at the Notes folder.",
  }),
  // A second create, which only fills in what is missing and leaves the rest.
  refilled: Object.freeze({
    what: "Your notes starter is already here.",
    next: "The missing files were added; the ones you have are untouched.",
  }),
  nothingCreated: Object.freeze({
    what: "Nothing was missing, so nothing changed.",
    next: "The starter is already in your drive.",
  }),
  failed: Object.freeze({
    what: "The starter could not be written.",
    next: failureMessage("unexpected").split(" ").slice(1).join(" "),
  }),
  // The list the page shows before the button, one line per file, so a person
  // can see what they are agreeing to.
  filesHeading: "What it writes",
  filesNext: "Four files, all inside one Notes folder. Delete any you do not want.",
});

/**
 * The one body the endpoint accepts. Anything else is refused, so a stray key
 * in a request cannot be read as a different action and a GET's own read is
 * never a write.
 * @param {unknown} body
 * @returns {{action: string}|{error: string}}
 */
export function readStarterRequest(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Send a JSON object." };
  }
  if (body.action !== STARTER_ACTION) {
    return { error: `Send action: ${STARTER_ACTION}.` };
  }
  return { action: STARTER_ACTION };
}

/**
 * Write the starter into one account's scoped store, only the files that are
 * not there yet. A person who already has a Notes folder keeps every byte of
 * it: the write is a fill-in, never an overwrite, so creating the starter
 * twice is safe and creating it after you have started is safe.
 *
 * `store` is the account's own scoped store (src/files.js `scopeStore`), so
 * the paths below are drive paths and the account prefix is applied by the
 * scope, not by this function. Every write goes through `store.write`, which
 * is the one paved writer in this repo — there is no second way to put a file
 * in a drive.
 *
 * @param {import("./files.js").FileStore} store
 * @returns {Promise<{created: string[], kept: string[]}>}
 */
export async function createStarter(store) {
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
    throw new TypeError("createStarter needs a scoped store with read and write");
  }
  /** @type {string[]} */
  const created = [];
  /** @type {string[]} */
  const kept = [];
  for (const file of starterFiles()) {
    const existing = await store.read(file.path);
    if (existing) {
      kept.push(file.path);
      continue;
    }
    await store.write(file.path, new Blob([file.body]).stream(), file.contentType);
    created.push(file.path);
  }
  return { created, kept };
}

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS },
  });
}

/**
 * @param {string} message
 * @param {number} status
 * @returns {Response}
 */
function plain(message, status) {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The starter's one route. A GET describes the template and writes nothing,
 * which is what makes the starter off by default: there is no path here that
 * creates it without a POST carrying `action: "create"`, and no caller in this
 * module or the Worker that does so on its own.
 *
 * The account gate and the browser CSRF check are the Worker's (src/index.js
 * registers this under `/api/*` with `accountGate` and `csrfWhenBrowser`), so
 * an anonymous caller is answered 401 before this function runs and a
 * cross-site POST is answered by the middleware, not by a hand-rolled rule
 * here. `store` is the account's own scoped store.
 *
 * @param {Request} request
 * @param {import("./files.js").FileStore|null} store
 * @param {{id: string, name?: string}|null} account
 * @returns {Promise<Response>}
 */
export async function handleStarterRequest(request, store, account) {
  // The gate normally answers this before the handler is reached. The check is
  // here as well so the handler is safe when it is called directly, exactly as
  // every other handler in this repo does it.
  if (!account) {
    return json({ error: failureMessage("unauthorized") }, 401);
  }
  if (!store) {
    return json({ error: failureMessage("drive-not-configured") }, 503);
  }

  if (request.method === "GET") {
    // Describe only. The starter is off by default, so reading what it would
    // write must not write it.
    const files = starterFiles().map((file) => file.path);
    return json({
      ok: true,
      action: STARTER_ACTION,
      folder: STARTER_FOLDER,
      files,
      copy: STARTER_COPY,
    });
  }

  if (request.method !== "POST") {
    return plain("Method not allowed. POST to create it.", 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "The request body is not valid JSON." }, 400);
  }
  const read = readStarterRequest(body);
  if (read.error) {
    return json({ error: read.error }, 400);
  }

  let result;
  try {
    result = await createStarter(store);
  } catch (cause) {
    // A store that failed is not a starter that was half created and is not a
    // success: the route says the write failed and names nothing it cannot
    // stand behind.
    return json(
      {
        error: STARTER_COPY.failed.what,
        next: STARTER_COPY.failed.next,
        detail: cause instanceof Error ? cause.message : String(cause),
      },
      500,
    );
  }

  const state =
    result.created.length === 0
      ? STARTER_COPY.nothingCreated
      : result.kept.length === 0
        ? STARTER_COPY.created
        : STARTER_COPY.refilled;
  return json({
    ok: true,
    folder: STARTER_FOLDER,
    created: result.created,
    kept: result.kept,
    what: state.what,
    next: state.next,
    copy: STARTER_COPY,
  });
}