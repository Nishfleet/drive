// 0041 adds the two tables the stock known-bad SHA-256 feed loads into (drive
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
  lastKnownBadFeedLoad,
  loadKnownBadFeed,
  parseKnownBadFeed,
} from "../../src/malware.js";
import { createTestD1, DRIVE_MIGRATIONS, knownBadHashRows } from "../harness.mjs";

/** The instant every load in this file is stamped with (epoch millis). */
const NOW = 1_794_000_000_000;
/** One day later: the next load's export is the feed's own recent window. */
const LATER = NOW + 86_400_000;

/** The full default schema minus 0041: the state production is in the moment
 * 0041 lands. Filtered by name, not by position, so a file appended to
 * DRIVE_MIGRATIONS does not silently change what this builds.
 * @returns {readonly string[]} */
const migrationsBefore0041 = () =>
  DRIVE_MIGRATIONS.filter((name) => !name.endsWith("0041_known_bad_hashes.sql"));
/** @returns {ReturnType<typeof createTestD1>} */
const driveBefore0041 = () => createTestD1({ migrations: migrationsBefore0041() });

/**
 * The real migration file, read from disk rather than copied into the test. A
 * test that re-typed its SQL would pass even if the file it ships had lost the
 * tables or the primary key, so the file itself is what runs here.
 * @returns {string}
 */
const migration0041 = () =>
  readFileSync(
    new URL("../../migrations/drive/0041_known_bad_hashes.sql", import.meta.url),
    "utf8",
  );

/** The digest the test's feed carries at `index`: 64 lowercase hex digits,
 * distinct for every index and never all zeros, so an unknown digest is a real
 * unknown one.
 * @param {number} index
 * @returns {string} */
const digest = (index) => index.toString(16).padStart(64, "0");

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

test("0041 makes the WRITE path write every hash and stamp the load", async () => {
  // The drive as production is the moment 0041 lands: every migration up to it
  // applied, no known-bad rows yet.
  const db = driveBefore0041();
  db.sqlite.exec(migration0041());
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

test("0041 makes the READ path answer from the row, with no network of its own", async () => {
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

test("0041 is additive: two new tables, and no existing column changes", async () => {
  const db = driveBefore0041();
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
  db.sqlite.exec(migration0041());

  const tablesAfter = countTable();
  assert.deepEqual(
    tablesAfter.filter((name) => !tablesBefore.includes(name)),
    ["known_bad_feed_state", "known_bad_hashes"],
    "0041 added exactly two tables",
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

test("0041 can be applied twice without failing or duplicating a row", async () => {
  const db = driveBefore0041();
  db.sqlite.exec(migration0041());
  db.sqlite.exec(migration0041());
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
    migrations: [...migrationsBefore0041(), "drive/0041_known_bad_hashes.sql"],
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

test("a Worker deployed before 0041 has no table to read, and the read says so", async () => {
  const db = driveBefore0041();
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

test("0041's parse drops a shape change instead of storing a row that can never match", async () => {
  assert.deepEqual(
    parseKnownBadFeed(feedBody(2)),
    [digest(0), digest(1)],
    "header and blank lines go",
  );
  assert.deepEqual(parseKnownBadFeed("# only a header\r\n"), [], "a shape change is an empty list");
});

test("the load writes across the batch boundary, nothing lost at the end", async () => {
  const db = createTestD1({
    migrations: [...migrationsBefore0041(), "drive/0041_known_bad_hashes.sql"],
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
