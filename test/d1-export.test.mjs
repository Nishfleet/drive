import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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
  const pairLine = WF.split("\n").find((line) => line.includes("for pair in"));
  assert.ok(pairLine, "the export walks the databases in one list");
  const backupIds = [
    ...pairLine.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g),
  ].map((m) => m[0]);
  assert.deepEqual(backupIds.sort(), deployIds.sort());
  assert.ok(deployIds.length >= 2, "both databases are exported");
});

test("the export polls the stock D1 export API and fails loud at every exit", () => {
  assert.match(WF, /d1\/database\/\$db\/export/);
  assert.match(WF, /output_format/g);
  assert.match(WF, /current_bookmark/g);
  // The signed URL arrives only on status complete; a dump without one, a
  // failed download, and an API error each fail the step with a named error.
  assert.match(WF, /no download URL after 20 polls/);
  assert.match(WF, /the dump download failed/);
  assert.match(WF, /the API call failed/);
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

test("the drive database rides the query API, not the export API", () => {
  // The stock export API refuses a database that holds virtual tables
  // (FTS5 — Cloudflare's documented limitation, proven on a live run: run
  // #40714070907 exported `waitlist` and died on `drive` with "cannot export
  // databases with virtual tables (like FTS5)"), and table filtering does
  // not silence that refusal (run #40715881740, same error with every real
  // table handed to `dump_options.tables`). So `waitlist` keeps the stock
  // export call and `drive` is a schema dump that travels over the read-only
  // query API, paged by rowid.
  assert.match(
    WF,
    /for pair in "waitlist [0-9a-f-]+ export" "drive [0-9a-f-]+ dump";/,
    "the waitlist pair exports through the D1 export API, the drive pair dumps over the query API",
  );
  assert.match(WF, /\/d1\/database\/\$\{DB\}\/query/);
  assert.match(WF, /const query = \(sql, params\) => \{/);
  assert.match(WF, /WHERE rowid > \? ORDER BY rowid LIMIT \$\{PAGE\}/);
  // The dump program exists only inside the run, never as a check-out file:
  // the workflow writes it into $RUNNER_TEMP (runnable code in `bin/` or
  // `scripts/` is banned in this repository) and deletes it with the run.
  assert.match(WF, /cat > "\$RUNNER_TEMP\/d1-dump\.cjs" <<'DUMP'/);
  assert.match(WF, /rm -f "\$RUNNER_TEMP\/d1-dump\.cjs"/);
  assert.doesNotMatch(WF, /[^/]d1-dump\.cjs$/m, "no d1-dump file at the repository root");
});

test("the dump leaves the FTS objects out and fails loud", () => {
  // FTS5's shadow tables and triggers carry the virtual table's name as a
  // prefix (file_index_fts_data, file_index_fts_ai), so the same prefix rule
  // that keeps the shadow tables out keeps the triggers out; migration 0039
  // rebuilds the whole FTS index on a restore (docs/runbook.md).
  assert.match(WF, /n === v \|\| n\.startsWith\(v \+ "_"\)/);
  assert.match(WF, /type IN \('table','index','trigger'\)/);
  // A backup that quietly refuses to ship is drive#520's invisibility again:
  // an empty schema fails the run instead of shipping an empty dump, and a
  // table that cannot be paged through inside one window fails the run
  // instead of truncating.
  assert.match(WF, /the schema has no real tables to back up/);
  assert.match(WF, /MAX_PAGES \* PAGE/);
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
