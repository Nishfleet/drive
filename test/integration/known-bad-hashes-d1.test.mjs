// 0042 adds the two tables the stock known-bad SHA-256 feed loads into (drive
// issue #826): `known_bad_hashes`, one row per digest, and
// `known_bad_feed_state`, the one row that records the last successful load.
// This file applies the REAL migration file, in the real order, against
// node:sqlite — the engine D1 runs — and asserts the two paths the fleet's D1
// rule asks a migration PR to prove on a real schema:
//
//   WRITE: loadKnownBadFeed writes every hash the download carried and stamps
//          the load on the state row.
//   READ:  isKnownBadHash answers from the row, with no network at all.
//
// plus the additive shape the expand/contract rule asks for: two new tables,
// no existing column dropped, renamed or made NOT NULL, so the previous
// version of the code keeps running against this schema. D1 has no
// down-migration, so this is one-way and that shape is the whole guarantee.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { nowSeconds } from "../../core/db.js";
import {
  EICAR_SHA256,
  isKnownBadHash,
  KNOWN_BAD_FEED_URL,
  KNOWN_BAD_MAX_LOAD_HASHES,
  KNOWN_BAD_MIN_LOAD_SHARE,
  lastKnownBadFeedLoad,
  loadKnownBadFeed,
  parseKnownBadFeed,
} from "../../src/malware.js";
import { createD1LinkStore, newRequestRecord } from "../../src/share.js";
import { createTestD1, DRIVE_MIGRATIONS, knownBadHashRows } from "../harness.mjs";

/** The instant every load in this file is stamped with (epoch millis). */
const NOW = 1_794_000_000_000;
/** One day later: the next load's export is the feed's own recent window. */
const LATER = NOW + 86_400_000;
/** The upload-request link the 0043 quiet-window test stamps. */
const REQUEST_TOKEN = "BBBBBBBBBBBBBBBBBBBBBB";

/** The full default schema minus 0042: the state production is in the moment
 * 0042 lands. Filtered by name, not by position, so a file appended to
 * DRIVE_MIGRATIONS does not silently change what this builds.
 * @returns {readonly string[]} */
const migrationsBefore0042 = () =>
  DRIVE_MIGRATIONS.filter((name) => !name.endsWith("0042_known_bad_hashes.sql"));
/** @returns {ReturnType<typeof createTestD1>} */
const driveBefore0042 = () => createTestD1({ migrations: migrationsBefore0042() });

/**
 * The real migration file, read from disk rather than copied into the test. A
 * test that re-typed its SQL would pass even if the file it ships had lost the
 * tables or the primary key, so the file itself is what runs here.
 * @returns {string}
 */
const migration0042 = () =>
  readFileSync(
    new URL("../../migrations/drive/0042_known_bad_hashes.sql", import.meta.url),
    "utf8",
  );

/** The digest the test's feed carries at `index`: 64 lowercase hex digits,
 * distinct for every index and never all zeros (index 1 is the first value,
 * so 0 does not read as the 64-zero digest a parser bug could produce), so
 * an unknown digest is a real unknown one.
 * @param {number} index
 * @returns {string} */
const digest = (index) => (index + 1).toString(16).padStart(64, "0");

/**
 * A feed body: a header of `#` lines, then one digest per line with CRLF
 * terminators and a blank tail, the shape the real export arrives in.
 * @param {number} count
 * @param {(index: number) => string} [digestOf]
 * @returns {string}
 */
const feedBody = (count, digestOf = digest) =>
  [
    "# MalwareBazaar recent malware samples (SHA256 hashes)",
    "# For questions please read the abuse.ch FAQ",
    "",
    ...Array.from({ length: count }, (_, index) => digestOf(index)),
    "",
  ].join("\r\n");

/**
 * The download double: a Response-shaped answer with no socket behind it, and a
 * call counter, so a test can prove a read made no call of its own.
 * @param {string} text
 * @param {{status?: number, ok?: boolean, calls?: number[]}} [options]
 */
const feedResponse = (text, options = {}) => {
  const calls = options.calls;
  // The shape `fetch` answers with, narrowed to the fields the loader reads
  // and then widened back to Response through one documented cast: the loader
  // takes `response.ok`, `response.status`, `response.headers`,
  // `response.body` and `response.text()` off it and nothing else, and the
  // cast is the honest description of that. `body` is null because a stand-in
  // answers with no stream to read in pieces, which is the one case
  // readKnownBadFeedBody takes as a whole through `text()`.
  const answer = {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: new Headers(),
    body: null,
    async text() {
      calls?.push(1);
      return text;
    },
  };
  return /** @type {Response} */ (/** @type {unknown} */ (answer));
};

test("0042 makes the WRITE path write every hash and stamp the load", async () => {
  // The drive as production is the moment 0042 lands: every migration up to it
  // applied, no known-bad rows yet.
  const db = driveBefore0042();
  db.sqlite.exec(migration0042());
  assert.equal(await lastKnownBadFeedLoad(db), null, "no load has ever landed");

  const loaded = await loadKnownBadFeed(db, {
    fetch: async () => feedResponse(feedBody(3)),
    now: NOW,
  });

  assert.deepEqual(loaded, {
    hashes: 3,
    rows: 3,
    source: KNOWN_BAD_FEED_URL,
    loadedAt: nowSeconds(NOW),
  });
  assert.deepEqual(
    await lastKnownBadFeedLoad(db),
    { source: KNOWN_BAD_FEED_URL, loadedAt: nowSeconds(NOW), hashCount: 3 },
    "the state row names the source, the instant and the count",
  );
  assert.deepEqual(
    knownBadHashRows(db).map((row) => row.seenAt),
    [nowSeconds(NOW), nowSeconds(NOW), nowSeconds(NOW)],
    "and every row carries that same first-sighting stamp",
  );
});

test("0042 makes the READ path answer from the row, with no network of its own", async () => {
  const db = createTestD1();
  await loadKnownBadFeed(db, { fetch: async () => feedResponse(feedBody(2)), now: NOW });

  /** @type {number[]} */
  const calls = [];
  // The fetch double that must never be reached: it throws rather than fail
  // quietly, so a read that went to the network for a hash cannot pass.
  const original = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (
    async () => {
      calls.push(1);
      throw new Error("the request path must not call out for a hash");
    }
  );
  try {
    assert.equal(await isKnownBadHash(db, digest(0)), true, "a loaded digest is refused");
    assert.equal(await isKnownBadHash(db, digest(0).toUpperCase()), true, "case-insensitive");
    assert.equal(await isKnownBadHash(db, digest(7)), false, "an unknown digest is not");
    // The in-memory half is answered first, so EICAR is refused with no row.
    assert.equal(await isKnownBadHash(db, EICAR_SHA256), true, "the in-memory half still answers");
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(calls, [], "no fetch was made on the read path");
});

test("the digest column is what the read looks up: the key, not a scan", async () => {
  const db = createTestD1();
  const plan = db.sqlite
    .prepare("EXPLAIN QUERY PLAN SELECT 1 FROM known_bad_hashes WHERE sha256 = ?1")
    .all()
    .map((row) => row.detail)
    .join(" | ");
  assert.match(plan, /SEARCH known_bad_hashes USING/, `plan: ${plan}`);
  assert.doesNotMatch(plan, /SCAN known_bad_hashes/, `plan: ${plan}`);
});

test("0042 is additive: two new tables, and no existing column changes", async () => {
  const db = driveBefore0042();
  const countTable = () =>
    db.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
  const tablesBefore = countTable();
  const sharesBefore = db.sqlite
    .prepare("PRAGMA table_info(shares)")
    .all()
    .map((row) => row.name);

  // The real file runs, exactly as D1 runs it.
  db.sqlite.exec(migration0042());

  const tablesAfter = countTable();
  assert.deepEqual(
    tablesAfter.filter((name) => !tablesBefore.includes(name)),
    ["known_bad_feed_state", "known_bad_hashes"],
    "0042 added exactly two tables",
  );
  assert.deepEqual(
    db.sqlite
      .prepare("PRAGMA table_info(shares)")
      .all()
      .map((row) => row.name),
    sharesBefore,
    "and touched nothing about the share rows the request path writes",
  );
});

test("0042 can be applied twice without failing or duplicating a row", async () => {
  const db = driveBefore0042();
  db.sqlite.exec(migration0042());
  db.sqlite.exec(migration0042());
  await loadKnownBadFeed(db, { fetch: async () => feedResponse(feedBody(2)), now: NOW });
  await loadKnownBadFeed(db, { fetch: async () => feedResponse(feedBody(2)), now: LATER });
  assert.equal(knownBadHashRows(db).length, 2, "one row a digest, however many loads run");
  assert.equal((await lastKnownBadFeedLoad(db))?.hashCount, 2);
});

test("the state row really is one row: id 2 is refused by the check itself", async () => {
  const db = createTestD1();
  db.sqlite
    .prepare(
      "INSERT INTO known_bad_feed_state (id, source, loaded_at, hash_count) VALUES (1, ?, ?, ?)",
    )
    .run("https://example.test", 1, 1);
  assert.throws(
    () =>
      db.sqlite
        .prepare(
          "INSERT INTO known_bad_feed_state (id, source, loaded_at, hash_count) VALUES (2, ?, ?, ?)",
        )
        .run("https://example.test", 1, 1),
    /CHECK constraint failed/,
  );
  assert.equal(
    (await lastKnownBadFeedLoad(db))?.source,
    "https://example.test",
    "the written row survives",
  );
});

test("a hash that cycles out of the feed stays refused, and keeps its first sighting", async () => {
  const db = createTestD1({
    migrations: [...migrationsBefore0042(), "drive/0042_known_bad_hashes.sql"],
  });
  await loadKnownBadFeed(db, { fetch: async () => feedResponse(feedBody(3)), now: NOW });

  // The next day's export no longer carries the third digest. `INSERT OR
  // IGNORE` keeps the row, so the file it refused is still refused.
  await loadKnownBadFeed(db, {
    fetch: async () =>
      feedResponse(feedBody(3, (index) => (index === 2 ? "f".repeat(64) : digest(index)))),
    now: LATER,
  });

  assert.equal(knownBadHashRows(db).length, 4, "the new digest joined, the gone one stayed");
  assert.equal(
    await isKnownBadHash(db, digest(2)),
    true,
    "a hash that left the feed is still refused",
  );
  assert.equal(
    knownBadHashRows(db).find((row) => row.sha256 === digest(2))?.seenAt,
    nowSeconds(NOW),
    "and its seen_at is still the first sighting, never the latest load",
  );
  assert.equal(
    knownBadHashRows(db).find((row) => row.sha256 === "f".repeat(64))?.seenAt,
    nowSeconds(LATER),
    "while the new row carries the instant it arrived",
  );
});

test("a Worker deployed before 0042 has no table to read, and the read says so", async () => {
  const db = driveBefore0042();
  await assert.rejects(
    () => isKnownBadHash(db, digest(0)),
    /no such table: known_bad_hashes/,
    "the read does not catch a missing schema: a swallowed error would be a pass",
  );
  // The WRITE path fails the same way, which is why the migration file says to
  // apply it before the code that reads it.
  await assert.rejects(
    () => loadKnownBadFeed(db, { fetch: async () => feedResponse(feedBody(1)), now: NOW }),
    /no such table/,
  );
});

test("0042's parse drops a shape change instead of storing a row that can never match", async () => {
  assert.deepEqual(
    parseKnownBadFeed(feedBody(2)),
    [digest(0), digest(1)],
    "header and blank lines go",
  );
  assert.deepEqual(parseKnownBadFeed("# only a header\r\n"), [], "a shape change is an empty list");
});

test("the load writes across the batch boundary, nothing lost at the end", async () => {
  const db = createTestD1({
    migrations: [...migrationsBefore0042(), "drive/0042_known_bad_hashes.sql"],
  });
  const loaded = await loadKnownBadFeed(db, {
    fetch: async () => feedResponse(feedBody(250)),
    now: NOW,
  });
  assert.equal(loaded.hashes, 250);
  assert.equal(loaded.rows, 250, "nothing is lost at a statement or a batch boundary");
  assert.equal(knownBadHashRows(db).length, 250);
  assert.equal(
    await isKnownBadHash(db, digest(249)),
    true,
    "the last digest of the last batch lands",
  );
  assert.equal(
    (await lastKnownBadFeedLoad(db))?.hashCount,
    250,
    "the count the next load reads is real",
  );
});

test("a short load fails the cron monitor and keeps the rows it had", async () => {
  // The load's own shape detector (drive issue #838), on the real table: a
  // download that is a truncation, a redirect or the wrong export parses
  // cleanly and carries fewer digests than half of the last load's count, so
  // the rows it would write are all refusals while every hash the real export
  // lost became shareable again with nothing to show for it. It has to fail
  // its own cron monitor instead of writing that short list.
  const db = createTestD1();
  const full = await loadKnownBadFeed(db, {
    fetch: async () => feedResponse(feedBody(8)),
    now: NOW,
  });
  assert.equal(full.hashes, 8);
  // The policy the loader reads: half the count the last load stored, so the
  // floor moves with the feed instead of being a number written down today.
  assert.equal(KNOWN_BAD_MIN_LOAD_SHARE, 0.5, "the floor is half the previous load's count");
  const floorOf8 = Math.floor(8 * KNOWN_BAD_MIN_LOAD_SHARE);

  await assert.rejects(
    () => loadKnownBadFeed(db, { fetch: async () => feedResponse(feedBody(3)), now: LATER }),
    new RegExp(`under the ${floorOf8} floor of the 8 its last load carried`),
    "a load carrying under half the last load's count is refused before it writes",
  );
  // The written state keeps standing, which is what the schema already buys:
  // the state row still names the load that succeeded, and every row that load
  // wrote is still there, so nothing was refused in place of a real row.
  assert.deepEqual(await lastKnownBadFeedLoad(db), {
    source: KNOWN_BAD_FEED_URL,
    loadedAt: nowSeconds(NOW),
    hashCount: 8,
  });
  assert.deepEqual(
    knownBadHashRows(db).map((row) => row.sha256),
    Array.from({ length: 8 }, (_, index) => digest(index)),
    "a refused load wrote no row of its own",
  );

  // Exactly the floor is a load that cleared it: the share is a bound on what
  // the loader refuses, not a target, and a feed whose recent window shrank
  // by half has not changed shape. It writes what it carries and nothing else.
  const atFloor = await loadKnownBadFeed(db, {
    fetch: async () => feedResponse(feedBody(4)),
    now: LATER,
  });
  assert.equal(atFloor.hashes, 4);
  assert.equal(atFloor.rows, 8, "the earlier rows keep standing; this load adds only its own");
  assert.equal((await lastKnownBadFeedLoad(db))?.hashCount, 4);

  // And the next load is measured against the one that just landed, so a
  // shrink is caught relative to the feed's own latest shape.
  await assert.rejects(
    () => loadKnownBadFeed(db, { fetch: async () => feedResponse(feedBody(1)), now: LATER }),
    new RegExp(
      `under the ${Math.floor(4 * KNOWN_BAD_MIN_LOAD_SHARE)} floor of the 4 its last load carried`,
    ),
  );
  assert.equal(knownBadHashRows(db).length, 8, "the second refusal wrote nothing either");
});

test("a first load has no previous count to lean on, so only the row ceiling bounds it", async () => {
  // The floor needs a previous count to be a floor: the first load this
  // deployment ever makes has nothing to compare against, and refusing a small
  // first load would leave the list with no feed half at all. The row ceiling
  // still applies to it — that is what the next test pins — so what is proven
  // here is only that a single-hash first load is a load, not a refusal.
  const db = createTestD1();
  const loaded = await loadKnownBadFeed(db, {
    fetch: async () => feedResponse(feedBody(1)),
    now: NOW,
  });
  assert.equal(loaded.hashes, 1);
  assert.equal(loaded.rows, 1, "a single-hash first load is a load, not a refusal");
});

test("one load may write no more than the ceiling, and the ceiling itself is a load", async () => {
  // The ceiling on the other side (drive issue #838): a source that changed
  // shape into something huge — a full-database export where the recent window
  // used to be — must not fill `known_bad_hashes` in one trip. The real export
  // carries about 1,500 digests a day, so the ceiling is several times the
  // thing it bounds and leaves room for the feed to grow without a shape
  // change.
  const db = createTestD1();
  await assert.rejects(
    () =>
      loadKnownBadFeed(db, {
        fetch: async () => feedResponse(feedBody(KNOWN_BAD_MAX_LOAD_HASHES + 1)),
        now: NOW,
      }),
    new RegExp(`over the ${KNOWN_BAD_MAX_LOAD_HASHES}-hash ceiling one load may write`),
  );
  assert.equal(knownBadHashRows(db).length, 0, "an over-ceiling load wrote nothing");
  assert.equal(await lastKnownBadFeedLoad(db), null, "and stamped no load");

  // The ceiling itself is a load that may write, on the same real table the
  // previous loads wrote to, and the next load is measured against it.
  const atCeiling = await loadKnownBadFeed(db, {
    fetch: async () => feedResponse(feedBody(KNOWN_BAD_MAX_LOAD_HASHES)),
    now: NOW,
  });
  assert.equal(atCeiling.hashes, KNOWN_BAD_MAX_LOAD_HASHES);
  assert.equal(atCeiling.rows, KNOWN_BAD_MAX_LOAD_HASHES);
  assert.equal(
    (await lastKnownBadFeedLoad(db))?.hashCount,
    KNOWN_BAD_MAX_LOAD_HASHES,
    "the count the next load reads is the one that landed",
  );
});

test("0043 stamps the quiet window on the real schema: null until a notice is sent", async () => {
  // The column is the flood cap's memory (drive issue #826): the full real
  // migration set makes the table, so the write and the read here are the
  // exact statements the route runs, on the schema the deploy ships.
  const db = createTestD1();
  const links = createD1LinkStore(db);
  await links.requests.create(
    newRequestRecord({ accountId: "acct-1", folder: "/", now: NOW, token: REQUEST_TOKEN }),
  );
  // The read half: a link never noticed reads back null, so the route mails
  // on its first refusal, and so does every link minted before 0043.
  const fresh = await links.requests.get(REQUEST_TOKEN);
  assert.ok(fresh);
  assert.equal(fresh.malwareNoticeAt, null);
  // The write half: the stamp follows a sent notice, and a later read on a
  // fresh store carries it, the way a repeat refusal inside the window
  // reads it back.
  await links.requests.stampMalwareNotice(REQUEST_TOKEN, NOW + 1_000);
  const stamped = await createD1LinkStore(db).requests.get(REQUEST_TOKEN);
  assert.ok(stamped);
  assert.equal(stamped.malwareNoticeAt, NOW + 1_000);
});
