// Integration test for drive#684: the daily arrival digest and the owner's
// display name. The real migration files under migrations/drive/ are applied
// to a real SQLite database with the whole schema (DRIVE_SCHEMA_MIGRATIONS), so
// the new columns are exercised against the schema the routes actually see, not
// a mock that cannot see columns.
//
//   WRITE — three drops through a real upload link queue three arrivals on the
//   real `pending_uploads` column.
//   READ  — a second store over the same database sees them, `listPendingDigests`
//   finds the link, one `sendArrivalDigests` run mails exactly one email that
//   lists every file, and the second nightly run mails nothing.
//   OWNER — `accountById` reads the display name off Better Auth's real "user"
//   table, which is what the info route puts on the page.
//
// The columns are additive (expand only): `digest_at` stays nullable and
// `pending_uploads` carries a DEFAULT, so an INSERT from the previous code
// keeps working and a rollback of the code leaves the rows in place.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createMemoryStore } from "../../src/files.js";
import {
  createD1LinkStore,
  handleRequestUploadRequest,
  newRequestRecord,
  sendArrivalDigests,
} from "../../src/share.js";
import { createD1DeviceStore } from "../../workers/api/src/devices.js";
import { MIGRATION_FILES } from "../d1-sqlite.mjs";
import { createTestD1, DRIVE_SCHEMA_MIGRATIONS } from "../harness.mjs";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const REQUEST_TOKEN = "digest-request-token-a";
const OTHER_TOKEN = "digest-request-token-b";

/** @returns {{limit: () => Promise<{success: boolean}>}} */
function allowLimiter() {
  return { limit: async () => ({ success: true }) };
}

/** @param {string} name @param {string} body @returns {Request} */
function drop(name, body) {
  return new Request(
    `https://drive.test/api/request/upload?k=${REQUEST_TOKEN}&name=${encodeURIComponent(name)}`,
    { method: "POST", body },
  );
}

test("the real migrations add the two additive digest columns", () => {
  assert.ok(
    MIGRATION_FILES.includes("0026_request_digest.sql"),
    "0026_request_digest.sql is missing from the migration set",
  );
  const { sqlite } = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });

  const digestAt = sqlite
    .prepare("SELECT * FROM pragma_table_info('upload_requests') WHERE name = ?1")
    .get("digest_at");
  assert.ok(digestAt, "upload_requests.digest_at is missing");
  assert.equal(digestAt.notnull, 0, "a NULL digest_at means no digest has gone out");
  assert.equal(digestAt.dflt_value, null, "a NULL keeps its meaning for old rows");

  const pending = sqlite
    .prepare("SELECT * FROM pragma_table_info('upload_requests') WHERE name = ?1")
    .get("pending_uploads");
  assert.ok(pending, "upload_requests.pending_uploads is missing");
  assert.equal(pending.notnull, 1, "pending_uploads is set for every row the arrival UPDATE reads");
  assert.equal(pending.dflt_value, "'[]'", "the old code's INSERT needs the empty default");

  const migration = readFileSync(
    new URL("../../migrations/drive/0026_request_digest.sql", import.meta.url),
    "utf8",
  );
  const sql = migration.replace(/--[^\n]*/g, "");
  assert.match(sql, /ALTER TABLE upload_requests ADD COLUMN digest_at INTEGER/);
  assert.match(
    sql,
    /ALTER TABLE upload_requests ADD COLUMN pending_uploads TEXT NOT NULL DEFAULT '\[]'/,
  );
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN)/i);
  assert.doesNotMatch(sql, /ADD COLUMN [^;]+NOT NULL(?! DEFAULT)/i);
});

test("three drops through a real link queue three arrivals on the real columns", async () => {
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-digest", "digest@example.com")
    .run();

  const links = createD1LinkStore(db);
  await links.requests.create(
    newRequestRecord({ accountId: "acct-digest", folder: "/", now: NOW, token: REQUEST_TOKEN }),
  );

  const files = createMemoryStore();
  const options = {
    now: NOW,
    ipLimiter: allowLimiter(),
    linkLimiter: allowLimiter(),
  };
  for (const [name, body] of [
    ["first.txt", "aaa"],
    ["second.txt", "bb"],
    ["third.txt", "c"],
  ]) {
    const response = await handleRequestUploadRequest(
      drop(name, body),
      files,
      links,
      () => "active",
      options,
    );
    assert.equal(response.status, 201, `${name} should have been accepted`);
  }

  // A second store over the same database is the stand-in for the next Worker
  // isolate: it must see the queue the route wrote.
  const reader = createD1LinkStore(db);
  const row = await reader.requests.get(REQUEST_TOKEN);
  assert.ok(row);
  assert.equal(row.digestAt, null, "no digest has gone out yet");
  /** @type {Array<{name: string, bytes: number}>} */
  const arrivals = JSON.parse(row.pendingUploads);
  assert.deepEqual(
    arrivals.map((a) => a.name),
    ["first.txt", "second.txt", "third.txt"],
    "each drop is queued in arrival order",
  );
  assert.deepEqual(
    arrivals.map((a) => a.bytes),
    [3, 2, 1],
    "each arrival keeps its own size",
  );

  const pending = await reader.requests.listPendingDigests();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].token, REQUEST_TOKEN);
});

test("the nightly digest mails each link once, lists every file, then mails nothing", async () => {
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-digest", "digest@example.com")
    .run();
  const links = createD1LinkStore(db);
  await links.requests.create(
    newRequestRecord({ accountId: "acct-digest", folder: "/", now: NOW, token: REQUEST_TOKEN }),
  );
  await links.requests.create(
    newRequestRecord({ accountId: "acct-digest", folder: "/", now: NOW, token: OTHER_TOKEN }),
  );

  // A second Worker run appends arrivals to each link: three files on one
  // link, one on the other.
  const writer = createD1LinkStore(db);
  await writer.requests.recordArrival(REQUEST_TOKEN, "first.txt", 3);
  await writer.requests.recordArrival(REQUEST_TOKEN, "second.txt", 2);
  await writer.requests.recordArrival(REQUEST_TOKEN, "third.txt", 1);
  await writer.requests.recordArrival(OTHER_TOKEN, "other.bin", 4096);

  /** @type {Array<{to: string, subject: string, text: string, html: string}>} */
  const sent = [];
  const email = {
    /** @param {unknown} message */
    send: async (message) => {
      sent.push(/** @type {any} */ (message));
      return { messageId: `msg-${sent.length}` };
    },
  };
  /** @param {string} accountId */
  /** @param {string} accountId */
  const owner = async (accountId) =>
    accountId === "acct-digest" ? { id: accountId, name: "Nish", email: "nish@example.com" } : null;

  const first = await sendArrivalDigests(db, {
    email,
    mailFrom: "drive@example.com",
    owner,
    now: NOW,
  });
  assert.deepEqual(first, { sent: 2, skipped: 0 });
  assert.equal(sent.length, 2, "one email per link, not one per file");

  const main = sent.find((message) => message.text.includes("first.txt"));
  assert.ok(main, "the three-file link got a digest");
  for (const name of ["first.txt", "second.txt", "third.txt"]) {
    assert.match(main.text, new RegExp(name), `${name} is in the one digest`);
  }
  assert.equal(main.to, "nish@example.com");
  assert.match(main.subject, /3 files/);
  // The owner's own name is on it, so the digest says whose link it is.
  assert.match(main.text, /Nish/);

  // The stamp and the clear landed: a second nightly run has nothing to send.
  const reader = createD1LinkStore(db);
  const cleared = await reader.requests.get(REQUEST_TOKEN);
  assert.ok(cleared);
  assert.equal(cleared.digestAt, NOW, "the link is stamped with the day it was sent");
  assert.equal(cleared.pendingUploads, "[]", "the queue is empty after the digest");
  assert.deepEqual(await reader.requests.listPendingDigests(), []);

  const second = await sendArrivalDigests(db, {
    email,
    mailFrom: "drive@example.com",
    owner,
    now: NOW + 1000,
  });
  assert.deepEqual(second, { sent: 0, skipped: 0 });
  assert.equal(sent.length, 2, "a second run sends nothing");
});

test("a link with no resolvable owner address is skipped, not mailed to nobody", async () => {
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-gone", "gone@example.com")
    .run();
  const links = createD1LinkStore(db);
  await links.requests.create(
    newRequestRecord({ accountId: "acct-gone", folder: "/", now: NOW, token: REQUEST_TOKEN }),
  );
  await links.requests.recordArrival(REQUEST_TOKEN, "orphan.txt", 8);

  let sends = 0;
  const email = {
    send: async () => {
      sends += 1;
      return { messageId: "never" };
    },
  };
  const result = await sendArrivalDigests(db, {
    email,
    mailFrom: "drive@example.com",
    owner: async () => null,
    now: NOW,
  });
  assert.deepEqual(result, { sent: 0, skipped: 1 });
  assert.equal(sends, 0);
});

test("one link's send failure does not stop the other link's digest", async () => {
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  for (const id of ["acct-boom", "acct-fine"]) {
    await db
      .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
      .bind(id, `${id}@example.com`)
      .run();
  }
  const links = createD1LinkStore(db);
  // The boom link is created first, so the created_at order mails it first and
  // proves the catch resumes the loop rather than aborting the whole run.
  await links.requests.create(
    newRequestRecord({ accountId: "acct-boom", folder: "/", now: NOW, token: REQUEST_TOKEN }),
  );
  await links.requests.create(
    newRequestRecord({ accountId: "acct-fine", folder: "/", now: NOW + 1, token: OTHER_TOKEN }),
  );
  await links.requests.recordArrival(REQUEST_TOKEN, "boom.txt", 4);
  await links.requests.recordArrival(OTHER_TOKEN, "fine.txt", 5);

  /** @type {Array<{to: string}>} */
  const delivered = [];
  const email = {
    /** @param {unknown} message */
    send: async (message) => {
      const m = /** @type {{to: string}} */ (message);
      if (m.to === "boom@example.com") {
        throw new Error("the mail provider refused this recipient");
      }
      delivered.push(m);
      return { messageId: "msg-fine" };
    },
  };
  /** @param {string} accountId */
  const owner = async (accountId) => ({
    id: accountId,
    name: accountId === "acct-boom" ? "Boom" : "Fine",
    email: accountId === "acct-boom" ? "boom@example.com" : "fine@example.com",
  });

  const result = await sendArrivalDigests(db, {
    email,
    mailFrom: "drive@example.com",
    owner,
    now: NOW,
  });
  assert.deepEqual(result, { sent: 1, skipped: 1 });
  assert.equal(delivered.length, 1, "the second link still got its digest");
  assert.equal(delivered[0].to, "fine@example.com");

  // The failed send left its arrivals queued for the next run.
  const reader = createD1LinkStore(db);
  const boom = await reader.requests.get(REQUEST_TOKEN);
  assert.ok(boom);
  assert.equal(boom.digestAt, null, "a failed send is not stamped");
  assert.deepEqual(
    /** @type {Array<{name: string}>} */ (JSON.parse(boom.pendingUploads)).map((a) => a.name),
    ["boom.txt"],
    "the failed link keeps its arrivals for the next nightly run",
  );
  const fine = await reader.requests.get(OTHER_TOKEN);
  assert.ok(fine);
  assert.equal(fine.digestAt, NOW);
  assert.equal(fine.pendingUploads, "[]");
});

test("an arrival accepted during the send stays queued for the next digest", async () => {
  // drive#684: the digest reads the queue, sends, then clears. A drop that
  // lands in that window must survive — the clear removes only the arrivals
  // the digest read, never a later one it did not list.
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-digest", "digest@example.com")
    .run();
  const links = createD1LinkStore(db);
  await links.requests.create(
    newRequestRecord({ accountId: "acct-digest", folder: "/", now: NOW, token: REQUEST_TOKEN }),
  );
  await links.requests.recordArrival(REQUEST_TOKEN, "first.txt", 3);
  await links.requests.recordArrival(REQUEST_TOKEN, "second.txt", 2);

  const writer = createD1LinkStore(db);
  /** @type {Array<{text: string}>} */
  const sent = [];
  const email = {
    /** @param {unknown} message */
    send: async (message) => {
      sent.push(/** @type {any} */ (message));
      if (sent.length === 1) {
        await writer.requests.recordArrival(REQUEST_TOKEN, "raced.txt", 7);
      }
      return { messageId: `msg-${sent.length}` };
    },
  };
  /** @param {string} accountId */
  const owner = async (accountId) => ({
    id: accountId,
    name: "Nish",
    email: "nish@example.com",
  });

  const first = await sendArrivalDigests(db, {
    email,
    mailFrom: "drive@example.com",
    owner,
    now: NOW,
  });
  assert.deepEqual(first, { sent: 1, skipped: 0 });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].text, /raced\.txt/, "the raced drop was not in this digest");

  const reader = createD1LinkStore(db);
  const row = await reader.requests.get(REQUEST_TOKEN);
  assert.ok(row);
  assert.equal(row.digestAt, NOW, "the sent digest is still stamped");
  assert.deepEqual(
    /** @type {Array<{name: string}>} */ (JSON.parse(row.pendingUploads)).map((a) => a.name),
    ["raced.txt"],
    "the arrival accepted during the send survives for the next run",
  );

  const second = await sendArrivalDigests(db, {
    email,
    mailFrom: "drive@example.com",
    owner,
    now: NOW + 1000,
  });
  assert.deepEqual(second, { sent: 1, skipped: 0 });
  assert.match(sent[1].text, /raced\.txt/, "the next run mails the raced drop");
  const after = await reader.requests.get(REQUEST_TOKEN);
  assert.ok(after);
  assert.equal(after.pendingUploads, "[]");
});

test("accountById reads the display name off Better Auth's real user table", async () => {
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  await db
    .prepare(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") ' +
        "VALUES (?1, ?2, ?3, 1, 0, 0)",
    )
    .bind("acct-named", "Nish Patel", "nish@example.com")
    .run();

  const store = createD1DeviceStore(db);
  const owner = await store.accountById("acct-named");
  assert.ok(owner);
  assert.equal(owner.name, "Nish Patel");
  assert.equal(owner.email, "nish@example.com");

  assert.equal(await store.accountById("nobody"), null, "an unknown account has no owner");

  // A blank name stays blank. The info route must never show the address to a
  // stranger, so accountById does not substitute the email for the name.
  await db
    .prepare(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") ' +
        "VALUES (?1, ?2, ?3, 1, 0, 0)",
    )
    .bind("acct-nameless", "", "quiet@example.com")
    .run();
  const nameless = await store.accountById("acct-nameless");
  assert.ok(nameless);
  assert.equal(nameless.name, "", "a blank name is left blank");
  assert.equal(nameless.email, "quiet@example.com", "the address is still there for the digest");
});
