import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const WF = readFileSync(new URL("../.github/workflows/d1-export.yml", import.meta.url), "utf8");
const DEPLOY = readFileSync(
  new URL("../.github/workflows/deploy-production.yml", import.meta.url),
  "utf8",
);

/** The top-level `on:` block of a workflow. @param {string} text */
const onBlock = (text) => {
  const start = text.search(/\non:(?: #.*)?\n/);
  const end = text.slice(start + 1).search(/\n[^\s#]/);
  return text.slice(start, start + 1 + end);
};

/** One row of the backup matrix, as a [name, id] pair.
 *  @param {string} text */
const matrixRows = (text) =>
  [...text.matchAll(/^ {10}- \{ name: "?(\w+)"?, id: ([0-9a-f-]{36})[,} ]/gm)].map((m) => [
    m[1],
    m[2],
  ]);

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
  assert.deepEqual(
    [...new Set(secrets)].sort(),
    ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
    "the backup key's private half never goes into Actions: the restore drill runs on the fleet host (fleet-ops#10594)",
  );
});

test("the backup walks every database the fleet owns, not only the deploy's", () => {
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
  // drive's own two stay in the matrix whatever else joins it: the deploy
  // migrates them, so a dump that stopped covering them would be a backup
  // that silently lost a database.
  for (const id of deployIds)
    assert.ok(backupIds.includes(id), `the deploy migrates ${id} and the backup must dump it`);
  assert.ok(deployIds.length >= 2, "both databases are exported");
  const PRODUCT_DATABASES = [["0509", "746c6e3d-782e-443a-82d6-28ca93a16294"]];
  const entries = matrixRows(matrix);
  // One owner per database: these two are exported by their own
  // repositories' d1-export.yml on the same cron, and a second export of the
  // same database here only doubles the work and the artifacts.
  for (const [name, owner] of [
    ["siterep_payments", "siterep-public"],
    ["aiconverter", "aiconverter-app"],
  ])
    assert.ok(
      !entries.some(([entryName]) => entryName === name),
      `${name} is backed up by ${owner}'s own d1-export.yml; drive must not export it a second time`,
    );
  for (const [name, id] of PRODUCT_DATABASES) {
    const row = entries.find(([entryName]) => entryName === name);
    assert.ok(row, `${name} is a product database and must be in the weekly backup matrix`);
    assert.equal(row[1], id, `${name} is exported under id ${id}`);
  }
  assert.ok(
    backupIds.length >= deployIds.length + PRODUCT_DATABASES.length,
    "the matrix covers drive's own databases and the fleet's product databases",
  );
});

test("a database that cannot be dumped fails its own job, and the others still ship", () => {
  const strategy = WF.slice(WF.indexOf("strategy:"), WF.indexOf("steps:"));
  assert.match(
    strategy,
    /fail-fast: false/,
    "a database the export API refuses must not cancel the others",
  );
  const entries = matrixRows(strategy);
  assert.ok(entries.length >= 2, "one job per database, each carrying its own id");
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

test("the runbook's cf d1 commands parse as written, and each query sends its whole file", (t) => {
  const runbook = readFileSync(new URL("../docs/runbook.md", import.meta.url), "utf8");
  const commands = runbook.match(/npx cf d1 (?:query|time-travel restore) [^`\n]+/g) ?? [];
  assert.ok(commands.length >= 4, `found ${commands.length} cf d1 commands in docs/runbook.md`);
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "runbook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(join(repo, "migrations"), join(dir, "migrations"));
  writeFileSync(join(dir, "dump.sql"), "-- one table\nSELECT 1;\n");
  for (const line of commands) {
    const cmd = line
      .replace("npx cf", JSON.stringify(join(repo, "node_modules/.bin/cf")))
      .replace("<database-id>", "00000000-0000-0000-0000-000000000000")
      .replace("<deploy-start-time>", "2026-11-01T00:00:00Z");
    const run = spawnSync("sh", ["-c", cmd.includes("--dry-run") ? cmd : `${cmd} --dry-run`], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
    });
    assert.equal(run.status, 0, `${line}\n${run.stderr}${run.stdout}`);
    const file = line.match(/\$\(cat ([^)]+)\)/)?.[1];
    if (file) {
      const sql = readFileSync(join(dir, file), "utf8").replace(/\n+$/, "");
      assert.equal(JSON.parse(run.stdout).body.sql, sql, line);
    }
  }
});

test("a numeric database name stays a string, so its artifact keeps the name the runbook gives", () => {
  // Unquoted, YAML reads 0509 as the number 509, and the artifact shipped as
  // d1-backup-509 (run 41831086013) while the runbook and the host restore
  // drill ask for d1-backup-0509.
  assert.doesNotMatch(WF, /name: \d+[,} ]/);
});
