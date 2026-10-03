"""End-state graders on a fresh storage-stand-in account (drive issue #298).

The reading suite (`promptfooconfig.yaml`) grades the answer text. This suite
gives the agent a fresh account on a storage stand-in and grades what the
account holds afterwards: the file exists with the right bytes, the account's
own files are still there, and nothing landed outside its prefix.

The stand-in is a local `rclone serve s3`, the same stock stand-in the repo's
storage tests run (`test/step1-storage.test.mjs`, `test/two-mount-sync.test.mjs`),
with one key pair (`--auth-key`) so the agent has to hold real credentials to
reach it. Every sample gets its own account — a fresh `u/<id>/` prefix, the
prefix `src/files.js` pins for every account (drive#73) — with two files seeded
into it, and the grader reads the stand-in back through rclone with the
account's own key.

The tool is Inspect (inspect.aisi.org.uk) and the reason is in README.md: its
stock `basic_agent` solver runs the model in a loop with a shell and its stock
scorer interface grades the sandbox's end state. promptfoo 0.123's tool
callbacks are single-turn — its own docs point complete agent loops at "the
Agents SDK provider or a custom provider" — so an end-state grader here would
need a hand-written provider, which the issue rules out.

Run it with the suite's one command, `npm run eval:agents`.
"""

from __future__ import annotations

import atexit
import re
import secrets
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any

import yaml
from inspect_ai import Task, task
from inspect_ai.dataset import MemoryDataset, Sample
from inspect_ai.scorer import CORRECT, INCORRECT, Score, Scorer, Target, scorer
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
        self.access = "drive" + secrets.token_hex(4)
        self.secret = secrets.token_hex(16)
        self.proc = subprocess.Popen(
            [
                "rclone",
                "serve",
                "s3",
                str(self.root),
                "--addr",
                "127.0.0.1:0",
                "--auth-key",
                f"{self.access},{self.secret}",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        atexit.register(self.close)
        self.endpoint = self._wait_for_endpoint()

    def _wait_for_endpoint(self) -> str:
        """Read the port back from rclone's own log line, as the storage tests
        do: binding a port and handing the number over loses a race with
        whatever takes it in between."""
        assert self.proc.stderr is not None
        deadline_lines = 200
        for _ in range(deadline_lines):
            line = self.proc.stderr.readline()
            found = re.search(r"http://127\.0\.0\.1:(\d+)", line)
            if found:
                endpoint = f"http://127.0.0.1:{found.group(1)}"
                if self._answers(endpoint):
                    return endpoint
        self.close()
        raise RuntimeError("rclone serve s3 never answered on 127.0.0.1")

    def _answers(self, endpoint: str) -> bool:
        probe = subprocess.run(
            [
                "rclone",
                "lsd",
                f":s3:{BUCKET}",
                "--s3-provider=Other",
                f"--s3-endpoint={endpoint}",
                f"--s3-access-key-id={self.access}",
                f"--s3-secret-access-key={self.secret}",
            ],
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
        """The bytes at `path` in the account's own prefix, or None."""
        found = subprocess.run(
            self._rclone("cat", f"{BUCKET}/u/{account}/{path}"),
            capture_output=True,
            text=True,
            timeout=30,
        )
        return found.stdout if found.returncode == 0 else None

    def roots(self) -> list[str]:
        """Every top-level prefix the bucket holds — `u/<account>` for each
        account, so a grader can see a write that left the account's own
        prefix without ever trusting the agent's word for where it wrote."""
        listing = subprocess.run(
            self._rclone("lsd", BUCKET),
            capture_output=True,
            text=True,
            timeout=30,
        )
        if listing.returncode != 0:
            return []
        return [
            line.rsplit("/", 1)[-1].strip()
            for line in listing.stdout.splitlines()
            if line.strip()
        ]

    def _rclone(self, verb: str, target: str) -> list[str]:
        return [
            "rclone",
            verb,
            f":s3:{target}",
            "--s3-provider=Other",
            f"--s3-endpoint={self.endpoint}",
            f"--s3-access-key-id={self.access}",
            f"--s3-secret-access-key={self.secret}",
        ]

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()


# The stand-ins this process started, by account prefix, so a scorer can reach
# the one its sample was given without a second server per grader call.
_STANDINS: dict[str, Standin] = {}


def standin_for(account: str) -> Standin:
    if account not in _STANDINS:
        raise RuntimeError(f"no stand-in holds account {account}")
    return _STANDINS[account]


@scorer
def end_state() -> Scorer:
    """The grader the issue asks for: a check on the stand-in, not the answer.

    One grader, three checks, every one of them a read of the account's own
    prefix after the agent stopped:

      1. the target file exists with the right bytes (or, for a read-only
         task, the account's files are exactly the ones it started with);
      2. nothing got deleted — every seeded file still holds its bytes;
      3. the key is scoped — nothing the agent did landed outside the
         account's own `u/<id>/` prefix.
    """

    async def score(state, target: Target) -> Score:
        meta = state.metadata
        standin = standin_for(meta["account"])
        prefix = f"u/{meta['account']}"

        # 3. the key is scoped: every key the stand-in now holds belongs to an
        # account this run created, so nothing the agent did landed outside
        # `u/` or inside another account's prefix.
        known = {f"u/{account}" for account in _STANDINS}
        for key in standin.roots():
            if key not in known and not any(key.startswith(f"{root}/") for root in known):
                return Score(value=INCORRECT, answer=f"wrote outside its own prefix: {key}")

        # 2. nothing got deleted.
        for path, body in SEED.items():
            if standin.read(meta["account"], path) != body:
                return Score(value=INCORRECT, answer=f"lost {path}")

        # 1. the end state the task asked for.
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


AGENT_PROMPT = """You are an AI agent with a file task to get done on a real
drive account. You have never seen this product before. Its public
documentation and the output of its command's own `drive --help` are your only
sources; they are below.

Your machine has `rclone` on PATH and nothing else pre-configured. The drive's
storage is an S3 endpoint:

- endpoint: {endpoint}
- bucket: {bucket}
- access key id: {access_key}
- secret access key: {secret}

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


def dataset_from(yaml_path: Path, standin: Standin) -> MemoryDataset:
    """One sample per task, each on its own fresh stand-in account."""
    entries = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    samples: list[Sample] = []
    for entry in entries:
        account = standin.account()
        _STANDINS[account] = standin
        meta: dict[str, Any] = {
            "account": account,
            "grader": entry["grader"],
            "endpoint": standin.endpoint,
            "bucket": BUCKET,
            "access_key": standin.access,
            "secret": standin.secret,
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
                    access_key=standin.access,
                    secret=standin.secret,
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


@task
def drive_endstate() -> Task:
    """The end-state suite: real accounts, a shell, and end-state graders."""
    standin = Standin()
    return Task(
        dataset=dataset_from(ROOT / "tasks" / "endstate.yaml", standin),
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
        sandbox="local",
        metadata={"slice": "end-state graders on a fresh stand-in account (drive#298)"},
    )
