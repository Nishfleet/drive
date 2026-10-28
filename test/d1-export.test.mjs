import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MIGRATION_FILES } from "./d1-sqlite.mjs";

const WF = readFileSync(new URL("../.github/workflows/d1-export.yml", import.meta.url), "utf8");
const DEPLOY = readFileSync(
  new URL("../.github/workflows/deploy-production.yml", import.meta.url),
  "utf8",
);

// The five shadow tables SQLite builds beside an FTS5 virtual table, named
// after it (https://www.sqlite.org/fts5.html): the file format, not a choice
// this repository makes.
const FTS5_SHADOW_TABLES = ["_config", "_content", "_data", "_docsize", "_idx"];
// Two tables no migration creates: D1's own `_cf_KV`, and the `d1_migrations`
// ledger `wrangler d1 migrations apply` writes. The export API dumps what the
// database holds, so the backup's list carries them.
const PLATFORM_TABLES = ["_cf_KV", "d1_migrations"];

/**
 * Every table the drive database's migrations create, minus the FTS5 family the
 * export API refuses a dump over. Built by running the real migrations, never
 * written out by hand, so a migration that adds a table fails the test below
 * until the backup's own list grows to carry it.
 *
 * @returns {string[]}
 */
function driveTablesFromMigrations() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of MIGRATION_FILES)
    sqlite.exec(readFileSync(new URL(`../migrations/drive/${name}`, import.meta.url), "utf8"));
  const rows = sqlite
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  const refused = new Set(
    rows
      .filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql ?? ""))
      .flatMap((row) => [row.name, ...FTS5_SHADOW_TABLES.map((shadow) => row.name + shadow)]),
  );
  return rows.map((row) => row.name).filter((name) => !refused.has(name));
}

/**
 * The `dump_options.tables` list the drive matrix entry sends.
 *
 * @returns {string[]}
 */
function driveDumpTables() {
  const matrix = WF.slice(WF.indexOf("matrix:"), WF.indexOf("steps:"));
  const drive = matrix.slice(matrix.indexOf("name: drive"));
  return JSON.parse(drive.match(/tables: (\[[^\]]*\])/)[1]);
}

/** The top-level `on:` block of a workflow. @param {string} text */
const onBlock = (text) => {
  const start = text.search(/\non:(?: #.*)?\n/);
  const end = text.slice(start + 1).search(/\n[^\s#]/);
  return text.slice(start, start + 1 + end);
};

test("the backup runs weekly and can be started by hand for a restore drill", () => {
  const on = onBlock(WF);
  assert.match(on, /^ {2}schedule:\n(?: {4}#[^\n]*\n)* {4}- cron: "\d+ \d+ \* \* \d+"$/m);
  assert.match(on, /^ {2}workflow_dispatch:(?: \{\})?(?: #[^\n]*)?$/m);
  // One schedule, weekly (day-of-week or day-of-month constrained), so 13
  // points survive the 90-day artifact retention.
  assert.equal([...on.matchAll(/- cron:/g)].length, 1);
});

test("the backup reads only the deploy credentials, behind the production environment", () => {
  // The deploy job's environment block, for the same reason drive#507 keeps
  // the deploy secrets there: test/workflow-secrets.test.mjs enforces the
  // pairing, and this assert names it so the two move together.
  assert.match(WF, /^ {4}environment:\n {6}name: production$/m);
  const secrets = [...WF.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secrets)].sort(), ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
});

test("the backup walks exactly the databases the deploy migrates", () => {
  const deployIds = [
    ...DEPLOY.matchAll(
      /migrations apply ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g,
    ),
  ].map((m) => m[1]);
  const matrix = WF.slice(WF.indexOf("matrix:"), WF.indexOf("steps:"));
  assert.ok(matrix.length > 0, "the export walks the databases in one matrix");
  const backupIds = [
    ...matrix.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g),
  ].map((m) => m[0]);
  assert.deepEqual(backupIds.sort(), deployIds.sort());
  assert.ok(deployIds.length >= 2, "both databases are exported");
});

test("the drive dump carries every table the migrations build, and no virtual table", () => {
  const tables = driveDumpTables();
  // Exact, both ways: a migration that adds a table fails here until the list
  // grows, and a name the schema does not have fails here too.
  const expected = [...driveTablesFromMigrations(), ...PLATFORM_TABLES].sort();
  assert.deepEqual([...tables].sort(), expected);
  // The FTS5 index is the one thing the dump cannot carry, and the only reason
  // the drive database needs a list at all.
  assert.ok(!tables.includes("file_index_fts"), "the virtual table stays out of the dump");
  for (const shadow of FTS5_SHADOW_TABLES)
    assert.ok(!tables.includes(`file_index_fts${shadow}`), `${shadow} stays out of the dump`);
});

test("the waitlist database exports whole and sends no table filter", () => {
  const matrix = WF.slice(WF.indexOf("matrix:"), WF.indexOf("steps:"));
  const waitlist = matrix.slice(matrix.indexOf("name: waitlist"), matrix.indexOf("name: drive"));
  assert.match(waitlist, /tables: \[\]/);
  assert.match(WF, /DB_TABLES: \$\{\{ toJSON\(matrix\.database\.tables\) \}\}/);
});

test("the dump request body is the stock export call, filtered only where it must be", () => {
  // The real script from the workflow, run: a body the API would refuse, or a
  // waitlist dump filtered by mistake, is a backup that does not restore.
  const script = WF.match(/body=\$\(node -e '([^']*)' "\$bookmark"\)/)[1];
  assert.ok(script, "the dump request body is built by the runtime, not by shell quoting");
  /** @returns {Record<string, unknown>} */
  const body = (tables, bookmark) =>
    JSON.parse(
      execFileSync(process.execPath, ["-e", script, bookmark], {
        encoding: "utf8",
        env: { ...process.env, DB_TABLES: JSON.stringify(tables) },
      }),
    );
  assert.deepEqual(body([], ""), { output_format: "polling" });
  assert.deepEqual(body([], "bm"), { output_format: "polling", current_bookmark: "bm" });
  assert.deepEqual(body(["file_index"], ""), {
    output_format: "polling",
    dump_options: { tables: ["file_index"] },
  });
  assert.deepEqual(body(["file_index"], "bm"), {
    output_format: "polling",
    current_bookmark: "bm",
    dump_options: { tables: ["file_index"] },
  });
});

test("the matrix walks every database, and one failure costs only its own job", () => {
  // Both databases ride the matrix, and the stock shape is what makes a refusal
  // visible: `fail-fast: false` keeps a refused database from cancelling the
  // other, and each job uploads its own dump as its own artifact, so a run that
  // carried one dump is never read as "both databases are backed up".
  const strategy = WF.slice(WF.indexOf("strategy:"), WF.indexOf("steps:"));
  assert.match(
    strategy,
    /fail-fast: false/,
    "a database the export API refuses must not cancel the others",
  );
  assert.match(
    strategy,
    /matrix:\n {8}database:\n(?: {10}- \{ name: \w+, id: [0-9a-f-]{36}, tables: \[[^\]]*\] \}\n(?: {10}#[^\n]*\n)*){2}/,
    "one job per database, each carrying its own id",
  );
  // The stock shape, not a hand-rolled loop: nothing collects the failures,
  // nothing steps past one, and no step waits for a failed database before
  // it ships.
  assert.doesNotMatch(WF, /for pair in/, "the matrix walks the databases, not a shell loop");
  assert.doesNotMatch(WF, /missing=/, "a database that cannot dump fails its own job");
  assert.doesNotMatch(WF, /continue/, "nothing steps past a failed database");
  assert.doesNotMatch(WF, /if: always\(\)/, "no step waits for a failed database to ship");
  // Each job uploads its own dump, so the dumps that were made still ship.
  assert.match(
    WF,
    /name: d1-backup-\$\{\{ matrix\.database\.name \}\}/,
    "each database's dump is its own artifact",
  );
  assert.match(
    WF,
    /if-no-files-found: error/,
    "a job that produced nothing does not upload an empty artifact",
  );
});

test("the export polls the stock D1 export API and fails loud at every exit", () => {
  assert.match(WF, /d1\/database\/\$DB_ID\/export/);
  assert.match(WF, /output_format/g);
  assert.match(WF, /current_bookmark/g);
  // The signed URL arrives only on status complete; a dump without one, a
  // failed download, and an API error each fail the job with a named error.
  assert.match(WF, /no download URL after 20 polls/);
  assert.match(WF, /the dump download failed/);
  assert.match(WF, /the API call failed/);
  // Every exit is loud and fatal for its own job: the database that failed
  // is named and the job stops there, so the run's own job list is the
  // signal. A database that cannot dump never reaches the upload step.
  const dump = WF.slice(
    WF.indexOf("- name: Dump and seal"),
    WF.indexOf("- name: Upload the sealed dump"),
  );
  assert.ok(dump.length > 0, "the dump step is gone");
  const exits = dump.split("\n").filter((line) => /::error::/.test(line) && /exit 1\b/.test(line));
  assert.ok(exits.length >= 6, "every failure exit names the database and stops the job");
  // A run that produced nothing must not upload an empty artifact.
  assert.match(WF, /if-no-files-found: error/);
});

test("the dump lands as a pinned, 90-day artifact", () => {
  const uses = [...WF.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length > 0, "the workflow uses pinned actions");
  for (const ref of uses)
    assert.match(ref.split("@")[1], /^[0-9a-f]{40}$/, `pinned by commit SHA: ${ref}`);
  assert.match(WF, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(WF, /retention-days: 90/);
});

test("the dump is fetched as data by the runtime, never as a curl executable download", () => {
  // The signed URL changes every run, so no digest can be pinned; the gate
  // (drive#581, test/workflow-downloads.test.mjs) is about assets that run.
  // The dump is written to the runner's temp and shipped as an artifact,
  // never executed, so the runtime's own fetch takes it — and this file
  // fails if that fetch is ever swapped for a curl/wget download. The age
  // release download later in the file is a different fetch on purpose: it
  // is digest-pinned in its own test below, not counted here.
  const downloads =
    WF.match(
      /\bnode -e 'const fs=require\("fs"\);\(async\(\)=>\{const r=await fetch\(process\.argv\[1\]\)/g,
    ) ?? [];
  assert.equal(downloads.length, 1, "exactly one fetch of the signed URL");
  assert.doesNotMatch(WF, /\bcurl\b[^\n]*\s-o\s|\bcurl\b[^\n|>]*\|/);
  assert.doesNotMatch(WF, /\bwget\b/);
});

test("the dumps are encrypted before they touch an artifact", () => {
  // The weekly dump is customer data, and a GitHub artifact is readable by
  // everyone with repo read, so only ciphertext ships (review finding on PR
  // #697). The recipient is the repo variable `AGE_RECIPIENT` — a public
  // key, never a secret — and a run without it fails loud instead of
  // shipping plaintext or quietly skipping the backup.
  assert.match(WF, /\$\{\{ vars\.AGE_RECIPIENT \}\}/);
  assert.match(WF, /the age recipient is unset/);
  assert.match(WF, /age-bin\/age" -r "\$AGE_RECIPIENT" -o "\$file\.age" "\$file"/);
  assert.match(WF, /rm -f "\$file"/);
  // The artifact carries only the .age files.
  assert.match(WF, /path: \$\{\{ runner\.temp \}\}\/d1-export\/\*\.sql\.age$/m);
  assert.doesNotMatch(WF, /path: \$\{\{ runner\.temp \}\}\/d1-export\/\*\.sql$/m);
});

test("the age binary is a digest-pinned release download", () => {
  // docs/security.md's gate: an executable a workflow downloads is checked
  // against a digest pinned in this repository, in the same step.
  assert.match(WF, /AGE_VERSION: v\d+\.\d+\.\d+/);
  assert.match(
    WF,
    /echo "\$AGE_LINUX_AMD64_SHA256 {2}\$RUNNER_TEMP\/age\.tar\.gz" \| sha256sum -c -/,
  );
  const pins = readFileSync(new URL("../docs/security.md", import.meta.url), "utf8");
  assert.match(pins, /AGE_LINUX_AMD64_SHA256/);
});
