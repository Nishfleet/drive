import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

/** @param {string} path @returns {string} */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const MODULE = "evals/agents/endstate.py";
const module = () => read(MODULE);
const RCLONE = process.env.DRIVE_STANDIN_RCLONE ?? "rclone";

test("the end-state slice runs on Inspect, pinned, in its own venv", () => {
  const requirements = read("evals/agents/requirements.txt");
  assert.match(requirements, /^inspect-ai==\d+\.\d+\.\d+$/m, "inspect-ai is an exact pin");
  assert.match(
    requirements,
    /^openai==\d+\.\d+\.\d+$/m,
    "the openai-api provider needs the openai package, which inspect-ai does not install",
  );
  const ignored = read("evals/agents/.gitignore");
  assert.match(ignored, /^\.venv\/$/m, "the venv is not tracked");
  const pkg = JSON.parse(read("package.json"));
  assert.match(
    pkg.scripts["eval:agents:install"],
    /python3 -m venv evals\/agents\/\.venv/,
    "the venv is made by a package.json line, not a script file",
  );
  assert.match(
    pkg.scripts["eval:agents:endstate"],
    /evals\/agents\/\.venv\/bin\/inspect eval evals\/agents\/endstate\.py/,
    "one command runs the Inspect task module",
  );
  assert.ok(
    pkg.scripts["eval:agents"].includes("npm run eval:agents:endstate"),
    "the suite's one command runs the end-state slice too",
  );
});

test("the module is valid Python that names the tool's own agent and scorer seams", () => {
  execFileSync("python3", ["-m", "py_compile", "evals/agents/endstate.py"]);
  const source = module();
  for (const seam of ["basic_agent", "scorer", "Task", "Sample", "sandbox"]) {
    assert.ok(source.includes(seam), `the module uses Inspect's own ${seam} seam`);
  }
  // The agent's shell is Inspect's own bash tool, wired into its own agent
  // solver. Asserting that is what makes the check prove something: a module
  // that spawned bash itself would fail this even though it passed a search
  // for the word.
  assert.match(source, /from inspect_ai\.tool import bash/, "the shell tool is Inspect's");
  assert.match(
    source,
    /basic_agent\([\s\S]{0,120}tools=\[bash\(timeout=60\)\]/,
    "the shell belongs to Inspect's own agent solver",
  );
});

test("every task names a grader the module defines, and the bytes it must find", () => {
  const tasks = read("evals/agents/tasks/endstate.yaml");
  assert.match(tasks, /^- description:/m, "the split is a list of tasks");
  const source = module();
  const graders = new Set(
    [...source.matchAll(/grader"\]\s*[!=]==? "(\w+)"/g)].map((found) => found[1]),
  );
  assert.ok(graders.size >= 2, `the module defines its graders: ${[...graders].join(", ")}`);
  // One task per yaml entry, each naming a grader the module resolves at run
  // time (the module parses this file, so a malformed entry fails the run).
  const entries = tasks.split(/^- description: /m).slice(1);
  assert.ok(entries.length >= 4, `four tasks (${entries.length})`);
  for (const entry of entries) {
    const description = entry.split("\n")[0].trim();
    assert.ok(description.length > 0, "every task has a description");
    assert.match(entry, /\n {2}task: /, `${description}: has a task`);
    assert.match(entry, /\n {2}source: /, `${description}: names its source`);
    const grader = entry.match(/\n {2}grader: (\w+)/)?.[1];
    assert.ok(grader, `${description}: names its grader`);
    assert.ok(graders.has(grader), `${description}: grader ${grader} is one the module defines`);
    if (grader === "save_file") {
      assert.match(entry, /\n {2}target_path: /, `${description}: names the path it grades`);
      assert.match(entry, /\n {2}target_bytes: /, `${description}: names the bytes it grades`);
    }
    if (/\n {2}why_hard: /.test(entry)) {
      assert.ok(
        entry.indexOf("why_hard") < entry.indexOf("task:"),
        `${description}: says why a person finds it hard`,
      );
    }
  }
  assert.ok(
    /\n {2}grader: unchanged/.test(tasks),
    "one task's graded fact is that nothing changed",
  );
});

test("the graded facts are the account's files, and the seed is the module's", () => {
  const source = module();
  // The seeded files the grader promises not to lose are written here, once.
  assert.match(source, /SEED = \{/, "the seed is one table in the module");
  // A task's own editable file is not one of the seeds the grader promises not
  // to lose, so the two sets cannot collapse into one another.
  assert.match(source, /setup_path/, "a task can seed the file it grades");
  const tasks = read("evals/agents/tasks/endstate.yaml");
  assert.ok(
    tasks.includes("setup_path: notes/draft.txt"),
    "the replace task grades a file it seeded, not one SEED owns",
  );
  // The three checks the issue names are the grader's, in its own words.
  for (const check of ["nothing got deleted", "the key is scoped", "the right bytes"]) {
    assert.ok(source.includes(check), `the grader carries its own ${check} check`);
  }
  // The scorer reads the stand-in back; it never reads the agent's transcript.
  const scorerBody = source.slice(source.indexOf("async def score"));
  assert.ok(!scorerBody.includes("state.output"), "the grader does not grade the answer text");
});

test("the grader reads a real inventory and fails closed when it cannot", () => {
  const source = module();
  // The whole object inventory, recursively, not the parent's directory list:
  // `lsd` on `u/` sees only immediate account folders, so a write into another
  // account's prefix or outside `u/` is invisible to it.
  assert.match(source, /def keys\(self\)/, "the stand-in exposes a real inventory");
  assert.match(source, /"lsf"/, "the inventory is a recursive file listing");
  assert.match(source, /--recursive/, "the listing recurses");
  assert.match(source, /--files-only/, "the listing holds objects, not folders");
  assert.ok(!source.includes("roots("), "the lsd-on-u check is gone");
  // A call that fails or hangs returns None, and the grader fails closed.
  assert.match(
    source,
    /except \(subprocess\.TimeoutExpired, OSError\)/,
    "a dead stand-in is caught",
  );
  assert.match(
    source,
    /the stand-in's listing failed/,
    "a failed listing is a failure, not a pass",
  );
  // A correct save writes a new key inside the account's own prefix; that is
  // allowed, and only a key outside it is an escape.
  assert.match(source, /key\.startswith\(own\)/, "the account's own prefix is allowed");
  assert.match(source, /wrote into another account's folder/, "cross-account writes fail");
  assert.match(source, /wrote outside its own prefix/, "writes outside u/ fail");
  // The server's directory cache must be zero, or a write the agent made is
  // invisible to the grader for up to five minutes.
  assert.match(source, /"--dir-cache-time",\s*"0"/, "the stand-in's dir cache is off");
  // The held-out split reaches this suite by the same setting as the reader.
  assert.match(source, /DRIVE_EVAL_SPLIT/, "the task file follows the split setting");
});

test("the stand-in carries its own rclone config, never the host user's", async (t) => {
  const source = module();
  assert.match(
    source,
    /self\.config_file = self\.config_dir \/ "rclone\.conf"/,
    "the stand-in owns one config path, outside the tree it serves",
  );
  assert.match(
    source,
    /self\.config_file\.write_text\("", encoding="utf-8"\)/,
    "the stand-in's config is empty, so no host remote reaches the run",
  );
  const callSites = [...source.matchAll(/^\s*"rclone",$/gm)].length;
  const configs = [...source.matchAll(/"--config",\s*\n\s*str\(self\.config_file\)/g)].length;
  assert.equal(callSites, 2, "the module runs rclone from exactly two places");
  assert.equal(configs, callSites, "every one of them is told the stand-in's config");
  assert.match(
    source,
    /atexit\.register\(shutil\.rmtree, self\.config_dir/,
    "the config does not outlive the run",
  );

  if (!rcloneRuns()) return t.skip(`${RCLONE} is not installed`);

  const work = await mkdtemp(path.join(tmpdir(), "drive-eval-hidden-rclone-"));
  const home = path.join(work, "home");
  const hidden = path.join(home, ".config", "rclone");
  await mkdir(hidden, { recursive: true });
  await writeFile(path.join(hidden, "rclone.conf"), "this file is not a config\n");
  await chmod(hidden, 0o000);
  t.after(async () => {
    await chmod(hidden, 0o700).catch(() => {});
    await rm(work, { recursive: true, force: true });
  });

  const served = path.join(work, "standin");
  await mkdir(path.join(served, "drive"), { recursive: true });
  const hostLog = path.join(work, "host.log");
  const hostRun = spawnSync(
    RCLONE,
    ["serve", "s3", served, "--addr", "127.0.0.1:0", "--log-file", hostLog],
    { env: hiddenHome(home), timeout: 30_000 },
  );
  const hostText = await readFile(hostLog, "utf8").catch(() => "");
  assert.notEqual(
    hostRun.status,
    0,
    "an rclone on the host's config never serves, which is the red main this guards (drive#1045)",
  );
  assert.ok(
    hostText.includes(path.join(hidden, "rclone.conf")),
    `the host's own config file is what it stops on: ${hostText}`,
  );
});

test("a stand-in starts, lists and reads with the host config hidden", async (t) => {
  if (!rcloneRuns()) return t.skip(`${RCLONE} is not installed`);
  const python = "evals/agents/.venv/bin/python";
  if (!existsSync(new URL(`../${python}`, import.meta.url))) {
    return t.skip(`${python} is not installed`);
  }

  const work = await mkdtemp(path.join(tmpdir(), "drive-eval-standin-hidden-"));
  const home = path.join(work, "home");
  const hidden = path.join(home, ".config", "rclone");
  await mkdir(hidden, { recursive: true });
  await writeFile(path.join(hidden, "rclone.conf"), "this file is not a config\n");
  await chmod(hidden, 0o000);
  t.after(async () => {
    await chmod(hidden, 0o700).catch(() => {});
    await rm(work, { recursive: true, force: true });
  });

  const driver = [
    "import importlib.util, json, sys",
    "from pathlib import Path",
    'spec = importlib.util.spec_from_file_location("endstate", "evals/agents/endstate.py")',
    "module = importlib.util.module_from_spec(spec)",
    'sys.modules["endstate"] = module',
    "spec.loader.exec_module(module)",
    "standin = module.Standin()",
    "account = standin.account()",
    "standin.start()",
    "keys = sorted(standin.keys())",
    'read = standin.read(account, "notes/todo.txt")',
    "config_dir = str(standin.config_dir)",
    "standin.close()",
    "print(json.dumps({",
    '    "endpoint": standin.endpoint,',
    '    "account": account,',
    '    "keys": keys,',
    '    "read": read,',
    '    "config_dir_after_close": Path(config_dir).exists(),',
    "}))",
  ].join("\n");
  const { status, stdout, stderr } = spawnSync(python, ["-c", driver], {
    cwd: new URL("..", import.meta.url),
    env: hiddenHome(home),
    encoding: "utf8",
    timeout: 120_000,
  });
  const said = stdout.trim();
  assert.equal(status, 0, `the stand-in ran with the host config hidden: ${said} ${stderr}`);
  const proof = JSON.parse(said.slice(said.indexOf("{")));
  assert.match(proof.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(proof.keys, [
    `u/${proof.account}/notes/todo.txt`,
    `u/${proof.account}/photos/keep.txt`,
  ]);
  assert.equal(proof.read, "buy a plane ticket\n", "the grader reads the seeded bytes back");
  assert.equal(proof.config_dir_after_close, false, "the stand-in's config goes with it");
});

/** @returns {boolean} */
function rcloneRuns() {
  try {
    execFileSync(RCLONE, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The host user's environment, with HOME moved onto the hidden config and
 * no override rclone would read first, so a run sees what the eval runner sees.
 * @param {string} home @returns {NodeJS.ProcessEnv}
 */
function hiddenHome(home) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, HOME: home };
  delete env.RCLONE_CONFIG;
  delete env.XDG_CONFIG_HOME;
  return env;
}

test("the agent's prompt carries the same docs and help the reading suite carries", () => {
  const source = module();
  assert.match(source, /docs-site.*\.rendered/, "the docs come from the one render");
  assert.match(source, /context.*drive-help\.txt/, "the help comes from the one snapshot");
  assert.ok(
    read("test/evals.test.mjs").includes("drive-help.txt"),
    "the snapshot the reading suite gates is the same file",
  );
  const prompt = source.slice(source.indexOf("AGENT_PROMPT"), source.indexOf("def dataset_from"));
  for (const leaked of ["grader", "why_hard", "target_bytes", "END_STATE", "scorer"]) {
    assert.ok(!prompt.includes(leaked), `the prompt must not leak ${leaked} into the agent`);
  }
});
