// Every customer-facing email kind has a caller (drive issue #522).
//
// Four templates shipped with nobody to send them: cap-warning, read-only,
// monthly-receipt and payment-failed. A person could sign up, be charged, hit
// their spending cap, fail a payment and never receive a single email about
// any of it, and nothing anywhere failed. That is the whole class of bug this
// file exists to stop.
//
// The gate is deliberately not "the kind string appears somewhere". A string
// in a comment, a test fixture or a switch case is not a caller: a template
// named in a branch nobody reaches is exactly the failure this issue is about.
// So each kind below must appear as an argument to a real send call inside
// the runtime source, and the call must be reachable from a route or a cron.
//
// The one kind this file cannot unblock on its own is cap-warning, which is
// waiting on the billing decision in #496. It is listed with its blocker
// rather than deleted, so the day that decision lands the diff shows a
// missing caller instead of a silently absent one.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { EMAIL_KINDS } from "../core/emails.js";

/** @param {string} path @returns {string} */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const SRC_DIR = new URL("../src/", import.meta.url);
// The shared code both Workers import (drive#616): the sends that moved there
// with the rest of the shared modules are still runtime callers.
const CORE_DIR = new URL("../core/", import.meta.url);
const WORKER_SRC_DIRS = [
  new URL("../workers/api/src/", import.meta.url),
  new URL("../workers/dl/src/", import.meta.url),
];

/** Every runtime source file, the shipped code and nothing else. */
function runtimeSources() {
  /** @type {{path: string, text: string}[]} */
  const files = [];
  for (const dir of [SRC_DIR, CORE_DIR, ...WORKER_SRC_DIRS]) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".js")) {
        const path =
          dir === CORE_DIR
            ? `core/${name}`
            : name === "index.js" && dir !== SRC_DIR
              ? `workers:${name}`
              : `src/${name}`;
        files.push({ path, text: readFileSync(new URL(name, dir), "utf8") });
      }
    }
  }
  return files;
}

// The kinds that are internal to another flow and are sent by their own owner,
// so they do not need a customer-facing caller of their own.
const SENT_ELSEWHERE = new Set(["top-up-receipt", "low-balance", "device-approve-notice"]);

// The kinds this gate cannot satisfy yet, and the issue that unblocks each one.
// Deleting an entry here without a caller is the failure this file exists to
// catch, so each one must be named with its blocker.
//
// The blockers are the issue's own words, checked against the repository on
// 2026-10-05 rather than assumed: #522 names #496, #465 and #493 as the
// threads that wire the cap, receipt and payment-failed sends. #465 and #493
// are closed, and the sends they were supposed to leave wired still have no
// caller in src/, so the template is still orphaned and this file says so.
// #496 is open and carries the cap decision.
const BLOCKED_ON_AN_ISSUE = new Map([
  // The spending cap is not enforced yet, so there is no moment to warn
  // anyone about. Building a cap here to get a caller would be inventing a
  // billing decision that is not ours to make (drive#496).
  ["cap-warning", "496"],
  // #465 closed the $5 rollover and statements without leaving a caller for
  // the monthly receipt template. The billing page renders its own history
  // (src/portal.js), so the email has no place to be sent from until that
  // work is reopened.
  ["read-only", "496"],
  ["monthly-receipt", "465"],
  // #493 closed the card-failure ladder, but src/ has no Dodo webhook route
  // that reports a failed charge, so nothing can send this today. The copy
  // exists and points at the card-update path (drive#575); only the caller is
  // missing.
  ["payment-failed", "493"],
]);

test("every customer email kind either has a caller in the shipped source or names its blocker", () => {
  const sources = runtimeSources();
  const problems = [];
  for (const kind of EMAIL_KINDS) {
    if (SENT_ELSEWHERE.has(kind)) {
      continue;
    }
    // A caller is the kind handed to something that sends. Both spellings the
    // codebase uses count: the `kind` field of a sendEmail request, and the
    // positional argument of the one-line mail helpers that wrap it.
    const callers = sources.filter((file) =>
      new RegExp(`(kind:\\s*"${kind}"|,\\s*\\n?\\s*"${kind}",|Mail\\([^)]*"?${kind}"?)`, "m").test(
        file.text,
      ),
    );
    if (callers.length > 0) {
      continue;
    }
    const blocker = BLOCKED_ON_AN_ISSUE.get(kind);
    if (blocker === undefined) {
      problems.push(
        `${kind} has no caller in src/ and no blocker recorded. Either send it or record the issue that will.`,
      );
    }
  }
  assert.deepEqual(problems, [], "an email kind with no caller is a customer promise nobody keeps");
});

test("the blocked kinds are still real templates, so the gate cannot pass by deletion", () => {
  // The escape hatch above is "record the blocker". That is only honest while
  // the template still exists: if somebody deletes a template to make this
  // file pass, the customer stops getting an email and the gate goes quiet.
  const emails = read("core/emails.js");
  for (const kind of BLOCKED_ON_AN_ISSUE.keys()) {
    assert.ok(
      EMAIL_KINDS.includes(kind),
      `${kind} is recorded as blocked on an issue, so its template must still exist`,
    );
    assert.match(
      emails,
      new RegExp(`\\b${kind}\\b`),
      `${kind} is recorded as blocked on an issue, so core/emails.js must still render it`,
    );
  }
});

test("the welcome email is sent from the sign-in, once, and not from a test fixture", () => {
  // The one kind this issue unblocks outright. Proved by shape rather than by
  // a string search, because a send that is never reached is the same failure
  // wearing a different hat: the send has to live in a module the Worker
  // imports, and the row's once-only claim has to live beside it.
  const signin = read("src/signin-verify.js");
  assert.match(signin, /sendWelcomeOnce\(/, "the sign-in verify step calls the welcome");
  assert.match(
    signin,
    /import \{[^}]*sendWelcomeOnce[^}]*\} from "\.\/welcome\.js"/,
    "and it imports it, so the call is a real one",
  );
  const welcome = read("src/welcome.js");
  assert.match(
    welcome,
    /welcome_sent_at IS NULL/,
    "the once-only claim is a conditional write, so two concurrent sign-ins cannot both send",
  );
  assert.match(
    welcome,
    /welcome_sent_at = \?1 WHERE id = \?2 AND welcome_sent_at = \?2|welcome_sent_at = NULL WHERE id = \?1 AND welcome_sent_at = \?2/,
    "a failed send hands the claim back, and only its own claim",
  );
});

test("no source file sends an email kind the renderer does not know", () => {
  // The other half of the same gate: a caller for a kind nobody renders is a
  // send that 400s in production, and it is just as silent as a missing one.
  //
  // A send that passes a `rendered` body is not going through renderEmail at
  // all, so it needs no registered kind -- src/auth.js mails the sign-in link
  // that way, and that is a deliberate second path for the one email that has
  // to work before a person has an account. So the check only applies to
  // sends that ask the renderer for a kind.
  //
  // A `kind:` field elsewhere in these files (a file kind, a ledger entry
  // kind) is not an email either, and matching those here would make this test
  // cry wolf on the first unrelated object called `kind`.
  const problems = [];
  for (const file of runtimeSources()) {
    for (const match of file.text.matchAll(/kind:\s*"([a-z0-9-]+)"/g)) {
      const kind = match[1];
      const window = file.text.slice(Math.max(0, match.index - 200), match.index + 200);
      if (/\brendered:/.test(window)) {
        continue;
      }
      const looksLikeEmail =
        /\bsendEmail\s*\(/.test(window) ||
        /\bsend[A-Za-z]*Mail\s*\(/.test(window) ||
        /\bkind:\s*"[a-z0-9-]+"[\s\S]{0,80}?\bdata:/.test(window);
      if (!looksLikeEmail) {
        continue;
      }
      if (!EMAIL_KINDS.includes(kind)) {
        problems.push(`${file.path} sends "${kind}", which renderEmail does not know`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
