# Agent eval: can an agent use drive from its own docs and CLI?

Drive is "a Finder drive for people and their agents", so the first eval
measures the thing agents do: get a file task done using only the public docs
and the `drive` command's own help. This directory is that eval (drive issue
#222, and the hill-climb it feeds is #223).

## The one command

```sh
npm run eval:agents
```

That renders the docs pages (`npm run docs:render`), then runs
`promptfoo eval` against `promptfooconfig.yaml`. The `eval:agents` script in
`package.json` is the only wiring; there is no wrapper and no helper script.

## The tool, and why

**[promptfoo](https://promptfoo.dev/)**, pinned in `package.json` and run from
`node_modules`. The repo is a Node repo, its test suite already runs under
Node, and promptfoo is the stock tool for "a set of tasks, a set of graders,
run them against N models and report a score" with no harness to hand-write.
Inspect (AISI) is the other stock choice the issue names; it is the better tool
for sandboxed shell tasks, and it is the tool the grader half of this suite
should move to when the storage stand-in is wired in (see "What is not done
yet"). Inspect is Python, and this suite's graders are already JavaScript, so
splitting the repo's toolchain in two buys nothing today.

## What the agent gets

Only drive's own words:

- the public docs pages, rendered from `docs-site/*.md` into
  `docs-site/.rendered/`, exactly the Markdown the site serves to agents;
- the `drive --help` text in `context/drive-help.txt`, which
  `test/evals.test.mjs` proves still matches the `usage` string in
  `cmd/drive/main.go`.

`prompts/agent.md` pastes both in, then the task. Nothing else.

## Tasks

`tasks/train.yaml` is the train split. Each task carries:

- `description` — what the task is, in one line;
- `vars.task` — the task, in the user's words;
- `vars.source` — the page, section or issue it came from;
- `vars.why_hard` — one line, hard tasks only, saying why a person who has used
  a drive finds it hard;
- `assert` — the grader.

Where the tasks come from, in the order the issue asks for: the docs pages' own
examples first, then this repo's issue bodies and bug reports, then the hard
cases the issue lists. Synthetic tasks fill only what is missing. No task is
here because a model failed it.

## Graders

Programmatic first. A grader is a check against the answer text, and it lives
inline in `tasks/*.yaml` as a promptfoo `javascript` assertion — a pure
function of the output, so grading the same transcript twice gives the same
score the second time. An LLM judge is used only where the output is prose, and
its rubric is a list of checkable claims rather than a score; a judge, when one
is added, is a **different model family** from the agent under test.

## Splits, and where the held-out set lives

The train split is roughly two thirds of the tasks and is this file. The
held-out test split and its answers are **not in the repository**: they live
outside the checkout, under the path named by `DRIVE_EVAL_HOLDOUT`, so the
hill-climber (#223) cannot read them from the repo. `test/evals.test.mjs`
proves no held-out file is tracked by git and that the default path is outside
the repo. A held-out run is:

```sh
DRIVE_EVAL_HOLDOUT=/path/outside/the/repo npm run eval:agents
```

## The models

The two `providers` in `promptfooconfig.yaml` are the scaling pair: a cheaper
model at its default effort, and a stronger model, so the same suite can show a
stronger model and a higher effort scoring higher. The judge, when a task needs
one, is set per assertion with a provider from a different family.

## What is not done yet

The graders in this first slice check the answer the agent writes, because the
running stack the issue asks for — a fresh account on the storage stand-in, a
mounted folder, a scoped key to attempt a delete with — is not wired into the
suite yet. That is the next slice, and it is where the programmatic graders
become end-state checks (the file exists with the right bytes, the key is
scoped, the cap is stored, nothing was deleted) instead of checks on the
command list. Until then this suite measures whether an agent can read the
docs and the CLI correctly, which is the first half of the question.

## The scoreboard row

`docs/scoreboard.md` carries one row, "agents finish real tasks from the docs",
whose us-cell is a live run of this suite. `test/scoreboard.test.mjs` owns the
row list, so a run that has no numbers yet must not add the row until it does;
the numbers, the command that repeats them and the run id go in the us-cell.