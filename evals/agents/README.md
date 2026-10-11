# Agent eval: can an agent use drive from its own docs and CLI?

Drive is "a Finder drive for people and their agents", so the first eval
measures the thing agents do: get a file task done using only the public docs
and the `drive` command's own help. This directory is that eval (drive issue
#222, and the hill-climb it feeds is #223).

## The one command

```sh
npm run eval:agents
```

That renders the docs pages (`npm run docs:render`), runs the promptfoo binary
pinned in `evals/agents/` against `promptfooconfig.yaml`, then runs the
end-state suite (`endstate.py`). Install once with `npm ci --prefix
evals/agents` and `npm run eval:agents:install`. There is no wrapper script and
promptfoo is not a root dependency, so a root `npm ci` does not install it. Do
not run `npx` or `npm exec` for it: that downloads the package each time and
fills a runner's memory limit (drive#257).

A held-out run is the same command with the split's path set, once.
`DRIVE_EVAL_SPLIT` is the setting both suites read: npm hands it to
promptfoo as its `--tests` flag, and the end-state suite grades the
split's end-state entries — a split with only reading tasks leaves the
end-state suite on its committed tasks, and the run says so. That path
is outside this checkout, so the hill-climber (#223) cannot read the
tasks from the repo. Never pass the split with `--` (as in
`npm run eval:agents -- --tests <file>`): npm appends those args to the
last command of the chained script, so they never reach promptfoo.

```sh
DRIVE_EVAL_SPLIT=/home/nish/.local/share/drive/eval-holdout.yaml \
  npm run eval:agents
```

## The tool, and why

**[promptfoo](https://promptfoo.dev/)**, pinned at `0.123.1` in
`evals/agents/package.json`, runs the docs-and-CLI reading suite; the
end-state suite (`endstate.py`) runs on
**[Inspect](https://inspect.aisi.org.uk/)**, pinned in `requirements.txt`. The
split follows the slices: the reading suite's graders are checks on the
answer, and promptfoo grades that well — its stock `javascript` assertion is a
pure function of the output. The end-state suite's graders check a real
account on a storage stand-in after an agent has worked in it, and that needs
an agent loop with a shell plus a scorer that reads the sandbox. Inspect ships
both (`basic_agent`, `@scorer`); promptfoo's tool callbacks are single-turn —
its own docs point complete agent loops at "the Agents SDK provider or a
custom provider" — so the end-state check there would be a hand-written
provider, which the issue rules out. End-state graders on a mounted stand-in
are the next slice after this one (a real `drive mount`, #229 and #241).
Install once, beside promptfoo's one-time install: `npm run
eval:agents:install`.

## What the agent gets

Only drive's own words:

- the public docs pages, rendered from `docs-site/*.md` into
  `docs-site/.rendered/`, exactly the Markdown the site serves to agents;
- the `drive --help` text in `context/drive-help.txt`, which
  `test/evals.test.mjs` proves still matches the `usage` string in
  `cmd/drive/main.go`. It is not pasted by hand: `npm run docs:render` writes
  it from that string, so the CLI gaining a flag cannot leave the snapshot
  stale.

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
score the second time. `promptfooconfig.yaml` runs promptfoo's stock
`options.transform` (`output.slice(-600)`) before those assertions, so a
grader scores the short visible reply the prompt asked for, not a leading
thinking dump that quotes the docs. An LLM judge is used only where the output
is prose, and its rubric is a list of checkable claims rather than a score; a
judge, when one is added, is a **different model family** from the agent under
test.

A grader also sees the same reading stack the agent saw: promptfoo hands an
assertion a `context`, and `context.vars` holds `defaultTest.vars` already
resolved, so a `file://` ref is that page's text. A task whose answer is a
fact the docs carry on a given day reads that fact out of `context` rather than
writing it into the task file. `the newest thing that shipped` is the case in
point: a literal date there failed 6/6 on 2026-10-03, the day the changelog
gained a heading above the one the task asserted (drive#324), and a grader that
tracks the changelog needs no edit when it does. `test/evals.test.mjs` grades
with the same `context` and the same body promptfoo builds, so the repo's own
gate fails on a grader that cannot name the newest heading — the failure the
grader-as-a-pure-function-of-the-whole-docs-corpus test could not see.

## Splits, and where the held-out set lives

The train split is roughly two thirds of the tasks and is this file. The
held-out test split and its answers are **not in the repository**: they live
at `/home/nish/.local/share/drive/eval-holdout.yaml` (set
`DRIVE_EVAL_SPLIT` to it), so the hill-climber (#223) cannot read them
from a checkout.
`test/evals.test.mjs` proves no held-out file is tracked by git.

## The models

The two `providers` in `promptfooconfig.yaml` are the scaling pair on the
fleet's own proxy at `127.0.0.1:4000`: `worker-cheap` at default effort, and
`worker-capable` as the stronger model. Temperature is 0. Three `repeat`s
still measure spread, because reasoning models vary at temperature 0. A run
sends the fleet worker virtual key as `OPENAI_API_KEY` (promptfoo's stock
OpenAI-compatible env). It does not call a paid external API.

## The end-state suite

`endstate.py` is the second half of the question: not "did the agent say the
right command" but "what does the account hold now". Each sample gets a fresh
account on a storage stand-in — a local `rclone serve s3`, the same stock
stand-in the repo's storage tests run, with a `u/<id>/` prefix for every
account, exactly the layout `src/files.js` pins (`u/${account}`) — with two
files seeded into it, and the agent works on it with a shell.

The grader (`end_state`) reads the account back and checks three things, and
never reads the agent's answer:

- **the target file exists with the right bytes** — the task's own end state;
- **nothing got deleted** — every seeded file still holds its bytes;
- **the key is scoped** — the only work anywhere on the stand-in is
  inside this sample's own `u/<id>/` prefix. The grader lists every
  object in the bucket (the server's directory cache is off, so a
  write the agent made is already there) and fails on any key
  outside the sample's prefix or inside another account's folder,
  and on a listing that could not be made at all.

The stand-in is anonymous (no `--auth-key`), like the repo's own: a key minted
and enforced by a storage endpoint is the STS work in `workers/api/src/s3-keys.js`,
and drive#173 measured that work against the real vendor (2026-10-03): iDrive e2
does not mint at all, so the seat moves to B2 and the proof repeats there. That
is the one part of "the key is scoped"
this stand-in cannot carry, and it is why the check above is a prefix check.

**The model's shell is a container, not the host.** The task declares
Inspect's Docker sandbox (`sandbox=("docker", "compose.yaml")`, the
`compose.yaml` beside this file): each sample works in its own stock
`python:3.12-bookworm` container, with `rclone` bind-mounted read-only, and
the stand-in reached over the host network. The grader runs on the host and
reads the stand-in there on purpose — the container is the agent's machine,
and the grader must not take the agent's word for the account's state. When
Docker is broken the run fails (`inspect` refuses to fall back to a shell on
the host), which is the fail-closed behaviour drive#526 asks for.

## What is not done yet

The end-state suite runs its tasks on a storage stand-in the agent reaches with
`rclone`; a real `drive mount` in the sandbox — the mounted folder, a scoped key
to attempt a delete with, the cap swap — is the next slice, with the proofs that
need a real mount (#229, #241).

## The scoreboard row

`docs/scoreboard.md` carries one row, "agents finish real tasks from the docs",
whose us-cell is a live run of this suite. `test/scoreboard.test.mjs` owns the
row list. The numbers, the command that repeats them and the run id live in
the us-cell.
