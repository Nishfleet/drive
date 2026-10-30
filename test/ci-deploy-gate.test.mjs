import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";
import { test } from "node:test";
import { HEALTH_PATH } from "../src/health.js";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const CI = read(".github/workflows/ci.yml");
const DEPLOY = read(".github/workflows/deploy-production.yml");

/** The `run: |` body of one step, dedented. @param {string} name */
const stepRun = (name) => {
  const start = DEPLOY.indexOf(name);
  assert.ok(start !== -1, `step missing: ${name}`);
  const next = DEPLOY.indexOf("\n      - name:", start + 1);
  const block = DEPLOY.slice(start, next === -1 ? DEPLOY.length : next);
  const body = /\n {8}run: \|\n((?:(?: {10}.*|\n)+))/.exec(block)?.[1];
  assert.ok(body, `step has no run block: ${name}`);
  return body.replace(/^ {10}/gm, "");
};

/** The top-level `on:` block of a workflow. @param {string} text */
const onBlock = (text) => {
  const start = text.search(/\non:(?: #.*)?\n/);
  const end = text.slice(start + 1).search(/\n[^\s#]/);
  return text.slice(start, start + 1 + end);
};

test("ci.yml runs on merge_group so the main merge queue gets verify and go", () => {
  const on = onBlock(CI);
  assert.match(on, /^ {2}merge_group:\s*$/m);
  assert.match(on, /^ {2}pull_request:\s*$/m);
  assert.match(on, /^ {2}push:\s*$/m);
  assert.match(CI, /^ {2}verify:\n/m);
  assert.match(CI, /^ {2}go:\n/m);
});

// drive#799: the two-device conflict proof is a named step of the go job,
// so a merge-group run cannot drop it (the paths filter skips `changes`,
// and the job then runs every step). The step has no continue-on-error.
// drive#868: the fixture-leftover gate rides on that step, so the go host is
// checked too and the workflow stays the same size (the ratchet allows no net
// added lines).
test("the go job still runs the two-device conflict proof, then the gate", () => {
  const start = CI.search(/^ {2}go:\n/m);
  assert.notEqual(start, -1, "ci.yml has a go job");
  const rest = CI.slice(start);
  const next = /^ {2}[\w-]+:/m.exec(rest.slice(1));
  const body = next ? rest.slice(0, 1 + next.index) : rest;
  assert.match(
    body,
    /- name: Two-device conflict proof, then no fixture outlives its run\n {8}run: go test \.\/cmd\/drive\/ -run TestTwoDevicesKeepBothSaves -v -timeout 300s && node --test test\/leftover-fixtures\.test\.mjs\n/,
  );
  const step = body.slice(body.indexOf("- name: Two-device conflict proof"));
  const stepEnd = step.search(/\n {6}- /);
  const lines = (stepEnd === -1 ? step : step.slice(0, stepEnd)).split("\n");
  for (const line of lines) {
    assert.doesNotMatch(
      line,
      /continue-on-error/,
      `the proof step never continues: ${line.trim()}`,
    );
  }
});

test("deploy starts from a successful CI run on a main push, never from push", () => {
  const on = onBlock(DEPLOY);
  assert.match(
    on,
    /^ {2}workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]\n {4}branches: \[main\]$/m,
  );
  assert.doesNotMatch(on, /^ {2}push:/m);
  const job = DEPLOY.slice(DEPLOY.indexOf("\n  deploy:"));
  const cond = /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(job)?.[1].replace(/\s+/g, " ").trim();
  assert.equal(
    cond,
    "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push')",
  );
  assert.match(DEPLOY, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
});

test("the deploy ships only a commit that is main's head and passed CI", () => {
  const guard = DEPLOY.indexOf("- name: Ship only a CI-green main head");
  assert.ok(guard !== -1 && guard < DEPLOY.indexOf("- name: Apply D1 migrations"));
  assert.match(DEPLOY, /test "\$SHA" = "\$head"/);
  assert.match(DEPLOY, /--workflow CI --branch main --commit "\$SHA" --status success/);
  assert.match(DEPLOY, /^ {2}actions: read/m);
});

// drive#1046: GitHub's run index lagged behind a completed CI run about a
// quarter of the time, so the step read "0 successful runs" and failed a push
// 14 seconds after CI went green. The job's `if:` already requires a
// successful push run, so the step must not read the run list on that path at
// all; only a start by hand still reads it.
test("a push trigger ships without reading CI's run list", (t) => {
  const shell = stepRun("- name: Ship only a CI-green main head");
  const dir = mkdtempSync(join(tmpdir(), "ci-deploy-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A `gh` that records every call and answers the two reads this step makes:
  // main's head, and the successful-run count for a hand start.
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
printf "%s\\n" "$*" >> "$CALLS"
case "$1 $2" in
  "api repos/$GITHUB_REPOSITORY/commits/main") printf "%s\\n" "$HEAD" ;;
  "run list") printf "%s\\n" "$GREEN" ;;
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  /** @param {Record<string, string>} extra */
  const run = (extra) => {
    const calls = join(dir, `calls-${Math.random().toString(36).slice(2)}`);
    const out = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail"], {
      input: shell,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        CALLS: calls,
        HEAD: "aaa111",
        GREEN: "1",
        GITHUB_REPOSITORY: "Nishfleet/drive",
        SHA: "aaa111",
        ...extra,
      },
      encoding: "utf8",
    });
    return { out, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
  };

  const pushed = run({ GITHUB_EVENT_NAME: "workflow_run" });
  assert.equal(pushed.out.status, 0, pushed.out.stderr);
  assert.match(pushed.calls, /commits\/main/, "the head check still runs on a push");
  assert.doesNotMatch(pushed.calls, /run list/, "a push trigger reads no run list");
  assert.match(pushed.out.stdout, /shipping aaa111: main head, CI passed/);

  const hand = run({ GITHUB_EVENT_NAME: "workflow_dispatch" });
  assert.equal(hand.out.status, 0, hand.out.stderr);
  assert.match(hand.calls, /run list/, "a start by hand still reads the run list");

  // An event name this step does not know, an unset one included, takes the
  // same branch: the run-list read stays the default, so a new trigger cannot
  // ship on an unproven commit.
  const other = run({ GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(other.out.status, 0, other.out.stderr);
  assert.match(other.calls, /run list/, "an unknown trigger still reads the run list");

  const unset = run({});
  assert.equal(unset.out.status, 0, unset.out.stderr);
  assert.match(unset.calls, /run list/, "an unset event name still reads the run list");

  const red = run({ GITHUB_EVENT_NAME: "workflow_dispatch", GREEN: "0" });
  assert.equal(red.out.status, 1);
  assert.match(red.out.stdout, /CI has not passed on aaa111/);

  const stale = run({ GITHUB_EVENT_NAME: "workflow_run", SHA: "bbb222" });
  assert.equal(stale.out.status, 1);
  assert.match(stale.out.stdout, /bbb222 is no longer main's head/);
});

test("the site Worker names storagebun.com and has no workers.dev address", () => {
  const config = read("cloudflare.config.ts");
  assert.match(config, /domains:\s*\[\s*"storagebun.com"\s*\]/);
  assert.match(config, /workersDev:\s*false/);
  assert.match(config, /previewUrls:\s*false/);
});

test("the deploy checks the live version and health, and rolls back on failure", () => {
  assert.ok(DEPLOY.includes(`https://storagebun.com${HEALTH_PATH}`));
  assert.match(DEPLOY, /storagebun\.com is reachable without the Access sign-in/);
  assert.match(DEPLOY, /id: live\n/);
  assert.match(DEPLOY, /test "\$vid" != "\$PREVIOUS_VERSION"/);
  assert.match(DEPLOY, /CF-Access-Client-Id: %s/);
  assert.match(DEPLOY, /-H "@\$headers"/);
  assert.match(
    DEPLOY,
    /curl -sS --fail --max-time \d+ --retry 5 --retry-delay 5 --retry-all-errors/,
    "a route that accepts the connection and never answers is bounded (drive#582)",
  );
  assert.doesNotMatch(
    DEPLOY,
    /-H "CF-Access-Client-Secret: \$/,
    "the token never sits in curl's arguments",
  );
  assert.match(DEPLOY, /if: failure\(\) && steps\.live\.outcome == 'success'/);
  assert.match(
    DEPLOY,
    /cf workers deployments create --worker drive-pricing --strategy percentage/,
  );
  // The rollback is the last step, so a failure in any check above reaches it.
  assert.ok(
    DEPLOY.lastIndexOf("- name:") === DEPLOY.indexOf("- name: Roll back the Worker version"),
  );
});

// drive#660: a pull request skips the jobs its files cannot affect, and the
// required checks still report. A workflow-level `paths:` would leave `verify`
// and `go` pending forever; a job skipped by `if:` reports success. Each job
// fails open: when `changes` did not succeed (skipped on merge_group and push,
// or broken), the job runs, so the merge queue always tests everything.
test("ci.yml skips by job-level if, fails open, and pins paths-filter by SHA", () => {
  assert.doesNotMatch(onBlock(CI), /paths(-ignore)?:/, "no workflow-level paths filter");
  assert.match(CI, /^ {4}if: github\.event_name == 'pull_request'$/m, "changes runs only on PRs");
  for (const job of ["verify", "go"]) {
    const body = new RegExp(
      `^ {2}${job}:\\n((?: {4}.*\\n|\\n)+?)(?= {4}runs-on:| {4}steps:)`,
      "m",
    ).exec(CI)?.[1];
    assert.ok(body, `${job} job found`);
    assert.match(body, /needs: changes/);
    const cond = body.replace(/\s+/g, " ");
    assert.match(
      cond,
      /!cancelled\(\) && \(needs\.changes\.result != 'success' \|\|/,
      `${job} fails open`,
    );
  }
  // A misspelt output reads as "", which would skip a job on every PR, so
  // every output a job reads must be one `changes` declares.
  const declared = new Set(
    [...CI.matchAll(/^ {6}(\w+): \$\{\{ steps\.(?:every|some)\.outputs\.\1 \}\}$/gm)].map(
      (m) => m[1],
    ),
  );
  const consumed = [...CI.matchAll(/needs\.changes\.outputs\.(\w+)/g)].map((m) => m[1]);
  for (const name of ["node", "node_extra", "go", "go_extra", "site", "site_extra"]) {
    assert.ok(declared.has(name), `changes declares ${name}`);
    assert.ok(consumed.includes(name), `a job or step reads ${name}`);
  }
  for (const name of consumed) assert.ok(declared.has(name), `${name} is a declared output`);
  const uses = [...CI.matchAll(/uses:\s*dorny\/paths-filter@(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length > 0, "the stock dorny/paths-filter does the classifying");
  for (const ref of uses) assert.match(ref, /^[0-9a-f]{40}$/, "pinned by commit SHA");
});

// drive#867: the skip filters must keep covering the classes that cannot
// affect a job, and skipping stays at job level: inside a running job, a
// repeated step `if:` is dead code. The merge queue's fail-open full run is
// the backstop for a mis-filed path.
test("ci.yml skips by whole job, and every pull request still runs verify or go", () => {
  const filters = [...CI.matchAll(/^ {10}filters: \|\n((?: {12}[^\n]*\n)+)/gm)]
    .map((m) => m[1])
    .join("");
  /** One filter's patterns, quoted or bare. @param {string} name */
  const patterns = (name) =>
    [...filters.matchAll(/^ {12}(\w+):\n((?: {14}- [^\n]*\n)*)/gm)]
      .find((m) => m[1] === name)?.[2]
      ?.match(/- .+/g)
      ?.map((line) => line.slice(2).trim().replace(/^'|'$/g, "")) ?? [];
  /**
   * Whether one `every` negation excludes a path, decided by Node's own
   * glob matcher (stable from Node 22.5, and CI runs Node 24), replacing
   * the hand-rolled one the review at
   * github.com/Nishfleet/drive/pull/1109#issuecomment-6517012244 blocked.
   * One divergence from the action remains, outside our control: paths-filter's
   * picomatch (`dot: true`) also matches dot-named path segments under a
   * plain `*` or `**`, and the built-in does not. Every dot-affected pattern in this filter
   * names its dot segment (`!.github/**`, `!{go.mod,go.sum}`), where the
   * two agree, so the corner is only reachable behind a new shape.
   * @param {string} pattern
   * @param {string} file
   */
  const excludes = (pattern, file) => {
    assert.ok(pattern.startsWith("!"), `every pattern is a negation: ${pattern}`);
    return matchesGlob(file, pattern.slice(1));
  };
  // The one divergence between the built-in and the action's picomatch
  // (`dot: true`), pinned so a Node change cannot silently move where the
  // simulation and the action disagree.
  assert.equal(
    matchesGlob("q/.draft.md", "**/*.md"),
    false,
    "the built-in does not match a dot-named segment under a plain wildcard; the action's picomatch does",
  );
  assert.equal(
    matchesGlob(".github/workflows/a.yml", ".github/**"),
    true,
    "a pattern that names the dot segment matches it in both matchers",
  );
  assert.equal(
    matchesGlob("cmd/update.go", "{cmd,internal}/**/*.go"),
    true,
    "the `**` inside a brace matches zero path segments, in both matchers",
  );
  /**
   * Does a job run for these changed files? `every`: no negation excludes
   * any file. `some`: one listed path is enough on its own.
   * @param {string[]} negations
   * @param {string[]} extras
   * @param {string[]} files
   */
  const runs = (negations, extras, files) =>
    files.every((f) => !negations.some((p) => excludes(p, f))) ||
    files.some((f) => extras.includes(f));
  const node = patterns("node");
  const nodeExtra = patterns("node_extra");
  /** @param {string[]} files */
  const verifyRuns = (files) => runs(node, nodeExtra, files);
  /** @param {string[]} files */
  const goRuns = (files) => runs(patterns("go"), patterns("go_extra"), files);
  /** @param {string[]} files */
  const siteRuns = (files) => runs(patterns("site"), patterns("site_extra"), files);

  // The node filter excludes exactly the Go side. Docs and .github files
  // stay in: the Node tests read them, and for a docs-only or workflow-only
  // pull request `verify` is the one job that sees it.
  assert.deepEqual(node, [
    "!docs/design/**",
    "!docs/research/**",
    "!{cmd,internal}/**/*.go",
    "!{go.mod,go.sum}",
  ]);

  // One file per class the filters claim to cover, against the real jobs.
  assert.equal(verifyRuns(["cmd/drive/doctor.go"]), false, "a Go-only PR skips verify");
  assert.equal(
    verifyRuns(["cmd/update.go"]),
    false,
    "the `**` in `{a,b}/**` matches zero path segments, so `cmd/update.go` is excluded, like the action's picomatch rules",
  );
  assert.equal(goRuns(["cmd/drive/doctor.go"]), true, "a Go-only PR runs go");
  assert.equal(goRuns([".github/workflows/ci.yml"]), false, "a workflow-only PR skips go");
  assert.equal(
    verifyRuns([".github/workflows/ci.yml"]),
    true,
    "a workflow-only PR runs verify: its attribution step and this test must see it",
  );
  assert.equal(verifyRuns(["docs/api.md"]), true, "a docs PR runs verify, as on main");
  assert.equal(verifyRuns(["cmd/drive/main.go"]), true, "main.go is read by the Node tests");
  assert.equal(siteRuns(["cmd/drive/main.go"]), true, "main.go is rendered into the pages");
  assert.equal(verifyRuns(["src/index.js"]), true, "a Worker PR runs verify");
  assert.equal(goRuns(["src/index.js"]), false, "a Worker PR skips go");
  assert.equal(
    verifyRuns(["cmd/README.md"]),
    true,
    "a markdown file under cmd runs verify: go skips *.md, so verify is the only job that sees it",
  );
  // A filter emptied by an indentation drift in patterns() would make every
  // assertion here vacuously true, so pin each one non-empty as a floor.
  for (const name of ["node", "go", "site", "node_extra", "site_extra", "go_extra"]) {
    assert.ok(patterns(name).length > 0, `${name} is a non-empty filter`);
  }

  // The attribution invariant: both jobs carry the attribution step, so no
  // changed file may leave a pull request with neither job running. The one
  // hole is the one main already has: a file under docs/design or
  // docs/research outside the _extra lists runs neither job.
  for (const file of [
    "src/index.js",
    "public/a.css",
    "workers/api/src/index.js",
    "core/files.js",
    "cmd/drive/main.go",
    "cmd/drive/doctor.go",
    "internal/api/api.go",
    "go.mod",
    "go.sum",
    "docs/api.md",
    "docs/build-spec.md",
    "docs/design/pricing-brief.md",
    "docs/research/folder-moves.md",
    "cmd/README.md",
    "internal/api/README.md",
    ".github/workflows/ci.yml",
    "docs-site/x.md",
    "README.md",
    "migrations/drive/0001.sql",
    "evals/agents/promptfooconfig.yaml",
  ]) {
    const hole =
      (file.startsWith("docs/design/") || file.startsWith("docs/research/")) &&
      ![...nodeExtra, ...patterns("go_extra"), ...patterns("site_extra")].includes(file);
    assert.equal(
      verifyRuns([file]) || goRuns([file]),
      !hole,
      `${file}: outside the design/research hole, a pull request must keep one of the two jobs`,
    );
  }

  const verify = CI.slice(CI.indexOf("\n  verify:\n"), CI.indexOf("\n  go:\n"));
  const steps = verify.split("\n      - ").slice(1);
  /** One flattened step block, or undefined. @param {string} needle */
  const stepFor = (needle) => steps.find((s) => s.includes(needle));
  const jobGate = verify.slice(0, verify.indexOf("runs-on")).replace(/\s+/g, " ");
  assert.match(
    jobGate,
    /needs\.changes\.result != 'success'/,
    "verify fails open when the filter job did not run",
  );
  assert.match(
    jobGate,
    /needs\.changes\.outputs\.node == 'true'/,
    "verify runs when the Node suite is affected",
  );
  assert.match(
    jobGate,
    /needs\.changes\.outputs\.node_extra == 'true'/,
    "verify runs for the files the Node tests read",
  );
  assert.equal(
    /if: >- (.*)$/.exec(jobGate)?.[1]?.trim() ?? "",
    "!cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.node == 'true' || needs.changes.outputs.node_extra == 'true')",
    "the gate is exactly this: fail open, then the output clauses OR, like the runs() helper below",
  );

  // Skipping is the job's `if:` alone. A step gate would repeat it and skip
  // nothing: the job only runs when the condition already holds.
  for (const [needle, label] of [
    ["run: npm ci", "npm ci"],
    ["Cache the rclone release", "the rclone cache"],
    ["Install rclone", "the rclone install"],
    ["Typecheck and Biome", "npm run check"],
    ["run: npm test", "npm test"],
  ]) {
    const step = stepFor(needle);
    assert.ok(step, `step found: ${label}`);
    assert.doesNotMatch(step, /if: needs\.changes/, `${label} carries no gate of its own`);
  }
  for (const name of ["Build the site", "Lighthouse CI"]) {
    const step = stepFor(`name: ${name}`);
    assert.ok(step, `step found: ${name}`);
    const cond = step.replace(/\s+/g, " ");
    assert.match(cond, /needs\.changes\.result != 'success'/, `${name} fails open`);
    assert.match(
      cond,
      /needs\.changes\.outputs\.site == 'true'/,
      `${name} runs when the pages' inputs change`,
    );
    assert.match(
      cond,
      /needs\.changes\.outputs\.site_extra == 'true'/,
      `${name} runs for the files rendered into the pages`,
    );
    assert.doesNotMatch(cond, /outputs\.node/, `${name} reads only the site filters`);
    assert.equal(
      /if: >- (.*?)(?= run:)/.exec(cond)?.[1]?.trim() ?? "",
      "needs.changes.result != 'success' || needs.changes.outputs.site == 'true' || needs.changes.outputs.site_extra == 'true'",
      "the site step's clauses OR, like the runs() helper; only the first assert pins site's own outputs",
    );
  }
  const scan = stepFor("name: Secret scan");
  assert.ok(scan, "step found: the secret scan");
  assert.doesNotMatch(
    scan,
    /if:/,
    "the secret scan carries no gate of its own: it runs whenever verify runs",
  );

  // The go job carries the attribution step too, so the Go-only pull
  // requests that skip verify still get theirs checked.
  const goJob = CI.slice(CI.indexOf("\n  go:\n"), CI.indexOf("\n  private-detail-scan:\n"));
  assert.match(
    goJob.replace(/\s+/g, " "),
    /needs\.changes\.outputs\.go == 'true'/,
    "go runs by its own filter",
  );
  assert.ok(
    goJob.includes("name: No agent attribution"),
    "the go job checks attribution for the pull requests only it sees",
  );
  // Symmetric: verify is the job a workflow-only or docs-only pull request
  // runs, so its own attribution step gets the same pin.
  const verifyJob = CI.slice(CI.indexOf("\n  verify:\n"), CI.indexOf("\n  go:\n"));
  assert.ok(
    verifyJob.includes("name: No agent attribution"),
    "the verify job checks attribution for the pull requests only it sees",
  );

  // Detector: a path the Node tests read may not sit in an area the node
  // filter excludes without a node_extra line, or its tests would skip on
  // the pull request and only the merge queue would catch the break. This
  // file's own fixtures are pinned above instead of scanned. The scan sees
  // every test tree and the areas the node filter excludes (test/integration
  // requires the walk; the review at
  // github.com/Nishfleet/drive/pull/1109#issuecomment-6517012244 named the
  // internal/ hole, and it was real); a path the tests compose with join()
  // still needs a node_extra line added by hand.
  const self = import.meta.url;
  const reads = new Set();
  /** One queue element: a directory URL to scan. @param {URL} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".mjs") && path.href !== self) {
        for (const m of readFileSync(path, "utf8").matchAll(
          /[`'"]((?:cmd|internal|docs|\.github)\/[\w./@+-]+)[`'"]/g,
        )) {
          reads.add(m[1]);
        }
      }
    }
  };
  walk(new URL("./", import.meta.url));
  for (const file of [
    "cmd/drive/e2e_test.go",
    "cmd/drive/logout_test.go",
    ".github/workflows/ci.yml",
  ]) {
    assert.ok(
      !node.some((p) => excludes(p, file)) || nodeExtra.includes(file),
      `${file}, which this test reads, must not be silently excluded`,
    );
  }
  for (const file of reads) {
    assert.ok(
      !node.some((p) => excludes(p, file)) || nodeExtra.includes(file),
      `${file} is read by the tests but the node filter excludes it and node_extra does not list it`,
    );
  }
});

// drive#759: `npm run check` (tsc --noEmit through the generated Workers
// types, then `biome check`) is a named step of its own in the verify job, so a
// red run says which tool turned it red instead of burying it in pretest's
// output above `npm test`.
test("ci.yml runs npm run check as its own step, and never fixes the diff", () => {
  // The whole verify job, steps included: the header-only slice the test above
  // takes stops at `steps:`, which is before any step lives.
  const start = CI.search(/^ {2}verify:\n/m);
  assert.notEqual(start, -1, "ci.yml has a verify job");
  const rest = CI.slice(start);
  const next = /^ {2}[\w-]+:/m.exec(rest.slice(1));
  const body = next ? rest.slice(0, 1 + next.index) : rest;
  const steps = body.split("\n      - ").slice(1);
  /** One step block. @param {string} run @returns {string | undefined} */
  const stepFor = (run) => steps.find((s) => s.includes(`run: ${run}`));
  const step = stepFor("npm run check");
  assert.ok(step, "the verify job runs npm run check as a named step");
  assert.match(step, /name: Typecheck and Biome/, "check is a named step");
  const suite = stepFor("npm test");
  assert.ok(suite, "the verify job runs npm test as a step of its own");
  assert.ok(
    body.indexOf("- name: Typecheck and Biome") < body.indexOf(suite),
    "check runs before npm test",
  );
  // The step is a report, never a rewrite: a CI run that fixes the diff and
  // passes would hide the error from the merge it was supposed to stop. Every
  // non-comment line of the job is read, so a `run: |` block's continuation
  // lines count too, while a comment may still name the rule.
  const lines = body.split("\n").filter((line) => !/^\s*#/.test(line));
  for (const line of lines) {
    assert.doesNotMatch(line, /--(write|fix)\b/, `ci.yml verify never runs \`${line.trim()}\``);
  }
  // The step runs whatever `npm run check` means, so the scripts it reaches
  // are held to the same rule.
  const { scripts } = JSON.parse(read("package.json"));
  for (const name of ["check", "precheck", "typecheck", "pretypecheck", "lint"]) {
    assert.doesNotMatch(scripts[name] ?? "", /--(write|fix)\b/, `npm run ${name} never fixes`);
  }
  // Same gate as `npm test`: the step carries no `if:`, so it runs whenever
  // the job runs, and the job-level `if:` is the paths filter above it.
  for (const gated of [step, suite]) {
    assert.doesNotMatch(
      gated,
      /if: needs\.changes/,
      "the check and test steps carry no gate of their own",
    );
  }
});

// drive#520: a migration is one-way (D1 has no down-migrations and the
// databases sit outside the Worker version a rollback restores), so the
// deploy records each database's Time Travel bookmark before the first
// `cf d1 migrations apply` and prints it on the run. A restore to that
// bookmark undoes a migration's writes; docs/runbook.md has the steps.
test("the deploy records a D1 restore point before any migration runs", () => {
  const record = DEPLOY.indexOf("- name: Record the D1 restore point");
  const apply = DEPLOY.indexOf("- name: Apply D1 migrations");
  assert.ok(record !== -1, "the restore-point step is missing");
  assert.ok(record < apply, "the restore point must be recorded before migrations apply");
  const step = DEPLOY.slice(record, apply);
  // The ids the step bookmarks must be the ids the migrations apply to, so a
  // database added to one list cannot silently miss the other.
  const applyIds = [...DEPLOY.slice(apply).matchAll(/migrations apply ([0-9a-f-]{36})/g)].map(
    (m) => m[1],
  );
  const pairLine = step.split("\n").find((line) => line.includes("for pair in"));
  assert.ok(pairLine, "the step walks the databases in one list");
  const bookmarkIds = [
    ...pairLine.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g),
  ].map((m) => m[0]);
  assert.deepEqual(bookmarkIds.sort(), applyIds.sort());
  assert.ok(applyIds.length >= 2, "both databases are bookmarked");
  assert.match(step, /time_travel\/bookmark/);
  // The bookmark must reach a human: the run log and the step summary.
  assert.match(step, /restore point for .+\(bookmark\)/);
  assert.match(step, /GITHUB_STEP_SUMMARY/);
  // A capture that fails or comes back empty fails the deploy here, before
  // any migration ran: no restore point, no migration.
  assert.match(step, /::error::no restore point for/);
  assert.match(step, /process\.exit\(1\)/);
  // The token goes to curl in a private file, never in its arguments.
  assert.match(step, /-H "@\$headers"/);
  assert.doesNotMatch(step, /Authorization: Bearer \$/);
});

// drive#170, #178: the same one-way rule orders the deploy itself. The
// databases sit outside the Worker version, so new tables and columns must
// exist before the first request can reach code that reads them; a rollback
// goes the other way (code back, data kept). The review of the known-bad
// list (drive issue #826) asked for this pin, because nothing else held the
// order: the workflow's comment says it, and prose is not a gate.
test("the deploy applies D1 migrations before the Worker ships", () => {
  const apply = DEPLOY.indexOf("- name: Apply D1 migrations");
  const deploy = DEPLOY.indexOf("- name: Deploy the Worker");
  assert.ok(apply !== -1, "the migration step is missing");
  assert.ok(deploy !== -1, "the deploy step is missing");
  assert.ok(apply < deploy, "migrations must apply before the Worker deploys");
  // Both steps must stay fail-fast: a `continue-on-error` or an `if:` gate
  // would let one run without the other, and the order would mean nothing.
  for (const [name, step] of [
    ["Apply D1 migrations", DEPLOY.slice(apply, deploy)],
    ["Deploy the Worker", DEPLOY.slice(deploy)],
  ]) {
    const body = step.slice(
      0,
      step.search(/\n {6}- name: /) === -1 ? step.length : step.search(/\n {6}- name: /),
    );
    assert.doesNotMatch(body, /continue-on-error/, `${name} never continues on error`);
    assert.doesNotMatch(body, /^\s+if:/m, `${name} has no gate of its own`);
  }
});

// drive#501: the two named mount proofs must actually run, on a hosted
// runner that can mount. The unit-test step uses -short and would skip them;
// these named steps do not. TestLogoutStopsALiveMount cannot get its own
// step (the worker App cannot update workflows), so it runs inside the
// -short unit tests when CI is set. A FUSE skip under CI=true is a failure,
// so a runner that cannot mount turns the job red instead of green-with-skips.
// ci.yml already carries the hosted runner and the two named steps (PR 757);
// this test is the pin that keeps them, so a later edit cannot quietly take
// the proofs off a mountable runner again.
test("ci.yml runs the mount proofs on ubuntu-latest, without -short", () => {
  const start = CI.search(/^ {2}go:\n/m);
  assert.notEqual(start, -1, "ci.yml has a go job");
  const rest = CI.slice(start);
  const next = /^ {2}[\w-]+:/m.exec(rest.slice(1));
  const body = next ? rest.slice(0, 1 + next.index) : rest;
  assert.match(body, /^ {4}runs-on: ubuntu-latest$/m, "the go job is a hosted runner");
  for (const name of ["TestStandinMountProof", "TestTwoDevicesKeepBothSaves"]) {
    // The selector ends at a space or end-of-line, so a longer test name that
    // merely starts with this one cannot satisfy the pin.
    const idx = body.search(new RegExp(`-run ${name}( |$)`));
    assert.notEqual(idx, -1, `the go job runs ${name} as its own command`);
    const stepStart = body.lastIndexOf("- name:", idx);
    assert.notEqual(stepStart, -1, `${name} sits inside a named step`);
    const fromName = body.slice(stepStart);
    const next = fromName.slice(1).search(/^\s+- name:|^ {2}[\w-]+:/m);
    const step = next === -1 ? fromName : fromName.slice(0, 1 + next);
    assert.doesNotMatch(step, /-short/, `${name} is not in -short mode`);
  }
  assert.match(
    body,
    /go test -race \.\/cmd\/drive\/ -short -v/,
    "the go job still runs -short unit tests",
  );
});

test("a FUSE skip is a failure under CI=true (drive#501)", () => {
  const e2e = read("cmd/drive/e2e_test.go");
  assert.match(e2e, /func skipNoMount\(/, "one helper owns the skip-or-fail choice");
  assert.match(e2e, /os\.Getenv\("CI"\) == "true"/, "the helper fails only for CI=true");
  assert.match(e2e, /a FUSE skip is a failure under CI=true/, "the failure names the rule");
  const logout = read("cmd/drive/logout_test.go");
  assert.match(
    logout,
    /if testing\.Short\(\) && os\.Getenv\("CI"\) != "true" \{/,
    "TestLogoutStopsALiveMount still runs under CI=true in the -short unit tests",
  );
});

test("a skip of a proof this runner can run is a failure under CI=true (drive#582)", async () => {
  const { readdirSync } = await import("node:fs");
  const testDir = new URL("../test/", import.meta.url);
  const writers = readdirSync(testDir)
    .filter((name) => name.endsWith(".mjs") && name !== "proof-skip.mjs")
    .filter((name) => name !== "ci-deploy-gate.test.mjs")
    .filter((name) => read(`test/${name}`).includes('from "./proof-skip.mjs"'))
    .map((name) => `test/${name}`)
    .sort();
  assert.deepEqual(
    writers,
    [
      "test/cap-mount.test.mjs",
      "test/files-page-click.test.mjs",
      "test/home-demos.test.mjs",
      "test/step1-storage.test.mjs",
      "test/step5-meter-standin.test.mjs",
    ],
    "every proof that imports the one skip report is scanned here, so a sixth proof joins this gate before it ships",
  );
  for (const file of writers) {
    assert.doesNotMatch(
      read(file),
      /function reportSkip\(/,
      `${file} carries no skip guard of its own`,
    );
  }
  const gated = ["chrome-file-click", "s3-standin", "cap-mount-rclone"];
  const ungated = ["cap-mount", "home-page-demos"];
  const reported = new Set();
  for (const file of writers) {
    for (const found of read(file).matchAll(/reportSkip\("([^"]+)"/g)) {
      reported.add(found[1]);
    }
  }
  for (const name of [...gated, ...ungated]) {
    assert.ok(reported.has(name), `${name} is a name a proof actually reports`);
  }
  assert.deepEqual(
    [...reported].sort(),
    [...gated, ...ungated].sort(),
    "every name a proof reports is on the gated list or on the cannot-run list, so the next silent skip is caught here",
  );

  const { reportSkip } = await import("../test/proof-skip.mjs");
  const previousCi = process.env.CI;
  const previousReport = process.env.DRIVE_PROOF_REPORT;
  const report = new URL("./skip-report.txt", import.meta.url);
  const { rm } = await import("node:fs/promises");
  /** @type {string[]} */
  const printed = [];
  const write = process.stdout.write.bind(process.stdout);
  /**
   * @param {string} chunk
   * @returns {boolean}
   */
  const capture = (chunk) => {
    printed.push(chunk);
    return true;
  };
  try {
    process.env.CI = "true";
    delete process.env.DRIVE_PROOF_REPORT;
    process.stdout.write = capture;
    for (const name of gated) {
      assert.throws(
        () => reportSkip(name, "the tool is not installed"),
        (err) => err instanceof Error && err.message.startsWith(`${name} skipped under CI=true`),
        `${name} is a failure under CI=true`,
      );
    }
    for (const name of ungated) {
      assert.equal(
        process.env.DRIVE_PROOF_REPORT,
        undefined,
        "the ambient proof report is unset while the ungated skips run, so a skip this test makes cannot reach the caller's real report",
      );
      assert.doesNotThrow(
        () => reportSkip(name, "the runner cannot do this"),
        `${name} still skips, because this runner cannot run it`,
      );
    }
    process.env.CI = "";
    process.env.DRIVE_PROOF_REPORT = report.pathname;
    reportSkip(ungated[0], "the runner cannot do this");
    assert.equal(
      readFileSync(report, "utf8"),
      `${ungated[0]}: the runner cannot do this\n`,
      "a skip outside CI still records one line when the caller asks for it",
    );
  } finally {
    process.stdout.write = write;
    process.env.CI = previousCi ?? "";
    if (previousReport === undefined) delete process.env.DRIVE_PROOF_REPORT;
    else process.env.DRIVE_PROOF_REPORT = previousReport;
    await rm(report, { force: true });
  }
  assert.deepEqual(
    printed.filter((line) => line !== "\n"),
    [
      ...ungated.map((name) => `proof skipped: ${name}: the runner cannot do this\n`),
      `proof skipped: ${ungated[0]}: the runner cannot do this\n`,
    ],
    "a gated name prints nothing and throws, and every skip that is allowed prints its name and reason, so CI's log carries the count per named proof",
  );
});
