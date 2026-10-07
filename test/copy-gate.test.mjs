// The copy gate (drive issue #774, third acceptance bullet): the build fails
// if the copy names a command or a page that does not exist.
//
// Two facts about this repository make the gate necessary and cheap. First,
// the copy is where the promises live: the README, the marketing pages, the
// docs and the agent-facing llms.txt all name commands and link pages, and a
// renamed subcommand or a deleted page used to leave them pointing at nothing
// until somebody clicked. Second, the two things a mention can name are each
// already one file apiece: the command table in cmd/drive/main.go is the one
// place a subcommand exists (the Go-side gates in command_table_test.go hold
// the agent notes and `drive --help` to it, and the docs sample gate in
// docs.test.mjs holds every shell sample to it), and the page a link names is a
// file in public/ (or, for the docs, docs-site/).
//
// So this gate joins those two ends: every backticked `drive <word>` mention on
// a customer surface is a command main can run, and every internal link is a
// file that exists. Both directions are deliberate. A mention of a command that
// was removed fails here; a page that is deleted fails here; and the one
// deliberate mention of a command the drive does not have — the honest note in
// docs/limits that `drive restore` is not in the CLI — is named in the
// allowance below with its reason, so it cannot be broadened into a promise by
// accident.
//
// What this gate does not do: it does not run the pages, and it does not read
// the rendered docs (the authored Markdown is the source, and a page that was
// never built is caught by test/docs.test.mjs, which reads the build's own
// output). It is static, so it runs in the same `node --test` pass as the rest
// of the suite with no browser and no network.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
/** @param {string} rel @returns {string} */
const read = (rel) => readFileSync(join(root, rel), "utf8");

// The surfaces a customer or an agent reads: the pages the site serves, the
// repo's front door, the machine-readable summary, and the docs' own
// Markdown. Kept as a list of files rather than a glob over everything so
// adding a surface is a deliberate edit, the way test/version-1-claims.test.mjs
// freezes its CUSTOMER_SURFACES.
const SURFACES = Object.freeze([
  ...readdirSync(join(root, "public"))
    .filter((name) => name.endsWith(".html"))
    .sort()
    .map((name) => join("public", name)),
  "get-started.html",
  "README.md",
  "public/llms.txt",
  ...readdirSync(join(root, "docs-site"))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join("docs-site", name)),
]);

// The commands that exist, read from the one place a subcommand exists:
// cmd/drive/main.go's table. `version` and `help` are answered by main's own
// switch rather than by an entry in the table (command_table_test.go's
// mainAnswers), so they are real and are added here.
function commandTable() {
  const mainGo = read(join("cmd", "drive", "main.go"));
  const start = mainGo.indexOf("var commands = map[string]func([]string) error{");
  assert.ok(start > 0, "cmd/drive/main.go must declare the command table");
  const body = mainGo.slice(start, mainGo.indexOf("}", start));
  const names = new Set([...body.matchAll(/"([0-9a-z-]+)":/g)].map((m) => m[1]));
  for (const answered of ["version", "help"]) names.add(answered);
  assert.ok(
    names.has("mount") && names.has("undo"),
    `the command table must have been parsed out of main.go; got ${[...names].sort().join(", ")}`,
  );
  return names;
}

// A backticked `drive <word>` mention. Backticks, not any `drive <word>` in
// prose, because the copy uses the word "drive" for the product itself ("the
// drive keeps your files") and only a code span claims a command. The mention
// gate in docs.test.mjs works the same way from the other end: it reads fenced
// shell samples.
const MENTION = /`drive ([0-9a-z][0-9a-z-]*)`/g;

// The mentions this gate allows even though the command does not exist, each
// with the reason, in the same spirit as docs.test.mjs's nonDriveSamples: a
// deliberate negative has to be written down here to ship, and an entry that
// is no longer needed fails the gate below rather than lingering.
const ALLOWED = Object.freeze({
  // limits.md's honest note: the Files page can restore a delete for 30 days,
  // and there is no `restore` command. A page that says a command is absent is
  // the copy doing its job, so the gate has to read the sentence to tell it
  // from a promise — which is why it is an allowance and not a wider regex.
  "docs-site/limits.md:restore":
    'the honest note that `drive restore` is not in the CLI (docs/limits, "No `restore` command yet")',
  // The changelog entry for the day the notes stopped advertising it. History
  // is frozen: the sentence is about what the copy used to say.
  "docs-site/changelog.md:restore":
    "the 2026-10-04 entry recording that the agent notes no longer advertise `drive restore`",
});

test("every `drive <command>` the copy names is a command the CLI runs", () => {
  const table = commandTable();
  const used = new Set();
  let mentions = 0;
  let allowed = 0;
  for (const surface of SURFACES) {
    const text = read(surface);
    for (const match of text.matchAll(MENTION)) {
      mentions += 1;
      const command = match[1];
      if (table.has(command)) continue;
      const key = `${surface}:${command}`;
      if (Object.hasOwn(ALLOWED, key)) {
        used.add(key);
        allowed += 1;
        continue;
      }
      assert.fail(
        `${surface} names \`drive ${command}\`, which is not in cmd/drive/main.go. ` +
          "Rename the mention, add the command, or add an allowance with its reason.",
      );
    }
  }
  assert.ok(mentions >= 20, `the copy must carry the mentions (found ${mentions})`);
  assert.ok(allowed >= 1, "the honest negative about `restore` must still be there to be allowed");
  for (const key of Object.keys(ALLOWED)) {
    assert.ok(
      used.has(key),
      `the allowance for ${key} is no longer needed: the copy no longer names it that way. ` +
        "Delete the entry so the gate keeps checking the mention.",
    );
  }
});

// A link that leaves the site, an anchor into the page it is on, or a route on
// the api Worker rather than a page. None of them is a page this gate can look
// up in the repository, and each is skipped by the same rule everywhere.
const NOT_A_PAGE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/api\/)/i;

// The links the copy writes: an href in HTML, or a Markdown link. A Markdown
// link can carry a title ("(/faq "the FAQ")"), which is not part of the target.
const LINK = /(?:href|src)="([^"]+)"|\]\(([^)\s]+)/g;

/**
 * Where a link points, as a path inside this repository, or null when the
 * link is not a page this gate can check. The rules are the build's own:
 * a page is `public/<name>.html`, `public/<name>/index.html`, or a file that
 * ships whole (an image, a font, the sitemap). The docs are Markdown here
 * rather than the built HTML, because the authored file is the source and a
 * stale build must not be what makes the gate pass; VitePress serves them
 * under /docs/, so a root-absolute link inside a docs page is a docs page.
 * @param {string} file the surface the link was found in, repo-relative
 * @param {string} target the raw link
 * @returns {string|null}
 */
function pageFor(file, target) {
  if (NOT_A_PAGE.test(target) || target.includes("{{")) return null;
  const path = target.split("#")[0].split("?")[0];
  if (path === "") return null;
  if (!path.startsWith("/")) {
    // Relative to the file that wrote it. A `../` that climbs out of the repo
    // is not a page either, and existsSync on it would be an accident.
    const from = resolve(root, dirname(file), path);
    return from.startsWith(root) ? from : null;
  }
  const inDocs = file.startsWith("docs-site/");
  const tail = path.replace(/^\//, "");
  if (!inDocs) {
    if (path === "/" || path === "") return join(root, "public", "index.html");
    if (tail === "docs" || tail === "docs/") return join(root, "docs-site", "index.md");
    if (tail.startsWith("docs/")) {
      return join(root, "docs-site", `${tail.slice("docs/".length).replace(/\/$/, "")}.md`);
    }
  }
  if (tail === "" || tail.endsWith("/")) return join(root, "docs-site", `${tail.slice(0, -1)}.md`);
  return join(root, "docs-site", `${tail}.md`);
}

test("every page the copy links to exists", () => {
  let links = 0;
  for (const surface of SURFACES) {
    const text = read(surface);
    for (const match of text.matchAll(LINK)) {
      const target = match[1] ?? match[2];
      const first = pageFor(surface, target);
      if (first === null) continue;
      links += 1;
      if (existsSync(first)) continue;
      // A root-absolute link on a marketing page is a page in public/; the
      // docs live beside it, and /get-started is a Vite input at the repo root.
      const tail = target.split("#")[0].split("?")[0].replace(/^\//, "");
      const candidates = [
        first,
        join(root, "public", tail),
        join(root, "public", `${tail}.html`),
        join(root, "public", tail, "index.html"),
        join(root, `${tail}.html`),
      ];
      assert.ok(
        candidates.some((candidate) => existsSync(candidate)),
        `${surface} links ${target}, which is not a file: none of ${candidates.join(", ")} exists`,
      );
    }
  }
  assert.ok(links >= 200, `the copy must carry the links (found ${links})`);
});

test("the gate can tell a docs link from a marketing link", () => {
  // The resolver is the fragile part, so it is checked directly rather than
  // only through the corpus: a root-absolute link inside a docs page is a docs
  // page (VitePress serves the docs under /docs/), while the same link on a
  // marketing page is a page in public/. A regression here would make the
  // corpus test pass by checking the wrong file.
  assert.equal(pageFor("docs-site/limits.md", "/faq"), join(root, "docs-site", "faq.md"));
  assert.equal(pageFor("docs-site/limits.md", "/faq#x"), join(root, "docs-site", "faq.md"));
  assert.equal(pageFor("public/index.html", "/docs/faq"), join(root, "docs-site", "faq.md"));
  assert.equal(pageFor("public/index.html", "/"), join(root, "public", "index.html"));
  // Not pages: another site, an anchor on this one, an api route.
  assert.equal(pageFor("public/index.html", "https://example.com/x"), null);
  assert.equal(pageFor("public/index.html", "#close-banner-what"), null);
  assert.equal(pageFor("public/index.html", "/api/files"), null);
});
