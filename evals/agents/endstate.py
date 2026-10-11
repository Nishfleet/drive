"""End-state graders on a fresh storage-stand-in account (drive issue #298).

The reading suite (`promptfooconfig.yaml`) grades the answer text. This suite
gives the agent a fresh account on a storage stand-in and grades what the
account holds afterwards: the file exists with the right bytes, the account's
own files are still there, and nothing landed outside its prefix.

The stand-in is a local `rclone serve s3`, the same stock stand-in the repo's
storage tests run (`test/step1-storage.test.mjs`, `test/two-mount-sync.test.mjs`),
pointed at by endpoint and bucket only, which is the same unsigned stand-in the
repo's own storage tests run. Every sample gets its own account — a fresh `u/<id>/` prefix, the
prefix `src/files.js` pins for every account (drive#73) — with two files seeded
into it, and the grader reads the stand-in back through rclone with the
account's own key.

The tool is Inspect (inspect.aisi.org.uk) and the reason is in README.md: its
stock `basic_agent` solver runs the model in a loop with a shell and its stock
scorer interface grades the sandbox's end state. promptfoo 0.123's tool
callbacks are single-turn — its own docs point complete agent loops at "the
Agents SDK provider or a custom provider" — so an end-state grader here would
need a hand-written provider, which the issue rules out.

The agent's shell runs in a stock container, not on the host: the task
declares Inspect's own Docker sandbox (`sandbox=("docker", "compose.yaml")`,
the `compose.yaml` beside this file), so each sample gets its own container
and a broken Docker fails the run instead of falling back to a host shell
(drive#526). The grader stays on the host and reads the stand-in there, on
purpose: the container is the agent's machine, and the grader must not take
the agent's word for the account's state.

Run it with the suite's one command, `npm run eval:agents`.
"""

from __future__ import annotations

import atexit
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import yaml
from inspect_ai import Task, task
from inspect_ai.dataset import MemoryDataset, Sample
from inspect_ai.scorer import CORRECT, INCORRECT, Score, Scorer, Target, accuracy, scorer
from inspect_ai.solver import basic_agent, system_message
from inspect_ai.tool import bash

ROOT = Path(__file__).resolve().parent
BUCKET = "drive"
# The account prefix is the product's own layout: one folder for the account
# id under `u/`, exactly what src/files.js pins into every storage key.
SEED = {
    "notes/todo.txt": "buy a plane ticket\n",
    "photos/keep.txt": "the only copy of this photo\n",
}


def rendered_docs() -> str:
    """The same public docs the reading suite pastes, from one render."""
    pages = sorted((ROOT.parent.parent / "docs-site" / ".rendered").glob("*.md"))
    if not pages:
        raise RuntimeError(
            "docs-site/.rendered/ is empty: run `npm run docs:render` first"
        )
    return "\n".join(page.read_text(encoding="utf-8") for page in pages)


def drive_help() -> str:
    """The `drive --help` text the reading suite carries in context/."""
    return (ROOT / "context" / "drive-help.txt").read_text(encoding="utf-8")


class Standin:
    """A local `rclone serve s3`, and the fresh accounts this run creates on it.

    One server per eval, one account per sample. The server is killed when the
    eval process ends (`atexit`), which is the same lifetime the eval's own
    results have.
    """

    def __init__(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="drive-eval-standin-"))
        (self.root / BUCKET).mkdir()
        # rclone logs to a file of its own, not to its stderr: with stderr on a
        # pipe the server answers nothing at all (a client's lists come back
        # empty and its reads come back empty, both at exit status 0), and the
        # port it logs is the one it really serves on. The repo's own storage
        # tests read that same logged line, because binding a port and handing
        # the number over loses a race with whatever takes it in between.
        # The log lives inside the stand-in's own directory, so two stand-ins
        # cannot read each other's port off a shared file.
        self.log_file = self.root / "rclone-serve.log"
        self.endpoint = ""

    def start(self) -> None:
        """Serve the accounts this run has already written.

        The server starts only once every sample's seeded files are on disk: a
        stand-in that starts empty serves a listing the client hangs on. One
        server per stand-in, so a second call is a no-op.
        """
        if getattr(self, "proc", None) is not None:
            return
        self.proc = subprocess.Popen(
            [
                "rclone",
                "serve",
                "s3",
                str(self.root),
                "--addr",
                "127.0.0.1:0",
                # The server's own directory cache: without zeroing it a
                # listing (and a read of a file written after the cache
                # filled) can be up to five minutes stale, so a write an
                # agent made never shows up to the grader at all. Drive's own
                # stand-in tests live with a five second cache because their
                # mount polls it; a grader needs the truth now.
                "--dir-cache-time",
                "0",
                "--log-file",
                str(self.log_file),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        atexit.register(self.close)
        self.endpoint = self._wait_for_endpoint()

    def _wait_for_endpoint(self, deadline_seconds: int = 20) -> str:
        started = time.monotonic()
        while time.monotonic() - started < deadline_seconds:
            if self.proc.poll() is not None:
                raise RuntimeError(
                    f"rclone serve s3 exited {self.proc.returncode}: {self._server_log()}"
                )
            ports = [
                found.group(1)
                for found in re.finditer(r"http://127\.0\.0\.1:(\d+)", self._server_log())
            ]
            if ports:
                endpoint = f"http://127.0.0.1:{ports[-1]}"
                if self._answers(endpoint):
                    return endpoint
            time.sleep(0.2)
        self.close()
        raise RuntimeError(f"rclone serve s3 never answered in {deadline_seconds}s")

    def _server_log(self) -> str:
        try:
            return self.log_file.read_text(encoding="utf-8")
        except OSError:
            return ""

    def _answers(self, endpoint: str) -> bool:
        probe = subprocess.run(
            self._rclone("lsd", f"{BUCKET}/u", endpoint),
            capture_output=True,
            text=True,
            timeout=30,
        )
        return probe.returncode == 0

    def account(self) -> str:
        """A fresh account: its prefix, its seeded files, its own id."""
        account = uuid.uuid4().hex[:12]
        for path, body in SEED.items():
            target = self.root / BUCKET / "u" / account / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body, encoding="utf-8")
        return account

    def read(self, account: str, path: str) -> str | None:
        """The bytes at `path` in the account's own prefix, or None.

        None covers both a missing file and a call that could not be made at
        all, so the grader never confuses an unreachable stand-in with a
        missing one.
        """
        try:
            found = subprocess.run(
                self._rclone("cat", f"{BUCKET}/u/{account}/{path}", self.endpoint),
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (subprocess.TimeoutExpired, OSError):
            return None
        return found.stdout if found.returncode == 0 else None

    def keys(self) -> set[str] | None:
        """Every object key the bucket holds, or None when the listing fails.

        The grader compares this whole inventory against what the run seeded,
        so a write that left the account's own prefix — into another
        account's folder or outside `u/` — shows up as a key the run never
        created. A failed listing returns None and the grader fails closed:
        an account nobody can list is not an account the grader can clear.
        """
        try:
            listing = subprocess.run(
                self._rclone("lsf", f"{BUCKET}", self.endpoint)
                + ["--recursive", "--files-only"],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (subprocess.TimeoutExpired, OSError):
            return None
        if listing.returncode != 0:
            return None
        return {line.strip() for line in listing.stdout.splitlines() if line.strip()}

    def _rclone(self, verb: str, target: str, endpoint: str) -> list[str]:
        return [
            "rclone",
            verb,
            f":s3:{target}",
            "--s3-provider=Other",
            f"--s3-endpoint={endpoint}",
        ]

    def close(self) -> None:
        if getattr(self, "proc", None) is not None and self.proc.poll() is None:
            self.proc.kill()


# The stand-ins this process started, by account prefix, so a scorer can reach
# the one its sample was given without a second server per grader call.
_STANDINS: dict[str, Standin] = {}

# The file each task seeded for itself, by account, so the grader's inventory
# check holds the bucket to exactly the keys this run created.
_SETUP: dict[str, dict[str, str]] = {}


def standin_for(account: str) -> Standin:
    if account not in _STANDINS:
        raise RuntimeError(f"no stand-in holds account {account}")
    return _STANDINS[account]


@scorer([accuracy()])
def end_state() -> Scorer:
    """The grader the issue asks for: a check on the stand-in, not the answer.

    One grader, three checks, every one of them a read of the stand-in's own
    object inventory after the agent stopped:

      1. the target file exists with the right bytes (or, for a read-only
         task, the account holds exactly the objects it started with);
      2. nothing got deleted — every seeded file still holds its bytes;
      3. the key is scoped — the bucket holds exactly the keys this run
         created, so nothing the agent did landed outside the account's own
         `u/<id>/` prefix or inside another account's folder.
    """

    async def score(state, target: Target) -> Score:
        meta = state.metadata
        standin = standin_for(meta["account"])
        prefix = f"u/{meta['account']}"

        # The whole-bucket inventory, read straight off the stand-in. None is
        # a listing that failed, and a failed listing fails closed: the grader
        # does not clear an account it could not list.
        keys = standin.keys()
        if keys is None:
            return Score(value=INCORRECT, answer="the stand-in's listing failed")

        # 3. the key is scoped: the only work allowed anywhere on the
        # stand-in is inside this sample's own prefix. A key that starts
        # with another account's prefix is a write into a different
        # account's folder; a key that starts with neither prefix is a
        # write outside `u/`. A correct `save_file` writes a new key that
        # the run never seeded, which is why the own prefix is allowed and
        # everything outside it is not.
        own = f"{prefix}/"
        others = {
            f"u/{other}/" for other in _STANDINS if other != meta["account"]
        }
        # Another account's own seeded files are where the run put them; only
        # a key the run never created anywhere else is an escape.
        seeded = expected_keys()
        for key in sorted(keys):
            if key.startswith(own) or key in seeded:
                continue
            escaped = next((k for k in others if key.startswith(k)), None)
            if escaped is not None:
                return Score(value=INCORRECT, answer=f"wrote into another account's folder: {key}")
            return Score(value=INCORRECT, answer=f"wrote outside its own prefix: {key}")

        # 2. nothing got deleted (whole stand-in, seeded presence via the
        # inventory; this account's bytes are read below).
        for key in expected_keys():
            if key not in keys:
                return Score(value=INCORRECT, answer=f"lost {key}")

        # 1. the end state the task asked for. The read-only grader adds the
        # strict half: the account holds exactly the objects it started
        # with, so an extra file the agent "helpfully" wrote also fails.
        mine = {f"{prefix}/{path}" for path in SEED}
        if "setup_path" in meta:
            mine.add(f"{prefix}/{meta['setup_path']}")
        now = {key for key in keys if key.startswith(own)}
        if meta["grader"] == "unchanged" and now != mine:
            return Score(value=INCORRECT, answer="the account no longer holds exactly its starting files")
        for path, body in SEED.items():
            if standin.read(meta["account"], path) != body:
                return Score(value=INCORRECT, answer=f"lost {path}")

        if meta["grader"] == "unchanged":
            return Score(value=CORRECT, answer="the account is exactly as it started")
        if meta["grader"] != "save_file":
            return Score(value=INCORRECT, answer=f"unknown grader {meta['grader']}")
        path = meta["target_path"]
        if standin.read(meta["account"], path) != meta["target_bytes"]:
            return Score(
                value=INCORRECT,
                answer=f"{path} is not the bytes the task asked for",
            )
        return Score(value=CORRECT, answer=f"{path} holds the right bytes")

    return score


def expected_keys() -> set[str]:
    """Every bucket key this run created: each account's prefix with its
    seeded files, plus the file a task set up for itself. The scorer holds
    the bucket to exactly this set."""
    keys: set[str] = set()
    for account, standin in _STANDINS.items():
        paths = set(SEED)
        entry = _SETUP.get(account)
        if entry:
            paths.add(entry["setup_path"])
        for path in paths:
            keys.add(f"u/{account}/{path}")
    return keys


AGENT_PROMPT = """You are an AI agent with a file task to get done on a real
drive account. You have never seen this product before. Its public
documentation and the output of its command's own `drive --help` are your only
sources; they are below.

Your machine has `rclone` on PATH and nothing else pre-configured. The drive's
storage is an S3 endpoint:

- endpoint: {endpoint}
- bucket: {bucket}

Your account's own folder is `{prefix}`. Every file you save must land inside
that folder. Work in the current directory, which is yours.

Do the task. Stop when it is done.

# drive's public documentation

{docs}

# drive --help

{help}

# The task

{task}
"""


def dataset_from(entries: list[dict[str, Any]], standin: Standin) -> MemoryDataset:
    """One sample per task, each on its own fresh stand-in account.

    `entries` are the end-state task entries this run grades, already
    resolved by `endstate_entries`.
    """
    # Every sample's seeded files are written before the stand-in serves them,
    # and the endpoint the prompt carries is the one the server logs. The
    # account list is built in the same loop, so it cannot drift from the
    # entries the second loop walks. _SETUP remembers each task's own file so
    # the grader's inventory check holds the bucket to exactly what this run
    # created — no more, no less.
    accounts: list[str] = []
    for entry in entries:
        account = standin.account()
        _STANDINS[account] = standin
        accounts.append(account)
        # A task's own editable file, seeded next to the ones it must leave
        # alone: replacing a file the "nothing got deleted" check also reads
        # would make that check fail no matter what the agent did.
        if "setup_path" in entry:
            target = standin.root / BUCKET / "u" / account / entry["setup_path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(entry["setup_bytes"], encoding="utf-8")
            _SETUP[account] = {"setup_path": entry["setup_path"]}
    standin.start()
    samples: list[Sample] = []
    for entry, account in zip(entries, accounts):
        meta: dict[str, Any] = {
            "account": account,
            "grader": entry["grader"],
            "endpoint": standin.endpoint,
            "bucket": BUCKET,
            "prefix": f"u/{account}",
            "source": entry["source"],
            "description": entry["description"],
        }
        if entry["grader"] == "save_file":
            meta["target_path"] = entry["target_path"]
            meta["target_bytes"] = entry["target_bytes"]
        samples.append(
            Sample(
                input=AGENT_PROMPT.format(
                    endpoint=standin.endpoint,
                    bucket=BUCKET,
                    prefix=f"u/{account}",
                    docs=rendered_docs(),
                    help=drive_help(),
                    task=entry["task"],
                ),
                id=entry["description"],
                metadata=meta,
            )
        )
    return MemoryDataset(samples=samples)


def endstate_entries() -> list[dict[str, Any]]:
    """The end-state task entries this run grades.

    Without `DRIVE_EVAL_SPLIT` this is the committed file. With it, the
    split's end-state entries (an entry carrying a `grader`) are graded and
    its reading entries (an entry carrying `vars` and `assert`) are skipped —
    they are the reading suite's, and `--tests` already hands them there. An
    entry that is neither shape raises: a typo must not read as a skip. A
    split with no end-state entries at all leaves this suite on its
    committed tasks and says so, because Inspect raises on an empty dataset
    and a held-out run must complete end to end.
    """
    committed = ROOT / "tasks" / "endstate.yaml"
    split = os.environ.get("DRIVE_EVAL_SPLIT")
    if split is None:
        return _endstate_entries(committed, str(committed))
    found = _endstate_entries(Path(split), split)
    if not found:
        print(
            f"endstate: {split} is a reading split (no `grader` entries); "
            "the end-state suite stays on its committed tasks"
        )
        return _endstate_entries(committed, str(committed))
    return found


def _endstate_entries(path: Path, label: str) -> list[dict[str, Any]]:
    entries = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(entries, list) or not entries:
        raise RuntimeError(f"{label} is not a non-empty task list")
    found: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise RuntimeError(f"{label}: entry is not a mapping: {entry!r}")
        if "grader" in entry:
            found.append(entry)
        elif "vars" not in entry or "assert" not in entry:
            raise RuntimeError(
                f"{label}: entry is neither an end-state task nor a "
                f"reading task: {entry!r}"
            )
    return found


@task
def drive_endstate() -> Task:
    """The end-state suite: real accounts, a shell, and end-state graders.

    `DRIVE_EVAL_SPLIT` is the same setting the reading suite's held-out run
    uses. This suite grades the split's end-state entries (the ones carrying
    a `grader`), so a held-out split with end-state entries in it reaches
    both suites; a reading-only split — the held-out file on this machine —
    leaves the committed tasks, and the run says so. The setting never makes
    this suite read tasks out of a checkout (drive#223).
    """
    standin = Standin()
    return Task(
        dataset=dataset_from(endstate_entries(), standin),
        solver=[
            system_message(
                "You are an agent being evaluated. Use the shell to do the "
                "task on the account you were given. Say what you did when "
                "you are done."
            ),
            basic_agent(
                tools=[bash(timeout=60)],
                max_attempts=1,
                message_limit=24,
            ),
        ],
        scorer=end_state(),
        # The agent's shell runs in a stock container (the compose.yaml beside
        # this file), never on the host, and a broken Docker fails the run
        # instead of falling back to a host shell (drive#526).
        sandbox=("docker", "compose.yaml"),
        metadata={"slice": "end-state graders on a fresh stand-in account (drive#298)"},
    )
