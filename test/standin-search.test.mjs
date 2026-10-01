// The issue's done-when, on real storage (drive issue #18): "on a real drive
// with 100,000 files, `drive search` returns in under 1 s".
//
// test/search.test.mjs proves the number on the same SQL against the same
// SQLite engine D1 runs, but from rows the test wrote itself. This file is the
// half that only real storage can answer: the files are in an S3 bucket, the
// index is built by walking that bucket with the shipped S3 store, and the
// search runs over what the walk found. Everything is the production path —
// `createS3Store` (src/files.js) scoped by `scopeStore`, fed to
// `reconcileIndex` (src/search.js) exactly as the Worker's scheduled handler
// wires it, then `searchDrive` over the result.
//
// The stand-in is stock `rclone serve s3` on a local folder (the same tool and
// the same shape as test/two-mount-sync.test.mjs and the Go mount proof; no
// new dependency). Storage is configuration, never code, so the same proof runs
// against real iDrive e2 (eu-west-3) by setting the environment and nothing
// else — that is what lands with issue #2, and this file is the proof it
// unblocks:
//
//   DRIVE_STANDIN_ENDPOINT  S3 endpoint (default: a local rclone serve s3)
//   DRIVE_STANDIN_BUCKET    bucket name (default: "bucket")
//   DRIVE_STANDIN_SEARCH_FILES  files in the stand-in drive (default 100000)
//
// The search must not list the bucket, so the cost of doing it anyway is
// measured on the same files and printed beside the search: that is the
// listing-based alternative the index exists to avoid. Spotlight itself is
// macOS and cannot be timed here; the drive repo's AGENTS.md marks a Mac-only
// proof for Nish, and the number recorded on the issue says so.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createS3Store, scopeStore } from "../src/files.js";
import { reconcileIndex, searchDrive, withIndex } from "../src/search.js";

const ACCOUNT = { id: "1", name: "Your drive" };
const FOLDERS = 20;
const rawCount = process.env.DRIVE_STANDIN_SEARCH_FILES;
const FILES = rawCount === undefined ? 100_000 : Number(rawCount);
if (!Number.isInteger(FILES) || FILES <= 0) {
  throw new Error(`DRIVE_STANDIN_SEARCH_FILES=${rawCount} is not a whole number of files above 0`);
}
/** The issue's bar, in the same units searchDrive reports. */
const BUDGET_MS = 1000;

/**
 * D1's types are the runtime's `declare abstract class` — its `raw` carries two
 * generic overloads no JS object can express — so the adapter is typed here in
 * full, every method named and JSDoc'd, and handed to the interface the modules
 * import through one documented cast. Nothing inside hides an error: each
 * method below checks on its own, and a method the modules call that is missing
 * would fail at run time, not silently pass.
 * @typedef {D1Database & {sqlite: DatabaseSync}} SqliteD1
 * @returns {SqliteD1}
 */
function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of ["waitlist/0001_waitlist.sql", "drive/0002_file_index.sql"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  /** The D1 meta a run answers with: every required field of the runtime's
   * D1Meta, so a `D1Result` check is not fought.
   * @returns {D1Meta & Record<string, unknown>} */
  const meta = () => ({
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  });
  /**
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {{results: Record<string, unknown>[], changes: number}}
   */
  const runOne = (sql, params = []) => {
    const values = /** @type {Array<import("node:sqlite").SQLInputValue>} */ (params);
    if (/^\s*(SELECT|WITH)/i.test(sql)) {
      return { results: /** @type {Record<string, unknown>[]} */ (sqlite.prepare(sql).all(...values)), changes: 0 };
    }
    const info = sqlite.prepare(sql).run(...values);
    return { results: [], changes: Number(info.changes) };
  };
  /** The SQL and parameters each prepared statement carries, so batch() can
   * run the statements the caller built and not re-derive them.
   * @type {WeakMap<object, {sql: string, params: unknown[]}>} */
  const bound = new WeakMap();
  /**
   * One prepared statement, the way D1 hands it back: bind() returns a
   * statement carrying its own parameters, so the rest of the chain
   * (all/first/run) runs the bound SQL.
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {D1PreparedStatement}
   */
  const statementFor = (sql, params = []) => {
    const statement = /** @type {D1PreparedStatement} */ (
      /** @type {unknown} */ ({
        sql,
        params,
        /** @param {...unknown} values */
        bind(...values) {
          return statementFor(sql, values);
        },
        /**
         * @template T
         * @param {string} [colName]
         * @returns {Promise<T|null>}
         */
        async first(colName) {
          void colName;
          const row = runOne(sql, params).results[0];
          return row === undefined ? null : /** @type {T} */ (row);
        },
        /**
         * @template T
         * @returns {Promise<D1Result<T>>}
         */
        async all() {
          return /** @type {D1Result<T>} */ ({
            results: /** @type {T[]} */ (runOne(sql, params).results),
            success: /** @type {true} */ (true),
            meta: meta(),
          });
        },
        /**
         * @template T
         * @returns {Promise<D1Result<T>>}
         */
        async run() {
          return /** @type {D1Result<T>} */ ({
            results: /** @type {T[]} */ (runOne(sql, params).results),
            success: /** @type {true} */ (true),
            meta: meta(),
          });
        },
      })
    );
    bound.set(statement, { sql, params });
    return statement;
  };
  return /** @type {SqliteD1} */ (
    /** @type {unknown} */ ({
      sqlite,
      /** @param {string} sql */
      prepare(sql) {
        return statementFor(sql, []);
      },
      /**
       * @template T
       * @param {D1PreparedStatement[]} statements
       * @returns {Promise<D1Result<T>[]>}
       */
      async batch(statements) {
        /** @type {Array<{results: Record<string, unknown>[], changes: number}>} */
        const results = [];
        sqlite.exec("BEGIN");
        try {
          for (const statement of statements) {
            const state = bound.get(statement);
            if (!state) {
              throw new Error("a statement was batch-ran that this adapter did not prepare");
            }
            results.push(runOne(state.sql, state.params));
          }
        } finally {
          sqlite.exec("COMMIT");
        }
        return /** @type {D1Result<T>[]} */ (
          results.map((result) => ({
            results: /** @type {T[]} */ (result.results),
            success: /** @type {true} */ (true),
            meta: meta(),
          }))
        );
      },
      /**
       * D1's exec runs a multi-statement string; the tests never call it, but
       * the adapter speaks the interface rather than being cast silent.
       * @param {string} query
       */
      async exec(query) {
        sqlite.exec(query);
        return { count: 0, duration: 0 };
      },
      /**
       * D1's session API is not part of what the modules under test use; a
       * call would be a real bug, so it throws rather than standing in silently.
       * @param {string} [constraintOrBookmark]
       */
      withSession(constraintOrBookmark) {
        throw new Error(`a test adapter has no D1 session: ${String(constraintOrBookmark)}`);
      },
      async dump() {
        throw new Error("a test adapter has no dump");
      },
    })
  );
}

function rcloneRuns(bin) {
  return spawnSync(bin, ["version"], { stdio: "ignore" }).status === 0;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** The files the stand-in drive holds, and the name one of them is found by.
 * Names are built so one word (`invoice`) matches every file and a second
 * (`needle`) matches exactly one: the common search and the precise one. */
function fileName(i) {
  const stem = `file-${String(i).padStart(6, "0")}`;
  return i === FILES - 1 ? `${stem}-invoice-needle.pdf` : `${stem}-invoice.pdf`;
}

function filePath(i) {
  return `/folder-${i % FOLDERS}/${fileName(i)}`;
}

/** One account's files in a folder rclone serve s3 will list. Written straight
 * into the served directory: the stand-in is a local folder, so the files are
 * the bucket's objects without 100,000 round trips of setup. */
async function seedDrive(dir, bucket) {
  const root = path.join(dir, bucket, `u/${ACCOUNT.id}`);
  for (let f = 0; f < FOLDERS; f++) {
    await mkdir(path.join(root, `folder-${f}`), { recursive: true });
  }
  for (let start = 0; start < FILES; start += 2000) {
    const writes = [];
    for (let i = start; i < Math.min(start + 2000, FILES); i++) {
      writes.push(writeFile(path.join(root, filePath(i).slice(1)), ""));
    }
    await Promise.all(writes);
  }
}

/** A local `rclone serve s3` on a fresh folder, or the configured endpoint when
 * the environment names real storage. */
async function startStorage(t) {
  if (process.env.DRIVE_STANDIN_ENDPOINT) {
    return {
      endpoint: process.env.DRIVE_STANDIN_ENDPOINT,
      bucket: process.env.DRIVE_STANDIN_BUCKET ?? "bucket",
      stop: async () => {},
    };
  }
  const rclone = process.env.DRIVE_STANDIN_RCLONE ?? "rclone";
  if (!rcloneRuns(rclone)) {
    return null;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "drive-standin-search-"));
  const bucket = "bucket";
  t.after(() => rm(dir, { recursive: true, force: true }));
  await seedDrive(dir, bucket);
  const port = await freePort();
  // No --auth-key: the shipped S3 store sends unsigned requests (the scoped,
  // signed adapter is issue #2), so an authenticated stand-in would refuse the
  // very requests the proof measures.
  const server = spawn(rclone, ["serve", "s3", dir, "--addr", `127.0.0.1:${port}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(() => server.kill("SIGTERM"));
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (server.exitCode !== null)
      throw new Error(`rclone serve s3 exited ${server.exitCode}: ${stderr}`);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/${bucket}?list-type=2&prefix=u%2F${ACCOUNT.id}%2Ffolder-0%2F&delimiter=%2F`,
      );
      if (response.ok) {
        await response.text();
        break;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`rclone serve s3 never listened in 20s: ${stderr}`);
    await sleep(250);
  }
  return { endpoint: `http://127.0.0.1:${port}`, bucket, stop: async () => {} };
}

test("100,000 real files: the index search is under a second, the bucket walk it avoids is not", {
  skip: rcloneRuns(process.env.DRIVE_STANDIN_RCLONE ?? "rclone")
    ? false
    : "rclone is not installed",
}, async (t) => {
  const storage = await startStorage(t);
  if (!storage) {
    t.diagnostic("rclone is not installed; the S3 stand-in proof did not run");
    return;
  }
  const db = makeD1();
  // The exact wiring src/index.js's scheduled handler uses: the S3 store,
  // scoped to one account, walked by the reconciler.
  const store = scopeStore(
    createS3Store({ endpoint: storage.endpoint, bucket: storage.bucket }),
    ACCOUNT,
  );

  // The nightly build, timed: this is the walk a search must not repeat.
  const built = await reconcileIndex(db, store, ACCOUNT);
  assert.equal(built.indexed, FILES, `the walk found every file: ${JSON.stringify(built)}`);

  // The search. This is the issue's number.
  const common = await searchDrive(db, ACCOUNT, "invoice", { now: () => performance.now() });
  assert.equal(common.count, 50, "the default page is 50 results");
  assert.ok(
    common.tookMs < BUDGET_MS,
    `search over ${FILES} real files took ${common.tookMs.toFixed(1)}ms, budget ${BUDGET_MS}ms`,
  );
  assert.equal(common.results[0].path, filePath(0), "names come back as drive paths");

  // A precise name, the way a person looks for one file.
  const precise = await searchDrive(db, ACCOUNT, "needle", { now: () => performance.now() });
  assert.equal(precise.count, 1);
  assert.equal(precise.results[0].path, filePath(FILES - 1));
  assert.ok(
    precise.tookMs < BUDGET_MS,
    `the precise search took ${precise.tookMs.toFixed(1)}ms, budget ${BUDGET_MS}ms`,
  );

  // The counterfactual: the same question asked the way a mounted folder
  // answers it, by walking the bucket. This is the cost the index removes,
  // measured on the same files, in the same store.
  const walk = await reconcileIndex(db, store, ACCOUNT);
  t.diagnostic(
    [
      `files: ${FILES}`,
      `index build (one full bucket walk): ${walk.tookMs.toFixed(0)}ms`,
      `search "invoice": ${common.tookMs.toFixed(1)}ms`,
      `search "needle": ${precise.tookMs.toFixed(1)}ms`,
    ].join(" | "),
  );
  assert.ok(
    common.tookMs < walk.tookMs,
    `the index search (${common.tookMs.toFixed(1)}ms) must beat the bucket walk (${walk.tookMs.toFixed(0)}ms)`,
  );

  // The write feed over real storage: a file saved is in the index at once,
  // and a file removed leaves it.
  const live = scopeStore(
    withIndex(createS3Store({ endpoint: storage.endpoint, bucket: storage.bucket }), db, ACCOUNT),
    ACCOUNT,
  );
  await live.write("/folder-0/standin-write.pdf", "written over the stand-in", "application/pdf");
  const afterWrite = await searchDrive(db, ACCOUNT, "standin-write");
  assert.equal(afterWrite.count, 1, "a file written to the bucket is searchable at once");
  assert.equal(afterWrite.results[0].path, "/folder-0/standin-write.pdf");
  await live.remove("/folder-0/standin-write.pdf");
  const afterRemove = await searchDrive(db, ACCOUNT, "standin-write");
  assert.equal(afterRemove.count, 0, "a file removed from the bucket leaves the index");
});
