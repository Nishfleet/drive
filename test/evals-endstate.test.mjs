// The end-state slice of the agent eval (drive issue #298).
//
// The reading suite's gate (test/evals.test.mjs) proves promptfoo's shape. This
// file proves the end-state slice's: the tool is Inspect and pinned, the tasks
// name a grader the Python module really defines, the agent's prompt carries
// the same public docs and help text the reading suite carries, and the graded
// facts are the account's own files — never the answer text.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** @param {string} path @returns {string} */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const MODULE = "evals/agents/endstate.py";
const module = () => read(MODULE);

test("the end-state slice runs on Inspect, pinned, in its own venv", () => {
  const requirements = read("evals/agents/requirements.txt");
  assert.match(requirements, /^inspect-ai==\d+\.\d+\.\d+$/m, "inspect-ai is an exact pin");
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
    assert.match(entry, /\n  task: /, `${description}: has a task`);
    assert.match(entry, /\n  source: /, `${description}: names its source`);
    const grader = entry.match(/\n  grader: (\w+)/)?.[1];
    assert.ok(grader, `${description}: names its grader`);
    assert.ok(graders.has(grader), `${description}: grader ${grader} is one the module defines`);
    if (grader === "save_file") {
      assert.match(entry, /\n  target_path: /, `${description}: names the path it grades`);
      assert.match(entry, /\n  target_bytes: /, `${description}: names the bytes it grades`);
    }
    if (/\n  why_hard: /.test(entry)) {
      assert.ok(
        entry.indexOf("why_hard") < entry.indexOf("task:"),
        `${description}: says why a person finds it hard`,
      );
    }
  }
  assert.ok(/\n  grader: unchanged/.test(tasks), "one task's graded fact is that nothing changed");
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
  assert.match(source, /except \(subprocess\.TimeoutExpired, OSError\)/, "a dead stand-in is caught");
  assert.match(source, /the stand-in's listing failed/, "a failed listing is a failure, not a pass");
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

test("the agent's prompt carries the same docs and help the reading suite carries", () => {
  const source = module();
  assert.match(source, /docs-site.*\.rendered/, "the docs come from the one render");
  assert.match(source, /context.*drive-help\.txt/, "the help comes from the one snapshot");
  assert.ok(
    read("test/evals.test.mjs").includes("drive-help.txt"),
    "the snapshot the reading suite gates is the same file",
  );
  const prompt = source.slice(
    source.indexOf("AGENT_PROMPT"),
    source.indexOf("def dataset_from"),
  );
  for (const leaked of ["grader", "why_hard", "target_bytes", "END_STATE", "scorer"]) {
    assert.ok(!prompt.includes(leaked), `the prompt must not leak ${leaked} into the agent`);
  }
});
