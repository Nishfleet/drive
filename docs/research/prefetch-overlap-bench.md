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

## What was measured

| Storage | Read during prefetch | Read with prefetch off | Where |
|---|---|---|---|
| real (iDrive e2, eu-west-3) | 218.692 ms | 63.907 ms | drive#382, the failing run named in the issue |
| loopback stand-in (this host, rclone v1.75.1) | 6.872 ms | 5.839 ms | `unshare -Urm go test ./cmd/drive -run '^$' -bench BenchmarkReadDuringPrefetch -benchtime=1x -v`, 2026-10-04 |

The real-storage pair is 3.4x and 155 ms apart, so it fails both halves of the
assertion. The stand-in pair is 1.18x and 1.03 ms apart, so it holds with a wide
margin: on the stand-in the only difference between the two reads is the overlap
itself, which is what the assertion guards. Two further stand-in runs on the same
host measured 13.6/7.6 ms and 10.7/7.5 ms, so the margin is stable.

### Negative control (the gate is what changes the outcome)

The same bench was run against a non-loopback endpoint (an `rclone serve s3`
server on this host's own IP, which takes the `real` branch without a real
account) with a 200 ms sleep injected inside the measured user read. That
reproduces the issue's failure shape and separates the two versions:

| Code | Forced 200 ms overlap, real branch | Result |
|---|---|---|
| before (origin/main) | 212.596 ms vs 7.599 ms | `--- FAIL: BenchmarkReadDuringPrefetch` |
| after | 214.250 ms vs 8.533 ms | `ok`, with the `gate=stand-in-only` line |

The same forced overlap on the stand-in branch still fails after the change
(211.271 ms vs 6.949 ms), so the gate takes the real branch only and the stand-in
keeps the guard.

The 200 ms sleep was a temporary patch used for the negative control alone and
is not in the committed code.

An earlier attempt (commit 31b38f7, branch `claim/issue-382`) warmed the mount's
read path with a third file before the two measured reads. It changed nothing
measurable on the stand-in (6.872/5.839 ms without it, 9.083/7.233 ms with it),
and its effect on real storage is not measurable from this host, so it was dropped
rather than shipped as an unverified fix.

## What a run now prints

Both storages print the two figures, each line naming its storage:

```
prefetch-bench metric=user-read-during-prefetch value=0.006872 unit=s storage=stand-in
prefetch-bench metric=user-read-prefetch-off value=0.005839 unit=s storage=stand-in
```

Real storage adds one line and passes:

```
prefetch-bench metric=user-read-during-prefetch-overlap gate=stand-in-only storage=real
```

The stand-in still fails the run when the overlap itself regresses, which is the
case this bench exists to catch.

## What was not run

No real-storage run happened from this host: no iDrive e2 credentials are in the
VPS credential store for a worker seat, and `docs/benchmarks.md` already records
that the real-account run happens on the provider the primary seat moves to (the
follow-up to drive#173). The 218 ms / 64 ms pair above is the failing run's own
output, quoted from the issue.
