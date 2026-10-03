# Speed numbers

The figures behind the public Benchmarks page (drive issue #99). They are
measured by the Go benchmarks in `cmd/drive/bench_test.go`, and a row here
with no matching `h.report` call fails `test/benchmarks.test.mjs`.

Stand-in numbers on the same machine are not publishable. Linux figures below
stay `not yet measured` until a run against real storage (issue #173: iDrive
e2, once the `idrive` rclone remote exists on this host). Mac figures stay
`not yet measured` until they are run on a Mac; they are never estimated.

How to repeat, once real storage is configured. Credentials come from the VPS
credential store as environment variables, never from the command line (they
would land in shell history and in `ps`):

```
DRIVE_BENCH_ENDPOINT=https://s3.<region>.idrivee2.com \
DRIVE_BENCH_REGION=<region> DRIVE_BENCH_LINK_MBPS=<measured> \
go test ./cmd/drive -run '^$' -bench Bench -benchtime=1x -v
```

A harness proof against the loopback stand-in (not for this table):

```
DRIVE_BENCH_SCALE=quick go test ./cmd/drive -run '^$' -bench Bench -benchtime=1x -v
```

The public page injects the two sections below. A loss is labelled `lose`.
There is no measured Linux figure yet, so there is no loss to show.

Cold and warm file-open times (issue #194: the 1 MB document, the
500 MB video's play start and the 10 GB file, five runs each, median
reported, measured through the mount with `go test ./cmd/drive
-run TestOpenTimeColdAndWarm -v`) are stand-in figures on this host, so
they are not in this table; they wait for the same real-storage run
(issue #242) as every other Linux row.

## Linux VPS

Host: netcup VPS, Linux. Region, link speed and commit: not yet measured
(no real storage on this host; issue #173). Date of this table: 2026-10-02.

Every Linux row except `video-start-at-*` is timed through the mounted drive.
The `video-start-at-*` rows use stock rclone `--bwlimit`, which is the tool
the issue named for those four bandwidths.

| Scenario | Metric | Space (published, link, date) | Us | Result |
|---|---|---|---|---|
| video-start-first-byte | first-byte | streams byte ranges in real time, no 5 GB first-byte figure - [spacefs.com](https://spacefs.com) checked 2026-09-30 | not yet measured | not yet measured |
| video-start-first-byte | first-100mb | streams byte ranges in real time, no 5 GB first-100-MB figure - [spacefs.com](https://spacefs.com) checked 2026-09-30 | not yet measured | not yet measured |
| file-open | open | 4 KiB get 1.1 ms - [docs.spacefs.com/benchmarks](https://docs.spacefs.com/benchmarks/) checked 2026-09-30 | not yet measured | not yet measured |
| save-reaches-storage | 1gb-save | not published - [docs.spacefs.com/benchmarks](https://docs.spacefs.com/benchmarks/) checked 2026-09-30 | not yet measured | not yet measured |
| small-edit-64mb | append-4kib | append 4 KiB to a 64 MiB file 111 ms - [docs.spacefs.com/benchmarks](https://docs.spacefs.com/benchmarks/) checked 2026-09-30 | not yet measured | not yet measured |
| small-edit-2gb | append-4kib | not published (Space publishes the 64 MiB case only) - [docs.spacefs.com/benchmarks](https://docs.spacefs.com/benchmarks/) checked 2026-09-30 | not yet measured | not yet measured |
| list-folder | list-files | not published - [docs.spacefs.com/benchmarks](https://docs.spacefs.com/benchmarks/) checked 2026-09-30 | not yet measured | not yet measured |
| big-folder-rename | rename | move dir, 200 x 64 KiB, 99.0 ms - [docs.spacefs.com/benchmarks](https://docs.spacefs.com/benchmarks/) checked 2026-09-30 | not yet measured | not yet measured |
| small-file-put-4kib | put | put 4 KiB 60.6 ms - [docs.spacefs.com/benchmarks](https://docs.spacefs.com/benchmarks/) checked 2026-09-30 | not yet measured | not yet measured |
| small-file-put-1mib | put | put 1 MiB 126 ms - [docs.spacefs.com/benchmarks](https://docs.spacefs.com/benchmarks/) checked 2026-09-30 | not yet measured | not yet measured |
| small-file-get-1mib | get | get 1 MiB 8.3 ms - [docs.spacefs.com/benchmarks](https://docs.spacefs.com/benchmarks/) checked 2026-09-30 | not yet measured | not yet measured |
| video-start-at-25M | first-byte | recommends more than 300 Mbps down and 100 Mbps up, no 25 Mbps figure - [spacefs.com](https://spacefs.com) FAQ checked 2026-09-30 | not yet measured | not yet measured |
| video-start-at-25M | first-100mb | recommends more than 300 Mbps down and 100 Mbps up, no 25 Mbps figure - [spacefs.com](https://spacefs.com) FAQ checked 2026-09-30 | not yet measured | not yet measured |
| video-start-at-50M | first-byte | recommends more than 300 Mbps down and 100 Mbps up, no 50 Mbps figure - [spacefs.com](https://spacefs.com) FAQ checked 2026-09-30 | not yet measured | not yet measured |
| video-start-at-50M | first-100mb | recommends more than 300 Mbps down and 100 Mbps up, no 50 Mbps figure - [spacefs.com](https://spacefs.com) FAQ checked 2026-09-30 | not yet measured | not yet measured |
| video-start-at-100M | first-byte | recommends more than 300 Mbps down and 100 Mbps up, no 100 Mbps figure - [spacefs.com](https://spacefs.com) FAQ checked 2026-09-30 | not yet measured | not yet measured |
| video-start-at-100M | first-100mb | recommends more than 300 Mbps down and 100 Mbps up, no 100 Mbps figure - [spacefs.com](https://spacefs.com) FAQ checked 2026-09-30 | not yet measured | not yet measured |
| video-start-at-300M | first-byte | recommends more than 300 Mbps down and 100 Mbps up - [spacefs.com](https://spacefs.com) FAQ checked 2026-09-30 | not yet measured | not yet measured |
| video-start-at-300M | first-100mb | recommends more than 300 Mbps down and 100 Mbps up - [spacefs.com](https://spacefs.com) FAQ checked 2026-09-30 | not yet measured | not yet measured |
| install-to-mounted | install-to-first-file | 6-step quickstart, about five minutes - [docs.spacefs.com/start/quickstart](https://docs.spacefs.com/start/quickstart/) checked 2026-09-30 | not yet measured | not yet measured |
| mount-ready | ready | 6-step quickstart, about five minutes - [docs.spacefs.com/start/quickstart](https://docs.spacefs.com/start/quickstart/) checked 2026-09-30 | not yet measured | not yet measured |
| cli-cold-start | version | not published - [docs.spacefs.com/benchmarks](https://docs.spacefs.com/benchmarks/) checked 2026-09-30 | not yet measured | not yet measured |
| cross-machine-new-file | sync | "every device connected to the same Space sees the new version within seconds", no figure - [spacefs.com](https://spacefs.com) checked 2026-09-30 | not yet measured | not yet measured |
| cross-machine-edit | sync | "every device connected to the same Space sees the new version within seconds", no figure - [spacefs.com](https://spacefs.com) checked 2026-09-30 | not yet measured | not yet measured |
| cross-machine-delete | sync | "every device connected to the same Space sees the new version within seconds", no figure - [spacefs.com](https://spacefs.com) checked 2026-09-30 | not yet measured | not yet measured |

## Mac

Spec step 2 (docs/build-spec.md): from a Mac over home broadband, the first
frame of a 5 GB video under 3 s, and a 1 GB save reaching storage within 10 s.
Not yet measured. Do not estimate.

| Scenario | Metric | Spec | Us | Result |
|---|---|---|---|---|
| mac-first-frame | first-frame | first frame or viewport of a 5 GB video within 3 s | not yet measured | not yet measured |
| mac-1gb-save | 1gb-save | a 1 GB save reaches storage within 10 s | not yet measured | not yet measured |

<!-- end published -->
