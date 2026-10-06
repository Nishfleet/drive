// The eval suite for drive issue #222.
//
// This file proves the structure the issue requires, not the model's
// answers: task count and shape, hard tasks carry why_hard, graders
// are programmatic and a different family from the agent model, the
// held-out split is not committed, and the context (docs + drive
// --help) is real and matches the shipped code.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { monthlyBillForStoredTb } from "../core/billing.js";
// The figures the money graders must follow (drive#526): the cap default,
// the per-TB ceiling sentence, and the one bill function the worked table
// is built from. The pages are rendered from these, so the gates below pin
// grader -> page -> module instead of typing the figures a third time.
import { DEFAULT_CAP_USD } from "../core/cap-default.js";
import { PRICE } from "../core/pricing.js";
// The eval's CLI help text is cmd/drive/main.go's `usage` const, so the gate
// asks the same function `npm run eval:sync-help` writes the committed snapshot
// with. The snapshot stays committed and the docs build never writes it:
// `docs:render` runs inside `npm test` before these gates, so a render that
// wrote the snapshot there made this gate compare the render's output with
// itself, and a stale committed snapshot passed CI while the step dirtied a
// clean main (drive#332).
import { cliUsageText, renderDocs } from "../src/render-docs.js";

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
 * @property {string[]} [prompts]
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

/** @param {string | boolean | number | { pass: boolean }} result */
function passed(result) {
  if (typeof result === "object" && result !== null) return result.pass;
  return Boolean(result);
}

/**
 * The promptfoo javascript-assertion context, so the repo's gate and the
 * real run grade a task the same way.
 *
 * @typedef {{ vars: Record<string, string> }} EvalContext
 */

/**
 * Build a grader the way promptfoo's `handleJavascript` does: a single-line
 * value is an expression, a multi-line value is the function body. Keeping
 * this in step with the tool is the gate's whole job.
 *
 * @param {string} value
 * @returns {string}
 */
function graderBody(value) {
  if (value.includes("\n")) return value.trimEnd();
  const trimmed = value.trim().replace(/;+\s*$/, "");
  if (/^(const|let|var)\s/.test(trimmed)) {
    const lastSemi = trimmed.lastIndexOf(";");
    if (lastSemi !== -1) {
      const statements = trimmed.slice(0, lastSemi + 1);
      const expression = trimmed.slice(lastSemi + 1).trim();
      if (expression) return `${statements} return ${expression}`;
    }
    return trimmed;
  }
  return `return ${trimmed}`;
}

/**
 * @param {EvalGrader} a
 * @param {string} output
 * @param {EvalContext} [context] defaults to a context with no vars, so a
 *   grader that needs one fails here rather than passing on empty input
 * @returns {boolean | number | { pass: boolean, score?: number, reason?: string }}
 */
function gradeJavascript(a, output, context = { vars: {} }) {
  if (typeof a.value !== "string") throw new Error(`${a.type} grader has no value to run`);
  const fn = new Function("output", "context", `"use strict"; ${graderBody(a.value)}`);
  return fn(output, context);
}

/**
 * The grader's own text, which every gate below reads to name the check it is
 * making. A javascript grader without one is the gate's own fault, so it
 * throws here rather than reading `undefined`.
 *
 * @param {EvalGrader} a
 * @returns {string}
 */
function graderSrc(a) {
  if (typeof a.value !== "string") throw new Error(`${a.type} grader has no value to read`);
  return a.value.trim();
}

/**
 * A javascript grader whose value is real text. A malformed entry (a missing
 * `value`, or a value that is not a string) is named here, so the gates below
 * report a bad task entry instead of a raw TypeError.
 *
 * @param {EvalTask[]} tasks
 * @returns {EvalGrader[]}
 */
function javascriptGraders(tasks) {
  /** @type {EvalGrader[]} */
  const out = [];
  for (const t of tasks) {
    for (const a of t.assert) {
      if (a.type !== "javascript") continue;
      if (typeof a.value !== "string") {
        throw new Error(`${t.description}: a javascript grader has no string value`);
      }
      out.push(a);
    }
  }
  return out;
}

/**
 * The vars promptfoo hands an assertion at run time, read from the config's
 * `defaultTest.vars`: a `file://` ref is the file's contents, resolved against
 * the config's own directory, so a grader and this gate read the same
 * rendered page.
 *
 * @returns {EvalContext}
 */
function gradingContext() {
  const cfg = loadConfig("evals/agents/promptfooconfig.yaml");
  /** @type {Record<string, string>} */
  const vars = {};
  for (const [name, value] of Object.entries(cfg.defaultTest?.vars ?? {})) {
    vars[name] =
      typeof value === "string" && value.startsWith("file://")
        ? readFileSync(join(evals, value.slice(7)), "utf8")
        : String(value);
  }
  return { vars };
}

const rendered = join(root, "docs-site", ".rendered");

test("the suite is wired to the stock tool and the docs render", () => {
  assert.ok(existsSync(join(evals, "promptfooconfig.yaml")), "config exists");
  assert.ok(existsSync(join(rendered, "quickstart.md")), "docs rendered");
  const cfg = loadConfig("evals/agents/promptfooconfig.yaml");
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
  const context = gradingContext();
  let n = 0;
  let disagreements = 0;
  for (const t of tasks) {
    for (const a of t.assert) {
      if (a.type !== "javascript") continue;
      for (const sample of samples) {
        const first = gradeJavascript(a, sample, context);
        const second = gradeJavascript(a, sample, context);
        n += 1;
        if (passed(first) !== passed(second)) disagreements += 1;
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

test("a task whose answer is a date in the docs follows the newest heading (drive#324)", () => {
  // The changelog's newest dated heading is the fact the answer carries, so a
  // grader that cannot state that date without a literal in the task file is
  // a grader that broke on the day the changelog moved. Two of the answers
  // below are the real failure: the day the changelog gained a heading
  // (2026-10-03, which failed 6/6 while the task still asserted 2026-10-02)
  // and the day before it.
  const changelog = readFileSync(join(rendered, "changelog.md"), "utf8");
  const headings = [...changelog.matchAll(/^## (\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]);
  assert.ok(headings.length >= 1, "the changelog has at least one dated heading");
  const [newest, older] = headings;

  const tasks = loadTasks("evals/agents/tasks/train.yaml");
  const task = tasks.find((t) => t.description === "the newest thing that shipped");
  assert.ok(task, "the train split still has the newest-thing task");
  const context = gradingContext();
  assert.equal(
    context.vars.docs_changelog,
    changelog,
    "the grader and this gate read the same rendered changelog promptfoo hands the assertion",
  );
  const js = task.assert.filter((a) => a.type === "javascript");
  assert.ok(js.length >= 1, "the newest-thing task has a programmatic grader");
  for (const a of js) {
    assert.ok(
      passed(gradeJavascript(a, `The newest thing shipped is ${newest}.`, context)),
      `${task.description}: an answer naming the newest heading ${newest} passes`,
    );
    if (older) {
      assert.ok(
        !passed(gradeJavascript(a, `The newest thing shipped is ${older}.`, context)),
        `${task.description}: an answer naming the older heading ${older} fails, so the grader follows the changelog`,
      );
    }
    assert.ok(
      !passed(gradeJavascript(a, "The newest thing shipped is 2026-10-01.", context)),
      `${task.description}: an answer naming no heading in the changelog fails`,
    );
  }
});

test("pasting the public docs and drive --help satisfies every train grader", () => {
  // The agent only sees those two sources plus the task. A grader that fails
  // on them is asking for a fact the task cannot know, or a negative the docs trip.
  const context = gradingContext();
  const contextText = `${Object.values(context.vars).join("\n")}\n${read("evals/agents/context/drive-help.txt")}`;
  const tasks = loadTasks("evals/agents/tasks/train.yaml");
  const fails = [];
  for (const t of tasks) {
    const output = `${contextText}\n${t.vars.task}`;
    for (const a of t.assert) {
      if (a.type !== "javascript") continue;
      if (!passed(gradeJavascript(a, output, context))) fails.push(`${t.description}: ${a.value}`);
    }
  }
  assert.equal(fails.length, 0, `docs+help+task must satisfy:\n${fails.join("\n")}`);
});

test("pasting the public docs and drive --help satisfies the held-out graders", (t) => {
  if (!existsSync(HOLDOUT_DEFAULT)) {
    t.skip(`held-out file is not on this machine: ${HOLDOUT_DEFAULT}`);
    return;
  }
  const context = gradingContext();
  const contextText = `${Object.values(context.vars).join("\n")}\n${read("evals/agents/context/drive-help.txt")}`;
  const tasks = loadTasks(HOLDOUT_DEFAULT);
  const fails = [];
  for (const t of tasks) {
    const output = `${contextText}\n${t.vars.task}`;
    for (const a of t.assert) {
      if (a.type !== "javascript") continue;
      if (!passed(gradeJavascript(a, output, context))) fails.push(`${t.description}: ${a.value}`);
    }
  }
  assert.equal(fails.length, 0, `docs+help+task must satisfy holdout:\n${fails.join("\n")}`);
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
  assert.equal(snapshot, m, "help text drift would break the context; run npm run eval:sync-help");
});

test("docs:render never writes the committed CLI-help snapshot", () => {
  // The snapshot is committed and the gate above checks it, so only
  // `npm run eval:sync-help` may write it. docs:render runs inside npm test
  // before these gates; if it touched the snapshot, the gate would compare the
  // render's own output with itself and a stale snapshot would pass CI
  // (drive#332). This pins the render path out of the committed file's way.
  const snapshot = read("evals/agents/context/drive-help.txt");
  const tmpDir = mkdtempSync(join(os.tmpdir(), "drive-render-"));
  try {
    renderDocs(tmpDir);
    assert.equal(
      read("evals/agents/context/drive-help.txt"),
      snapshot,
      "renderDocs must not rewrite the committed snapshot; use npm run eval:sync-help",
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
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

test("dead-artefact guard: every file:// ref in promptfooconfig.yaml exists", () => {
  // The eval config points at its prompt, its context and its task split with
  // file:// refs, resolved against the config's own directory. A ref whose
  // target is gone leaves the run reading nothing, so this gate names the ref
  // and the path it resolved to instead of letting promptfoo fail on a
  // missing file (drive#413).
  const cfg = loadConfig("evals/agents/promptfooconfig.yaml");
  /** @type {string[]} */
  const missing = [];
  /** @param {unknown} ref @param {string} label */
  function check(ref, label) {
    if (typeof ref !== "string" || !ref.startsWith("file://")) return;
    const p = join(evals, ref.slice(7));
    if (!existsSync(p)) missing.push(`${label}: ${ref} -> ${p}`);
  }
  assert.ok(Array.isArray(cfg.prompts) && cfg.prompts.length >= 1, "config names a prompt");
  for (const [i, ref] of (cfg.prompts ?? []).entries()) check(ref, `prompt ${i}`);
  for (const [name, value] of Object.entries(cfg.defaultTest?.vars ?? {})) {
    check(value, `var ${name}`);
  }
  check(cfg.tests, "tests");
  assert.equal(
    missing.length,
    0,
    `file:// refs whose target does not exist:\n${missing.join("\n")}`,
  );
});

test("the prompt's every {{var}} is a var the config actually provides", () => {
  // The guard above proves the files exist; this proves the prompt is wired to
  // them. A `{{docs_faq}}` the config never fills renders as a literal, and
  // the agent reads an empty page as a real one (drive#413).
  const cfg = loadConfig("evals/agents/promptfooconfig.yaml");
  const vars = new Set(Object.keys(cfg.defaultTest?.vars ?? {}));
  /** @type {string[]} */
  const promptFiles = [];
  /** @param {unknown} ref */
  function readPrompt(ref) {
    if (typeof ref === "string" && ref.startsWith("file://")) {
      promptFiles.push(join(evals, ref.slice(7)));
    }
  }
  for (const ref of Array.isArray(cfg.prompts) ? cfg.prompts : []) readPrompt(ref);
  // An inline prompt is not a file ref, so without this the guard below reads
  // nothing and still passes: it would be a gate that can never fail.
  assert.ok(promptFiles.length >= 1, "every prompt is a file:// ref this gate can read");
  const prompts = promptFiles.map((p) => readFileSync(p, "utf8"));
  const unfilled = [
    ...new Set(prompts.flatMap((p) => [...p.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))),
  ].filter((name) => name !== "task" && !vars.has(name));
  assert.deepEqual(
    unfilled,
    [],
    `the prompt interpolates vars the config does not provide: ${unfilled.join(", ")}`,
  );
});

test("no positive grader passes an empty or generic answer", () => {
  // A grader that fires on a blank reply or on lorem ipsum is not scoring the
  // task: it is scoring the docs it was written next to. A negative grader
  // (!/.../) passes on empty by design ("this claim is absent"), so we only
  // check positive graders. A task that has only negative graders is vacuous —
  // nothing can fail it — so every task must have at least one positive grader.
  const tasks = loadTasks("evals/agents/tasks/train.yaml");
  /** @type {string[]} */
  const vacuous = [];
  for (const t of tasks) {
    const js = javascriptGraders([t]);
    const positives = js.filter((a) => !graderSrc(a).startsWith("!"));
    if (positives.length === 0) {
      vacuous.push(`${t.description}: no positive grader (only negatives)`);
      continue;
    }
    for (const a of positives) {
      const src = graderSrc(a);
      for (const sample of ["", "lorem ipsum dolor sit amet"]) {
        if (passed(gradeJavascript(a, sample, { vars: {} }))) {
          vacuous.push(`${t.description}: passes "${sample}" (grader: ${src.slice(0, 80)})`);
        }
      }
    }
  }
  assert.equal(
    vacuous.length,
    0,
    `graders that always pass:
${vacuous.join("\n")}`,
  );
});

test("one unanswerable task: the docs cannot answer, grader expects honesty", () => {
  // The train split carries one task whose answer is nowhere in the docs or
  // in drive --help. The honest answer says so; an invented answer must not
  // pass. Each grader is checked on its own, so dropping any one of them (or
  // softening it) is caught instead of being masked by its neighbours.
  const tasks = loadTasks("evals/agents/tasks/train.yaml");
  const task = tasks.find((t) => t.description === "how to rotate storage keys");
  assert.ok(task, "train.yaml has the unanswerable task 'how to rotate storage keys'");
  assert.ok(task.vars?.why_hard, "unanswerable task says why it is hard");
  const js = javascriptGraders([task]);
  assert.ok(js.length >= 2, "unanswerable task has at least two programmatic graders");
  const context = { vars: {} };
  const honest =
    "The docs do not say how to rotate storage keys. Your invite comes with a key pair, and drive --help lists no rotation command.";
  // The real failure mode: a reply that quotes the docs' own words and then
  // invents a flag on top of them. It reads like a good answer, so only the
  // refusal grader separates it from the honest one.
  const invented =
    "Your invite comes with a key pair. Set the new pair in the environment and run drive rotate-keys --old-key $OLD --new-key $NEW, then drive status to confirm.";
  for (const a of js) {
    const src = graderSrc(a);
    assert.ok(
      passed(gradeJavascript(a, honest, context)),
      `an honest "the docs do not say" answer must pass: ${src}`,
    );
    assert.ok(
      !passed(gradeJavascript(a, invented, context)),
      `an invented rotate-keys answer must fail: ${src}`,
    );
  }
  // An echo of the task's own why_hard prose is not an answer, and that prose
  // must not be a template for one: the positive graders (the refusal-shaped
  // ones) have to fail it, while a negative correctly passes any text that
  // does not invent a command.
  const echoed = task.vars.why_hard;
  const positiveJs = js.filter((a) => !graderSrc(a).startsWith("!"));
  assert.ok(positiveJs.length >= 1, "unanswerable task has at least one positive grader");
  assert.ok(
    Boolean(echoed) && positiveJs.every((a) => !passed(gradeJavascript(a, echoed, context))),
    `echoing the task's own why_hard must fail every positive grader: ${echoed?.slice(0, 60)}`,
  );
});

// --- drive#526: the money graders read the price module, through the page ---

test("the money graders' pages carry the price module's figures (drive#526)", () => {
  const context = gradingContext();
  const security = context.vars.docs_security ?? "";
  const pricing = context.vars.docs_pricing ?? "";
  // The cap the security page names is the cap module's figure, not a typed
  // one: a re-price of src/cap-default.js fails here before any grader can
  // drift from it.
  assert.match(
    security,
    new RegExp(`The default cap is \\$${DEFAULT_CAP_USD}\\.`),
    `security.md names the cap module's $${DEFAULT_CAP_USD}`,
  );
  // The ceiling sentence is the price module's own line, verbatim.
  assert.ok(
    pricing.includes(PRICE.maxLine),
    `pricing.md carries the price module's ceiling line verbatim: ${PRICE.maxLine}`,
  );
  // The 0.8 TB row's bill is the one bill function's, not a typed figure.
  const rowLine = pricing.split("\n").find((line) => /^\| 0\.8 TB \|/.test(line));
  assert.ok(rowLine, "pricing.md carries the 0.8 TB row");
  const stated = rowLine
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)[3];
  assert.ok(stated, "the 0.8 TB row states a bill");
  assert.equal(
    parseFloat(stated.replace(/[$,]/g, "")),
    monthlyBillForStoredTb(0.8).billUsd,
    `the 0.8 TB row's bill is monthlyBillForStoredTb(0.8).billUsd, not typed: ${stated}`,
  );
});

test("the money graders follow the page they are handed, so the retired figures fail (drive#526)", () => {
  const tasks = loadTasks("evals/agents/tasks/train.yaml");
  const capTask = tasks.find((t) => t.description === "the default spending cap");
  const billTask = tasks.find(
    (t) => t.description === "the price worked out for 800 GB held all month",
  );
  const ceilingTask = tasks.find(
    (t) => t.description === "is there a free tier, and what sign-up needs from me",
  );
  assert.ok(capTask && billTask && ceilingTask, "the three money tasks are in the train split");
  const capGrader = capTask.assert[0]; // reads the security page's cap
  const billGrader = billTask.assert[0]; // reads the pricing page's 0.8 TB row
  const ceilingGrader = ceilingTask.assert[1]; // reads the pricing page's ceiling

  // A re-priced page no grader has seen: cap $25, the 800 GB row billing
  // $12.50, the ceiling $15. A grader that still names any typed figure —
  // today's or the retired one — cannot pass this page.
  const reprice = {
    vars: {
      docs_security: "The default cap is $25.",
      docs_pricing: "Never more than $15 per TB.\n| 0.8 TB | $20 | $12.50 | $12.50 |\n",
    },
  };
  const real = gradingContext();

  // On the re-priced page, only the page's own figures pass.
  assert.ok(passed(gradeJavascript(capGrader, "The default cap is $25.", reprice)));
  assert.ok(
    !passed(gradeJavascript(capGrader, "The default cap is $20.", reprice)),
    "today's figure must fail a re-priced page",
  );
  assert.ok(
    !passed(gradeJavascript(capGrader, "The default cap is $12.", reprice)),
    "the retired figure must fail a re-priced page",
  );
  assert.ok(passed(gradeJavascript(billGrader, "My bill is $12.50.", reprice)));
  assert.ok(
    !passed(gradeJavascript(billGrader, "My bill is $10.", reprice)),
    "today's bill must fail a re-priced page",
  );
  assert.ok(passed(gradeJavascript(ceilingGrader, "Never more than $15 per TB.", reprice)));
  assert.ok(
    !passed(gradeJavascript(ceilingGrader, "Never more than $10 per TB.", reprice)),
    "today's ceiling must fail a re-priced page",
  );

  // On the real pages, the retired $12 — the literal the graders used to
  // carry — fails every money grader, and each page's own figure passes.
  assert.ok(passed(gradeJavascript(capGrader, "The default cap is $20.", real)));
  assert.ok(
    !passed(gradeJavascript(capGrader, "The default cap is $12.", real)),
    "the retired cap must fail the real page",
  );
  assert.ok(passed(gradeJavascript(billGrader, "My bill is $10.", real)));
  assert.ok(
    !passed(gradeJavascript(billGrader, "My bill is $12.", real)),
    "the retired 800 GB bill must fail the real page",
  );
  assert.ok(passed(gradeJavascript(ceilingGrader, "Never more than $10 per TB.", real)));
  assert.ok(
    !passed(gradeJavascript(ceilingGrader, "Never more than $12 per TB.", real)),
    "the retired ceiling must fail the real page",
  );
});

test("the docs' held-out command is the env-var form npm actually honours (drive#526)", () => {
  const pkg = JSON.parse(read("package.json"));
  // npm appends `--` args to the LAST command of a chained script, so a
  // split passed as `npm run eval:agents -- --tests <file>` would reach the
  // endstate step, not promptfoo. The script selects the split by env var.
  assert.match(
    pkg.scripts["eval:agents"],
    /\$\{DRIVE_EVAL_SPLIT:\+--tests \$DRIVE_EVAL_SPLIT\}/,
    "the one command wires DRIVE_EVAL_SPLIT to promptfoo's --tests flag",
  );
  const sb = read("docs/scoreboard.md");
  const row = sb
    .split("\n")
    .find((line) => line.includes("agents finish real tasks from the docs"));
  assert.ok(row, "scoreboard has the agents row");
  assert.match(
    row,
    /`DRIVE_EVAL_SPLIT=[^`]+ npm run eval:agents`/,
    "the agents row's test command sets DRIVE_EVAL_SPLIT",
  );
  assert.ok(
    !row.includes("npm run eval:agents --"),
    "the agents row never suggests the -- form npm swallows",
  );
  const readme = read("evals/agents/README.md");
  assert.match(
    readme,
    /DRIVE_EVAL_SPLIT=\S+ \\\n\s+npm run eval:agents/,
    "README's example sets the split as an env var",
  );
  // The held-out example block itself sets the env var; the -- form is
  // named exactly once, in the warning prose — never as a way to run it.
  const fenceStart = readme.indexOf("```sh", readme.indexOf("A held-out run"));
  const example = readme.slice(fenceStart + 6, readme.indexOf("```", fenceStart + 5));
  assert.match(
    example,
    /^DRIVE_EVAL_SPLIT=\S+ \\\n\s+npm run eval:agents\n$/,
    "the held-out example sets the split as an env var",
  );
  assert.ok(!example.includes("--"), "the held-out example never passes the split with --");
  assert.equal(
    readme.split("npm run eval:agents --").length - 1,
    1,
    "README names the -- form only as the warned-against example",
  );
  assert.match(readme, /npm appends/, "README explains why the -- form is wrong");
});

test("the end-state suite runs in the stock container sandbox and survives a reading split (drive#526)", () => {
  const py = read("evals/agents/endstate.py");
  assert.match(
    py,
    /sandbox=\("docker", "compose\.yaml"\)/,
    "the agent's shell runs in Inspect's Docker sandbox",
  );
  assert.ok(
    !py.includes("DRIVE_EVAL_SANDBOX"),
    "no sandbox override: a broken Docker fails the run instead of falling back",
  );
  assert.match(
    py,
    /os\.environ\.get\("DRIVE_EVAL_SPLIT"\)/,
    "the end-state suite reads the one split setting",
  );
  assert.match(
    py,
    /reading split/,
    "a reading-only split falls back to the committed tasks, and says so",
  );
  assert.match(
    py,
    /neither an end-state task nor a/,
    "an entry of neither shape raises instead of reading as a skip",
  );

  // The compose file is the container the sandbox starts: one `default`
  // service (Inspect's required name), a pinned base image, and rclone on
  // PATH inside it.
  assert.ok(existsSync(join(evals, "compose.yaml")), "compose.yaml ships beside the task");
  const compose =
    /** @type {{ services?: Record<string, { image?: unknown, command?: unknown, network_mode?: unknown, volumes?: unknown }> }} */ (
      loadYaml("evals/agents/compose.yaml")
    );
  const svc = compose.services?.default;
  assert.ok(svc, "the sandbox service is `default` (Inspect's required name)");
  assert.match(String(svc.image), /^python:3\.12-bookworm$/, "the image is pinned");
  assert.deepEqual(
    svc.command,
    ["sleep", "infinity"],
    "the container stays up for Inspect to exec into",
  );
  assert.equal(
    svc.network_mode,
    "host",
    "the container reaches the stand-in on the host's loopback",
  );
  assert.match(
    JSON.stringify(svc.volumes ?? []),
    /rclone:ro/,
    "rclone is bind-mounted read-only onto the container's PATH",
  );
});

test("the agent eval runs on a clock with a pass bar, and the release reads its score (drive#526)", () => {
  const wf = read(".github/workflows/agent-eval.yml");
  assert.match(wf, /schedule:/, "the eval runs on a schedule");
  assert.match(wf, /cron: /, "…with a cron");
  assert.match(wf, /workflow_dispatch:/, "…and can be run by hand before a release");
  assert.match(
    wf,
    /runs-on: \[self-hosted, Linux, X64\]/,
    "…on the own runners, where the split and the key live",
  );
  assert.match(wf, /DRIVE_EVAL_SPLIT/, "…on the held-out split");
  assert.match(wf, /HELDOUT_PASS_BAR/, "…with the pass bar named");
  assert.match(wf, /results\/latest\.json/, "…scored from the run's recorded output");
  // Every action is pinned to a commit SHA, the convention ci.yml sets.
  for (const [, uses] of wf.matchAll(/uses:\s*(\S+)/g)) {
    assert.match(uses, /@[0-9a-f]{40}/, `action is SHA-pinned: ${uses}`);
  }

  const deploy = read(".github/workflows/deploy-production.yml");
  assert.match(deploy, /agent-eval\.yml/, "the deploy reads the agent eval's runs");
  assert.match(deploy, /pass bar/, "…and names the bar it enforces");
  assert.match(deploy, /exit 1/, "…and a red score stops the deploy");
  assert.match(deploy, /gate is not armed/, "…and warns, not fails, before the first run exists");
});
