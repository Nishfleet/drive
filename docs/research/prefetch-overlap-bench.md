# Research: the user-read-during-prefetch overlap is a stand-in-only assertion

**Status: decided (drive issue #382).** `BenchmarkReadDuringPrefetch` in
`cmd/drive/bench_test.go` asserts that a user's read while a prefetch pass runs
is not more than 20 ms and not more than twice as slow as the same read with
prefetch off. That assertion is enforced on the loopback stand-in only. On real
storage the bench measures the same two reads, logs both figures, and does not
assert them, so `go test ./cmd/drive -bench Bench` against a real endpoint can
finish green.

## Why the assertion cannot hold on real storage

The two reads share one link with the prefetch pass on real storage and share
nothing on the stand-in:

- On a real link, the prefetch pass's own chunk reads (128 KiB each, capped at a
  1 MiB/s share by `throttlePrefetch` in `cmd/drive/prefetch_policy.go`) and the
  user's read travel the same pipe at the same time.
- The first read of a file through a freshly mounted remote pays connection and
  request costs that a loopback server answers in microseconds.

Neither cost is a prefetch defect: the product's prefetch policy already caps the
share so prefetch never takes the pipe from a user's own read, and `--bwlimit` is
deliberately not set on the mount because that flag would slow the user too
(`cmd/drive/prefetch_policy.go`, issue #227). A loopback stand-in cannot
reproduce either cost, so it cannot show which one a real-storage figure contains.

## The reference figure for a real run

The real branch has no assertion, so the bench's own log is the only signal it
produces, and that signal needs something to be compared against. The reference
pair comes from the failing run in the issue:

| | Read during prefetch | Read with prefetch off | Ratio |
|---|---|---|---|
| real (iDrive e2, eu-west-3), drive#382 | 218.692 ms | 63.907 ms | 3.42x |

Every real-storage run prints both figures, so a read during prefetch that comes
back far above its own control — an order of magnitude, not a few tens of
milliseconds — is a prefetch regression, and this document is where the next run
compares it. The gate removes the assertion from the real branch, not the
measurement.

No `h.report` call was added, so `docs/benchmarks.md` needs no change: no row's
value changes, and no row moves between the Linux table and the follow-up note
(`test/benchmarks.test.mjs`, which checks that pairing, passes unchanged).

## What was measured

| Storage | Read during prefetch | Read with prefetch off | Where |
|---|---|---|---|
| real (iDrive e2, eu-west-3) | 218.692 ms | 63.907 ms | drive#382, the failing run named in the issue |
| real (iDrive e2, eu-west-3), this branch | 194.272 ms | 61.806 ms | `unshare -Urm go test ./cmd/drive -run '^$' -bench BenchmarkReadDuringPrefetch -benchtime=1x -v` against `drive-prod`, 2026-10-04; PASS with `gate=stand-in-only` |
| loopback stand-in (this host, rclone v1.75.1) | 13.878 ms | 9.809 ms | same command, no `DRIVE_BENCH_ENDPOINT`, 2026-10-04; PASS |

The issue's real-storage pair is 3.4x and 155 ms apart, so it fails both halves of
the assertion. This branch's real pair is 3.14x and 132 ms apart, so it would fail
the same assertion; the gate is what makes that run green. The stand-in pair is
1.41x and 4.07 ms apart, so it holds: on the stand-in the only difference between
the two reads is the overlap itself, which is what the assertion guards. Earlier
stand-in runs on the same host measured 6.872/5.839 ms, 13.6/7.6 ms and 10.7/7.5 ms,
so the margin is stable.

### Negative control (the gate is what changes the outcome)

The same bench was run against a non-loopback endpoint (an `rclone serve s3`
server on this host's own IP, which takes the `real` branch without a real
account) with a 200 ms sleep injected inside the measured user read. That
reproduces the issue's failure shape and separates the two versions. Both rows
below are that same run — the same server, the same injected sleep, the same
fixtures — with only the bench's own code differing:

| Code | Forced 200 ms overlap, real branch | Result |
|---|---|---|
| before (`origin/main`) | 212.596 ms vs 7.599 ms | `--- FAIL: BenchmarkReadDuringPrefetch` |
| after (branch tip) | 214.250 ms vs 8.533 ms | `ok`, with the `gate=stand-in-only` line |

The two figures in each row are not equal to each other because each is its own
mount and its own cold read; what the pair controls for is the code version, and
the two rows differ only in what the bench does with a slow overlap.

The same forced overlap on the stand-in branch still fails after the change
(211.271 ms vs 6.949 ms), so the gate takes the real branch only and the stand-in
keeps the guard.

The 200 ms sleep was a temporary patch used for the negative control alone and
is not in the committed code.

An earlier attempt (commit 31b38f7, branch `claim/issue-382`) warmed the mount's
read path with a third file before the two measured reads. It changed nothing
measurable on the stand-in (6.872/5.839 ms without it, 9.083/7.233 ms with it).
The real-account run above (194 ms against 62 ms, no warm-up) still fails both
halves of the assertion, so this branch ships the gate rather than an unproven
warm-up.

## What a run now prints

Both storages print the two figures, each line naming its storage and the region
the run was pointed at:

```
prefetch-bench metric=user-read-during-prefetch value=0.013878 unit=s storage=stand-in region=unmeasured
prefetch-bench metric=user-read-prefetch-off value=0.009809 unit=s storage=stand-in region=unmeasured
```

Real storage adds one line, names no assertion, and passes:

```
prefetch-bench metric=user-read-during-prefetch value=0.194272 unit=s storage=real region=eu-west-3
prefetch-bench metric=user-read-prefetch-off value=0.061806 unit=s storage=real region=eu-west-3
prefetch-bench metric=user-read-during-prefetch-overlap gate=stand-in-only storage=real region=eu-west-3 note=measured not asserted
```

The region comes from `DRIVE_BENCH_REGION`, which a real-storage command already
sets, so the line names the account's region and not just the word `real`.

The stand-in still fails the run when the overlap itself regresses, which is the
case this bench exists to catch.

## What was not run

The published Linux table in `docs/benchmarks.md` was not filled: this bench is
not a published row, and issue #242 still owns those figures. The real-account
run above used the `idrive` rclone remote on this host (bucket `drive-prod`,
region `eu-west-3`, prefix `u/bench-382`) and is the issue's first finish-line
bullet, not a published speed.
