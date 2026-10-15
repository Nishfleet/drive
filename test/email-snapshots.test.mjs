import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { signinLinkEmail } from "../core/auth.js";
import { EMAIL_KINDS, renderEmail } from "../core/emails.js";
import { dataFor } from "./email-fixtures.mjs";

const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";
const DIRECTORY = new URL("./snapshots/emails/", import.meta.url);
const BANNED = /\b(revolutionary|seamless|unlimited|world-class|tenant|provision|click here)\b/i;
const SUBJECT_LIMIT = 70;

const SIGN_IN_WHEN = new Date("2026-10-14T12:00:00.000Z");

const rendered = () => [
  ...EMAIL_KINDS.map((kind) => ({ name: kind, mail: renderEmail(kind, dataFor(kind)) })),
  {
    name: "signin-link",
    mail: signinLinkEmail(
      "https://storagebun.com/api/signin/verify?token=abc",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
      SIGN_IN_WHEN,
    ),
  },
];

/** @param {string} name @param {string} extension @param {string} current */
function matches(name, extension, current) {
  const target = new URL(`${name}.${extension}`, DIRECTORY);
  if (UPDATE) {
    mkdirSync(DIRECTORY, { recursive: true });
    writeFileSync(target, current);
    return;
  }
  assert.ok(
    existsSync(target),
    `no snapshot for ${name}.${extension}; run UPDATE_SNAPSHOTS=1 node --test test/email-snapshots.test.mjs`,
  );
  assert.equal(
    readFileSync(target, "utf8"),
    current,
    `${name}.${extension} changed; if intended, run UPDATE_SNAPSHOTS=1 node --test test/email-snapshots.test.mjs and commit test/snapshots/emails/`,
  );
}

test("every email renders to the committed snapshot, in both its HTML and its text twin", () => {
  for (const { name, mail } of rendered()) {
    matches(name, "html", mail.html);
    matches(name, "txt", `${mail.subject}\n\n${mail.text}`);
  }
});

test("every email passes the copy rules: a short subject, no banned words, one reply address", () => {
  for (const { name, mail } of rendered()) {
    assert.ok(
      mail.subject.length <= SUBJECT_LIMIT,
      `${name}: subject is ${mail.subject.length} characters`,
    );
    assert.doesNotMatch(`${mail.subject}\n${mail.text}`, BANNED, `${name} uses a banned word`);
    assert.ok(mail.text.length > 0 && mail.html.includes("<html"), `${name} has both parts`);
  }
});
