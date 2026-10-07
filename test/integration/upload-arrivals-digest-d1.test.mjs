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
import { createD1DeviceStore } from "../../core/devices.js";
import { createMemoryStore } from "../../core/files.js";
import {
  createD1LinkStore,
  handleRequestUploadRequest,
  newRequestRecord,
  sendArrivalDigests,
} from "../../src/share.js";
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
    MIGRATION_FILES.includes("0038_request_digest.sql"),
    "0038_request_digest.sql is missing from the migration set",
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
    new URL("../../migrations/drive/0038_request_digest.sql", import.meta.url),
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

test("an arrival queue that parses to nothing is logged, drained and counted", async () => {
  // drive#684: the digest query selects every row whose queue is not the
  // empty literal, which includes a queue that is malformed JSON or an array
  // of nulls. Walking such a row every night without clearing it would list
  // a queue that can never yield a mail, so it is drained once and skipped.
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-junk", "junk@example.com")
    .run();
  const links = createD1LinkStore(db);
  await links.requests.create(
    newRequestRecord({ accountId: "acct-junk", folder: "/", now: NOW, token: REQUEST_TOKEN }),
  );
  // A queue no version of this code would write, set straight in the column.
  await db
    .prepare("UPDATE upload_requests SET pending_uploads = ?1 WHERE token = ?2")
    .bind("[null, 3]", REQUEST_TOKEN)
    .run();

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
    owner: async () => ({ id: "acct-junk", name: "Junk", email: "junk@example.com" }),
    now: NOW,
  });
  assert.deepEqual(result, { sent: 0, skipped: 1 }, "the row is counted, not silently dropped");
  assert.equal(sends, 0, "nothing is mailed for an unreadable queue");

  const reader = createD1LinkStore(db);
  const drained = await reader.requests.get(REQUEST_TOKEN);
  assert.ok(drained);
  assert.equal(drained.pendingUploads, "[]", "the unreadable queue is emptied");
  assert.deepEqual(
    await reader.requests.listPendingDigests(),
    [],
    "the next run does not walk it again",
  );
});

test("an arrival queue that is not JSON at all is drained, not refused every night", async () => {
  // drive#684 (orchestrator review): json_remove refuses a value that is not
  // JSON, so a drain that walked the row would fail on it every night and the
  // link would be listed forever. The drain writes the empty list outright.
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-bad-json", "bad@example.com")
    .run();
  const links = createD1LinkStore(db);
  await links.requests.create(
    newRequestRecord({ accountId: "acct-bad-json", folder: "/", now: NOW, token: REQUEST_TOKEN }),
  );
  await db
    .prepare("UPDATE upload_requests SET pending_uploads = ?1 WHERE token = ?2")
    .bind("not json {", REQUEST_TOKEN)
    .run();
  const email = { send: async () => ({ messageId: "never" }) };
  const result = await sendArrivalDigests(db, {
    email,
    mailFrom: "drive@example.com",
    owner: async () => ({ id: "acct-bad-json", name: "Bad", email: "bad@example.com" }),
    now: NOW,
  });
  assert.deepEqual(result, { sent: 0, skipped: 1 });
  const reader = createD1LinkStore(db);
  const drained = await reader.requests.get(REQUEST_TOKEN);
  assert.ok(drained);
  assert.equal(drained.pendingUploads, "[]", "the non-JSON queue is emptied");
  assert.equal(drained.digestAt, NOW);
  assert.deepEqual(await reader.requests.listPendingDigests(), []);
});

test("a clear that fails part-way leaves the whole queue and the old stamp, so nothing is re-mailed in halves", async () => {
  // drive#684 (orchestrator review): the clear takes more than one UPDATE for
  // a deep queue, then the stamp. They run as one D1 batch, which is a
  // transaction, so a failure on the last statement rolls back every chunk.
  // The failure is injected into the real batch over the real adapter.
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-torn", "torn@example.com")
    .run();
  const links = createD1LinkStore(db);
  await links.requests.create(
    newRequestRecord({ accountId: "acct-torn", folder: "/", now: NOW, token: REQUEST_TOKEN }),
  );
  for (let index = 0; index < 130; index += 1) {
    await links.requests.recordArrival(REQUEST_TOKEN, `file-${index}.bin`, index + 1);
  }
  const failing = Object.create(db);
  /** @param {any[]} statements */
  failing.batch = (statements) =>
    db.batch([...statements, db.prepare("UPDATE no_such_table SET x = 1")]);
  let sends = 0;
  const email = {
    send: async () => {
      sends += 1;
      return { messageId: `msg-${sends}` };
    },
  };
  const result = await sendArrivalDigests(failing, {
    email,
    mailFrom: "drive@example.com",
    owner: async () => ({ id: "acct-torn", name: "Torn", email: "torn@example.com" }),
    now: NOW,
  });
  assert.deepEqual(result, { sent: 0, skipped: 1 }, "the failed clear is counted as a skip");
  assert.equal(sends, 1);
  const row = await createD1LinkStore(db).requests.get(REQUEST_TOKEN);
  assert.ok(row);
  assert.equal(JSON.parse(row.pendingUploads).length, 130, "no chunk of the clear survived");
  assert.equal(row.digestAt, null, "the stamp rolled back with the clear");
});

test("the digest refuses a blank sender and a missing owner resolver", async () => {
  // drive#684: the two guards are the documented contract, and a digest from
  // a placeholder sender or with no way to read an owner is worse than no
  // digest, so both are refused before any link is read.
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const email = {
    send: async () => ({ messageId: "never" }),
  };
  const owner = async () => null;
  await assert.rejects(
    () => sendArrivalDigests(db, { email, mailFrom: "  ", owner, now: NOW }),
    /MAIL_FROM/,
    "a blank MAIL_FROM is refused",
  );
  await assert.rejects(
    () =>
      sendArrivalDigests(db, {
        email,
        mailFrom: "drive@example.com",
        owner: /** @type {never} */ (undefined),
        now: NOW,
      }),
    /owner resolver/,
    "a missing owner resolver is refused",
  );
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

test("the digest reads a link's owner off the real user table the mint resolved to", async () => {
  // drive#684 (in-run review): the join the digest depends on is
  // upload_requests.account_id = "user".id, and every other test in this file
  // stubs the owner resolver, so nothing proved that link. A real Better Auth
  // user row, a real link row minted for its id, and the real `accountById`
  // the Worker uses: if the columns ever stopped being the same table, the
  // digest would silently skip every link each night.
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  await db
    .prepare(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") ' +
        "VALUES (?1, ?2, ?3, 1, 0, 0)",
    )
    .bind("acct-real", "Nish Patel", "nish@example.com")
    .run();
  const links = createD1LinkStore(db);
  await links.requests.create(
    newRequestRecord({ accountId: "acct-real", folder: "/inbox", now: NOW, token: REQUEST_TOKEN }),
  );
  await links.requests.recordArrival(REQUEST_TOKEN, "report.pdf", 12000);

  /** @type {Array<{to: string, text: string, subject: string}>} */
  const sent = [];
  const email = {
    /** @param {unknown} message */
    send: async (message) => {
      sent.push(/** @type {any} */ (message));
      return { messageId: `msg-${sent.length}` };
    },
  };
  const result = await sendArrivalDigests(db, {
    email,
    mailFrom: "drive@example.com",
    owner: createD1DeviceStore(db).accountById,
    now: NOW,
  });
  assert.deepEqual(result, { sent: 1, skipped: 0 });
  assert.equal(sent.length, 1, "the real account read resolved the link's owner");
  assert.equal(sent[0].to, "nish@example.com", "the mail lands on the user row's own address");
  assert.match(sent[0].text, /report\.pdf/);
  assert.match(sent[0].text, /Nish Patel/, "the digest names the account's display name");
});

test("a junk entry ahead of a real arrival is cleared with it, never re-sent", async () => {
  // drive#684 (in-run review): the clear removes from the front of the array
  // by position, so it must remove the stored array's own length, junk
  // entries included. Removing only the parsed count would leave a junk entry
  // at the front and shift every real name one place, so the next night's
  // digest would mail an arrival it had already sent.
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-mixed", "mixed@example.com")
    .run();
  const links = createD1LinkStore(db);
  await links.requests.create(
    newRequestRecord({ accountId: "acct-mixed", folder: "/", now: NOW, token: REQUEST_TOKEN }),
  );
  // A junk entry in front of a real arrival, set straight in the column.
  await db
    .prepare("UPDATE upload_requests SET pending_uploads = ?1 WHERE token = ?2")
    .bind('[null, {"bytes": 9, "name": "real.txt"}]', REQUEST_TOKEN)
    .run();

  /** @type {Array<{text: string}>} */
  const sent = [];
  const email = {
    /** @param {unknown} message */
    send: async (message) => {
      sent.push(/** @type {any} */ (message));
      return { messageId: `msg-${sent.length}` };
    },
  };
  /** @param {string} accountId */
  const owner = async (accountId) => ({ id: accountId, name: "Mixed", email: "m@example.com" });
  const result = await sendArrivalDigests(db, {
    email,
    mailFrom: "drive@example.com",
    owner,
    now: NOW,
  });
  assert.deepEqual(result, { sent: 1, skipped: 0 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /real\.txt/);

  const reader = createD1LinkStore(db);
  const row = await reader.requests.get(REQUEST_TOKEN);
  assert.ok(row);
  assert.equal(row.pendingUploads, "[]", "the junk entry left with the real one");
  assert.deepEqual(await reader.requests.listPendingDigests(), [], "nothing is re-listed");
  const second = await sendArrivalDigests(db, {
    email,
    mailFrom: "drive@example.com",
    owner,
    now: NOW + 1000,
  });
  assert.equal(second.sent, 0, "the real arrival is not mailed a second time");
  assert.equal(sent.length, 1);
});

test("a queue deeper than one json_remove call is still fully drained", async () => {
  // drive#684 (in-run review): SQLITE_MAX_FUNCTION_ARG bounds one json_remove
  // call, so a link that filled its whole queue must be cleared in chunks.
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-deep", "deep@example.com")
    .run();
  const links = createD1LinkStore(db);
  await links.requests.create(
    newRequestRecord({ accountId: "acct-deep", folder: "/", now: NOW, token: REQUEST_TOKEN }),
  );
  // Twice the chunk size, so the clear takes more than one UPDATE.
  for (let index = 0; index < 130; index += 1) {
    await links.requests.recordArrival(REQUEST_TOKEN, `file-${index}.bin`, index + 1);
  }
  /** @type {Array<{text: string}>} */
  const sent = [];
  const email = {
    /** @param {unknown} message */
    send: async (message) => {
      sent.push(/** @type {any} */ (message));
      return { messageId: `msg-${sent.length}` };
    },
  };
  /** @param {string} accountId */
  const owner = async (accountId) => ({ id: accountId, name: "Deep", email: "d@example.com" });
  const result = await sendArrivalDigests(db, {
    email,
    mailFrom: "drive@example.com",
    owner,
    now: NOW,
  });
  assert.deepEqual(result, { sent: 1, skipped: 0 });
  assert.equal(sent.length, 1);
  const reader = createD1LinkStore(db);
  const row = await reader.requests.get(REQUEST_TOKEN);
  assert.ok(row);
  assert.equal(row.pendingUploads, "[]", "every arrival was cleared, none left at the front");
});

test("a link mailed twenty hours ago is not mailed again by an extra trip", async () => {
  // drive#684 (in-run review): the one-a-day bound must not rest on the
  // schedule alone. The shared reconcile trip running twice in a day would
  // otherwise mail the same link twice, and the second mail would list the
  // arrivals the first had not cleared yet.
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-twice", "twice@example.com")
    .run();
  const links = createD1LinkStore(db);
  await links.requests.create(
    newRequestRecord({ accountId: "acct-twice", folder: "/", now: NOW, token: REQUEST_TOKEN }),
  );
  await links.requests.recordArrival(REQUEST_TOKEN, "first.txt", 3);
  /** @type {Array<{text: string}>} */
  const sent = [];
  const email = {
    /** @param {unknown} message */
    send: async (message) => {
      sent.push(/** @type {any} */ (message));
      return { messageId: `msg-${sent.length}` };
    },
  };
  /** @param {string} accountId */
  const owner = async (accountId) => ({ id: accountId, name: "Twice", email: "t@example.com" });
  const first = await sendArrivalDigests(db, {
    email,
    mailFrom: "drive@example.com",
    owner,
    now: NOW,
  });
  assert.deepEqual(first, { sent: 1, skipped: 0 });

  // An extra trip two hours later finds a new arrival on a stamped link.
  await links.requests.recordArrival(REQUEST_TOKEN, "second.txt", 2);
  const soon = await sendArrivalDigests(db, {
    email,
    mailFrom: "drive@example.com",
    owner,
    now: NOW + 2 * 60 * 60 * 1000,
  });
  assert.deepEqual(soon, { sent: 0, skipped: 0 }, "the stamp holds the second trip off");
  assert.equal(sent.length, 1);

  // Twenty-four hours later it goes.
  const next = await sendArrivalDigests(db, {
    email,
    mailFrom: "drive@example.com",
    owner,
    now: NOW + 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(next, { sent: 1, skipped: 0 });
  assert.equal(sent.length, 2, "the next day's digest carries the held-back arrival");
  assert.match(sent[1].text, /second\.txt/);
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
    now: NOW + 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(second, { sent: 1, skipped: 0 });
  assert.match(sent[1].text, /raced\.txt/, "the next day's run mails the raced drop");
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
