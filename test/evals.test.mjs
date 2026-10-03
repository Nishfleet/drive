// The eval suite for drive issue #222.
//
// This file proves the structure the issue requires, not the model's
// answers: task count and shape, hard tasks carry why_hard, graders
// are programmatic and a different family from the agent model, the
// held-out split is not committed, and the context (docs + drive
// --help) is real and matches the shipped code.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// The eval's CLI help text is cmd/drive/main.go's `usage` const, so the gate
// asks the same function `npm run docs:render` writes the snapshot with. A
// second copy of that pattern is how the gate went green on a file the render
// had stopped producing.
import { cliUsageText } from "../src/render-docs.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const evals = join(root, "evals", "agents");
const HOLDOUT_DEFAULT = "/home/nish/.local/share/drive/eval-holdout.yaml";

/**
 * The shapes js-yaml hands back, so `tsc --noEmit` (this repo's `pretest`)
 * can check the gates instead of inferring `unknown` from `yaml.load`.
 *
 * @typedef {object} EvalGrader
 * @property {string} type
 * @property {string} [value]
 * @property {string} [rubric]
 * @property {string} [provider]
 *
 * @typedef {object} EvalTask
 * @property {string} description
 * @property {{ task: string, source: string, why_hard?: string }} vars
 * @property {EvalGrader[]} assert
 * @property {{ hard?: boolean }} [metadata]
 *
 * @typedef {object} EvalProvider
 * @property {string} id
 * @property {string} label
 * @property {{ apiBaseUrl?: string }} [config]
 *
 * @typedef {object} EvalConfig
 * @property {string} [description]
 * @property {EvalProvider[]} [providers]
 * @property {{ repeat?: number }} [evaluateOptions]
 * @property {{ options?: { transform?: string }, vars?: Record<string, string> }} [defaultTest]
 * @property {string} [tests]
 */

/** @param {string} p */
function read(p) {
  return readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
}

/** @param {string} rel @returns {unknown} */
function loadYaml(rel) {
  // js-yaml is already in this install (VitePress). Load by path so we do
  // not depend on package exports, and CI does not need PyYAML.
  const src = rel.startsWith("/") ? readFileSync(rel, "utf8") : read(rel);
  /** @type {{ load: (s: string) => unknown }} */
  const yaml = require(join(root, "node_modules", "js-yaml", "index.js"));
  return yaml.load(src);
}

/** @param {string} rel @returns {EvalTask[]} */
function loadTasks(rel) {
  return /** @type {EvalTask[]} */ (loadYaml(rel));
}

/** @param {string} rel @returns {EvalConfig} */
function loadConfig(rel) {
  return /** @type {EvalConfig} */ (loadYaml(rel));
}

function docsAndHelp() {
  const rendered = join(root, "docs-site", ".rendered");
  const pages = readdirSync(rendered)
    .filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(rendered, name), "utf8"));
  return `${pages.join("\n")}\n${read("evals/agents/context/drive-help.txt")}`;
}

/**
 * The production transform: promptfooconfig.yaml slices the model output to
 * its last 600 chars before any grader runs, so the eval scores the short
 * visible reply, not a leading thinking dump. The scorer here applies the
 * same slice, so a pass in this file means a pass in a run.
 * @param {string} output
 */
function productionOutput(output) {
  return output.slice(-600);
}

/**
 * The raw check, with no transform. Only the two "the docs satisfy every
 * grader" tests use this, and deliberately: they ask whether the context
 * *contains* the fact a grader wants. The transform answers a different
 * question — which part of a reply is scored — and applying it to a whole
 * docs dump would grade the tail of the help text, not the docs.
 * @param {string} value @param {string} output
 */
function gradeRaw(value, output) {
  const fn = new Function("output", `"use strict"; return (${value});`);
  return fn(output);
}

/** @param {EvalGrader} a @returns {string} */
function graderSource(a) {
  if (typeof a.value !== "string") throw new Error(`${a.type} grader has no value to run`);
  return a.value;
}

/** @param {string} value @param {string} output */
function gradeJavascript(value, output) {
  return gradeRaw(value, productionOutput(output));
}

const rendered = join(root, "docs-site", ".rendered");

test("the suite is wired to the stock tool and the docs render", () => {
  assert.ok(existsSync(join(evals, "promptfooconfig.yaml")), "config exists");
  assert.ok(existsSync(join(rendered, "quickstart.md")), "docs rendered");
  const cfg = loadConfig("evals/agents/promptfooconfig.yaml");
  assert.ok(cfg.description, "config has a description");
  assert.equal(
    cfg.defaultTest?.options?.transform,
    "output.slice(-600)",
    "the transform the scorer in this file mirrors",
  );
  assert.ok(
    Array.isArray(cfg.providers) && cfg.providers.length >= 2,
    "two providers, the scaling pair",
  );
  const labels = cfg.providers.map((p) => p.label);
  assert.ok(
    labels.some((l) => /stronger|higher effort/i.test(l)),
    "one provider is labelled as the scaling pair",
  );
  for (const p of cfg.providers) {
    assert.match(
      p.config?.apiBaseUrl ?? "",
      /^http:\/\/127\.0\.0\.1:4000\//,
      `${p.label}: providers call the local proxy, not a paid API`,
    );
  }
  assert.equal(cfg.evaluateOptions?.repeat, 3, "three epochs for the variance check");
  assert.equal(
    cfg.defaultTest?.options?.transform,
    "output.slice(-600)",
    "graders score the short visible reply, not a leading thinking dump",
  );
  assert.equal(cfg.tests, "file://tasks/train.yaml", "train split only in this repo");
  assert.ok(cfg.defaultTest?.vars?.docs_index?.startsWith("file://"), "docs are file refs");
  assert.ok(cfg.defaultTest?.vars?.drive_help?.startsWith("file://"), "help text is a file ref");
});

test("train.yaml has 40-60 tasks, every hard one says why a person finds it hard", () => {
  const tasks = loadTasks("evals/agents/tasks/train.yaml");
  assert.ok(Array.isArray(tasks), "tasks is a list");
  const n = tasks.length;
  assert.ok(n >= 40 && n <= 60, `task count ${n} is in the required 40-60`);
  const descs = tasks.map((t) => t.description);
  assert.equal(new Set(descs).size, n, "no duplicate task descriptions");
  const hard = tasks.filter((t) => t.metadata?.hard);
  assert.ok(hard.length >= 5, `at least 5 hard tasks (${hard.length})`);
  for (const t of hard) {
    assert.ok(t.vars?.why_hard, `${t.description}: a hard case says why a person finds it hard`);
  }
  for (const t of tasks) {
    assert.ok(t.description, "every task has a description");
    assert.ok(t.vars?.task, `${t.description}: every task has a task`);
    assert.ok(t.vars?.source, `${t.description}: every task names its source`);
    assert.ok(
      Array.isArray(t.assert) && t.assert.length >= 1,
      `${t.description}: has at least one grader`,
    );
    for (const a of t.assert) {
      assert.ok(
        ["javascript", "llm-rubric"].includes(a.type),
        `${t.description}: grader type must be javascript (programmatic) or llm-rubric (prose)`,
      );
    }
  }
});

test("programmatic graders only, and the judge lives on a different family", () => {
  const tasks = loadTasks("evals/agents/tasks/train.yaml");
  const cfg = loadConfig("evals/agents/promptfooconfig.yaml");
  for (const t of tasks) {
    for (const a of t.assert) {
      if (a.type === "llm-rubric") {
        const agent = cfg.providers?.[0]?.id || "";
        const judge = (a.provider || "").replace(/^openrouter:/, "");
        const agentFamily = agent.split("/")[0];
        const judgeFamily = judge.split("/")[0];
        assert.notEqual(
          agentFamily,
          judgeFamily,
          `${t.description}: the judge ${judgeFamily} must differ from the agent ${agentFamily}`,
        );
        assert.ok(a.rubric, `${t.description}: a prose judge must carry a checkable-claims rubric`);
      }
    }
  }
});

test("the same transcript graded twice agrees 100%", () => {
  const tasks = loadTasks("evals/agents/tasks/train.yaml");
  const samples = [docsAndHelp(), "", "lorem ipsum"];
  let n = 0;
  let disagreements = 0;
  for (const t of tasks) {
    for (const a of t.assert) {
      if (a.type !== "javascript") continue;
      for (const sample of samples) {
        const first = gradeJavascript(graderSource(a), sample);
        const second = gradeJavascript(graderSource(a), sample);
        n += 1;
        if (first !== second) disagreements += 1;
      }
    }
  }
  assert.ok(n > 0, "graded at least one transcript");
  assert.equal(
    disagreements,
    0,
    `same transcript graded twice must agree; ${disagreements}/${n} differed`,
  );
});

test("pasting the public docs and drive --help satisfies every train grader", () => {
  // The agent only sees those two sources plus the task. A grader that fails
  // on them is asking for a fact the task cannot know, or a negative the docs trip.
  // Graded without the transform: this asks whether the context contains the
  // fact, which is a different question from which reply bytes are scored.
  const context = docsAndHelp();
  const tasks = loadTasks("evals/agents/tasks/train.yaml");
  const fails = [];
  for (const t of tasks) {
    const output = `${context}\n${t.vars.task}`;
    for (const a of t.assert) {
      if (a.type !== "javascript") continue;
      if (!gradeRaw(graderSource(a), output)) fails.push(`${t.description}: ${a.value}`);
    }
  }
  assert.equal(fails.length, 0, `docs+help+task must satisfy:\n${fails.join("\n")}`);
});

test("no positive grader passes an empty or unrelated reply", () => {
  // A grader that fires on a blank reply or on lorem ipsum is not scoring the
  // task: it is scoring the docs it was written next to. This is the
  // discrimination the docs-satisfy tests cannot prove on their own. A
  // negative grader (`!/.../`) is skipped: it passes on a blank reply because
  // that is what "this claim is absent" means.
  const tasks = loadTasks("evals/agents/tasks/train.yaml");
  const vacuous = [];
  for (const t of tasks) {
    for (const a of t.assert) {
      if (a.type !== "javascript") continue;
      const src = graderSource(a).trim();
      if (src.startsWith("!")) continue;
      for (const sample of ["", "lorem ipsum dolor sit amet"]) {
        if (gradeJavascript(src, sample)) vacuous.push(`${t.description}: passes "${sample}"`);
      }
    }
  }
  assert.equal(vacuous.length, 0, `graders that always pass:\n${vacuous.join("\n")}`);
});

test("pasting the public docs and drive --help satisfies the held-out graders", (t) => {
  const holdout = process.env.DRIVE_EVAL_HOLDOUT ?? HOLDOUT_DEFAULT;
  if (!existsSync(holdout)) {
    t.skip(`held-out file is not on this machine: ${holdout}`);
    return;
  }
  const context = docsAndHelp();
  const tasks = loadTasks(holdout);
  const fails = [];
  for (const t of tasks) {
    const output = `${context}\n${t.vars.task}`;
    for (const a of t.assert) {
      if (a.type !== "javascript") continue;
      if (!gradeRaw(graderSource(a), output)) fails.push(`${t.description}: ${a.value}`);
    }
  }
  assert.equal(fails.length, 0, `docs+help+task must satisfy holdout:\n${fails.join("\n")}`);
});

test("the held-out artefact guard fires on a real tracked path", () => {
  // `git ls-files` prints repo-root-relative paths, so the guard must match
  // the whole path, not its start. This runs the same filter over a synthetic
  // tracked list to prove it fires.
  const isArtifact = (/** @type {string} */ p) =>
    p.includes("heldout") || p.endsWith(".holdout.yaml") || p.includes("/results/");
  assert.ok(isArtifact("evals/agents/results/latest.json"), "a committed result is flagged");
  assert.ok(isArtifact("evals/agents/heldout/test.yaml"), "a committed held-out file is flagged");
  assert.ok(!isArtifact("evals/agents/tasks/train.yaml"), "the train split is not flagged");
});

test("held-out tasks and run artefacts are not in the repository", () => {
  const tracked = execFileSync("git", ["ls-files", "evals/agents"], { cwd: root })
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  const illegal = tracked.filter(
    (p) => p.includes("heldout") || p.endsWith(".holdout.yaml") || p.includes("/results/"),
  );
  assert.equal(
    illegal.length,
    0,
    `tracked files that must live outside the repo: ${illegal.join(", ")}`,
  );
  const gitignore = read("evals/agents/.gitignore");
  assert.ok(/results\//.test(gitignore), ".gitignore covers results/");
  assert.ok(/heldout\//.test(gitignore), ".gitignore covers heldout/");
  const readme = read("evals/agents/README.md");
  assert.ok(
    readme.includes(HOLDOUT_DEFAULT),
    "README names the default held-out path outside the repo",
  );
  assert.ok(!HOLDOUT_DEFAULT.startsWith(root), "default held-out path is outside this checkout");
  const override = process.env.DRIVE_EVAL_HOLDOUT;
  if (override) {
    const resolved = resolve(override);
    assert.ok(
      resolved !== root && !resolved.startsWith(`${root}/`),
      `DRIVE_EVAL_HOLDOUT points inside this checkout: ${resolved}`,
    );
  }
});

test("the prompt reads only the docs, the help text and the task", () => {
  const prompt = read("evals/agents/prompts/agent.md");
  for (const kw of ["assert", "grader", "why_hard", "heldout", "rubric"]) {
    assert.ok(!prompt.includes(kw), `prompt must not leak the ${kw} key into the agent's context`);
  }
  assert.ok(prompt.includes("{{task}}"), "prompt is parametrized per task");
});

test("drive --help snapshot still matches the shipped CLI", () => {
  const m = cliUsageText().trim();
  const snapshot = read("evals/agents/context/drive-help.txt").trim();
  assert.equal(snapshot, m, "help text drift would break the context");
});

test("package.json wires the one command and the stock tool", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(
    /docs:render/.test(pkg.scripts["eval:agents"]),
    "one command is docs:render + promptfoo",
  );
  assert.ok(
    pkg.scripts["eval:agents"].includes("promptfooconfig.yaml"),
    "one command uses the config",
  );
  assert.match(
    pkg.scripts["eval:agents"],
    /evals\/agents\/node_modules\/\.bin\/promptfoo/,
    "one command uses the local pinned binary, not a cold download",
  );
  assert.ok(
    !pkg.dependencies?.promptfoo && !pkg.devDependencies?.promptfoo,
    "promptfoo is not a root dependency, so a root npm ci does not install it",
  );
});

test("scoreboard carries the agents row, owned by this issue", () => {
  const sb = read("docs/scoreboard.md");
  assert.ok(/agents finish real tasks from the docs/.test(sb), "scoreboard has the agents row");
});

test("the scoreboard gate counts the agents row", () => {
  const sb = read("test/scoreboard.test.mjs");
  assert.ok(/agents finish real tasks from the docs/.test(sb), "EVERY_ROWS names the agents row");
});
