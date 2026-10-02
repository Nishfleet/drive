// The eval suite for drive issue #222.
//
// This file proves the structure the issue requires, not the model's
// answers: task count and shape, hard tasks carry why_hard, graders
// are programmatic and a different family from the agent model, the
// held-out split is not committed, and the context (docs + drive
// --help) is real and matches the shipped code.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const evals = join(root, "evals", "agents");

function read(p) {
  return readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
}

const rendered = join(root, "docs-site", ".rendered");

test("the suite is wired to the stock tool and the docs render", () => {
  assert.ok(existsSync(join(evals, "promptfooconfig.yaml")), "config exists");
  assert.ok(existsSync(join(rendered, "quickstart.md")), "docs rendered");
  const cfg = yaml.load(read("evals/agents/promptfooconfig.yaml"));
  assert.ok(cfg.description, "config has a description");
  assert.ok(
    Array.isArray(cfg.providers) && cfg.providers.length >= 2,
    "two providers, the scaling pair",
  );
  const labels = cfg.providers.map((p) => p.label);
  assert.ok(
    labels.some((l) => /stronger|higher effort/i.test(l)),
    "one provider is labelled as the scaling pair",
  );
  assert.equal(cfg.tests, "file://tasks/train.yaml", "train split only in this repo");
  assert.ok(cfg.defaultTest?.vars?.docs_index?.startsWith("file://"), "docs are file refs");
  assert.ok(cfg.defaultTest?.vars?.drive_help?.startsWith("file://"), "help text is a file ref");
});

test("train.yaml has 40-60 tasks, every hard one says why a person finds it hard", () => {
  const tasks = yaml.load(read("evals/agents/tasks/train.yaml"));
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
  const tasks = yaml.load(read("evals/agents/tasks/train.yaml"));
  const cfg = yaml.load(read("evals/agents/promptfooconfig.yaml"));
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

test("held-out tasks and run artefacts are not in the repository", () => {
  const tracked = execFileSync("git", ["ls-files", "evals/agents"], { cwd: root })
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  const illegal = tracked.filter(
    (p) => p.includes("heldout") || p.endsWith(".holdout.yaml") || p.startsWith("results/"),
  );
  assert.equal(
    illegal.length,
    0,
    `tracked files that must live outside the repo: ${illegal.join(", ")}`,
  );
  const gitignore = read("evals/agents/.gitignore");
  assert.ok(/results\//.test(gitignore), ".gitignore covers results/");
  assert.ok(/heldout\//.test(gitignore), ".gitignore covers heldout/");
});

test("the prompt reads only the docs, the help text and the task", () => {
  const prompt = read("evals/agents/prompts/agent.md");
  for (const kw of ["assert", "grader", "score", "why_hard", "heldout", "rubric"]) {
    assert.ok(!prompt.includes(kw), `prompt must not leak the ${kw} key into the agent's context`);
  }
  assert.ok(prompt.includes("{{task}}"), "prompt is parametrized per task");
});

test("drive --help snapshot still matches the shipped CLI", () => {
  const src = read("cmd/drive/main.go");
  const m = src.match(/const usage = `([\s\S]*?)`\nconst version/);
  assert.ok(m, "usage string in main.go");
  const snapshot = read("evals/agents/context/drive-help.txt").trim();
  assert.equal(snapshot, m[1].trim(), "help text drift would break the context");
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
  assert.ok(pkg.devDependencies?.promptfoo, "promptfoo is a declared dependency");
});

test("scoreboard carries the agents row, owned by this issue", () => {
  const sb = read("docs/scoreboard.md");
  assert.ok(/agents finish real tasks from the docs/.test(sb), "scoreboard has the agents row");
});

test("the scoreboard gate counts the agents row", () => {
  const sb = read("test/scoreboard.test.mjs");
  assert.ok(/agents finish real tasks from the docs/.test(sb), "EVERY_ROWS names the agents row");
});
