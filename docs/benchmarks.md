# Speed numbers

The figures behind the public Benchmarks page (drive issue #99). They are
measured by the Go benchmarks in `cmd/drive/bench_test.go`, and a row here
with no matching `h.report` call fails `test/benchmarks.test.mjs`.

Stand-in numbers on the same machine are not publishable. Linux figures below
are from a real-storage run on this host against iDrive e2 (the `idrive`
rclone remote, bucket `drive-prod`, region eu-west-3) on 2026-10-04. drive#173
measured that account out of the primary seat (its STS cannot scope a key to
a prefix); #363 is the B2 switch. These rows are the iDrive e2 numbers, not
an estimate of B2. Mac figures stay not yet measured until they are run on a Mac;
they are never estimated.

How to repeat. Credentials come from the VPS credential store as environment
variables, never from the command line (they would land in shell history and
in `ps`). This host needs an unprivileged FUSE user namespace:

```
DRIVE_BENCH_ENDPOINT=https://s3.eu-west-3.idrivee2.com \
DRIVE_BENCH_REGION=eu-west-3 DRIVE_BENCH_LINK_MBPS=<measured> \
unshare -Urm go test ./cmd/drive -run '^$' -bench Bench -benchtime=1x -v
```

A harness proof against the loopback stand-in (not for this table):

```
DRIVE_BENCH_SCALE=quick go test ./cmd/drive -run '^$' -bench Bench -benchtime=1x -v
```

The public page injects the two sections below. A loss is labelled `lose`.
File open, the 64 MiB small edit, the 10 000-file rename and both small-file
puts are losses against a rival's published figures.

Cold and warm file-open times (issue #194: the 1 MB document, the
500 MB video's play start and the 10 GB file, five runs each, median
reported, measured through the mount with `go test ./cmd/drive
-run TestOpenTimeColdAndWarm -v`) are stand-in figures on this host, so
they are not in this table.

## Linux VPS

Host: netcup VPS, Linux. Region: eu-west-3 (iDrive e2). Measured link:
1154 Mbps (128 MiB put to the same bucket). Commit of the binary that
produced the figures: d0aaf45. Date of this table: 2026-10-04.

Every Linux row except `video-start-at-*` is timed through the mounted drive.
The `video-start-at-*` rows use stock rclone `--bwlimit`, which is the tool
the issue named for those four bandwidths.

| Scenario | Metric | A rival (published, date) | Us | Result |
|---|---|---|---|---|
| video-start-first-byte | first-byte | streams byte ranges in real time, no 5 GB first-byte figure - a rival's site, checked 2026-09-30 | 274 ms (real, iDrive e2 eu-west-3, 1154 Mbps, 2026-10-04, commit d0aaf45) | win |
| video-start-first-byte | first-100mb | streams byte ranges in real time, no 5 GB first-100-MB figure - a rival's site, checked 2026-09-30 | 1.72 s (real, iDrive e2 eu-west-3, 1154 Mbps, 2026-10-04, commit d0aaf45) | win |
| file-open | open | 4 KiB get 1.1 ms - a rival's benchmark page, checked 2026-09-30 | 48 ms (real, iDrive e2 eu-west-3, 1154 Mbps, 2026-10-04, commit d0aaf45) | lose |
| save-reaches-storage | 1gb-save | not published - a rival's benchmark page, checked 2026-09-30 | 22.4 s (real, iDrive e2 eu-west-3, 1154 Mbps, 2026-10-04, commit d0aaf45) | win |
| small-edit-64mb | append-4kib | append 4 KiB to a 64 MiB file 111 ms - a rival's benchmark page, checked 2026-09-30 | 6.31 s (real, iDrive e2 eu-west-3, 1154 Mbps, 2026-10-04, commit d0aaf45) | lose |
| small-edit-2gb | append-4kib | not published (the rival publishes the 64 MiB case only) - a rival's benchmark page, checked 2026-09-30 | 40.9 s (real, iDrive e2 eu-west-3, 1154 Mbps, 2026-10-04, commit d0aaf45) | win |
| list-folder | list-files | not published - a rival's benchmark page, checked 2026-09-30 | 2.06 s (real, iDrive e2 eu-west-3, 1154 Mbps, 2026-10-04, commit d0aaf45) | win |
| big-folder-rename | rename | move dir, 200 x 64 KiB, 99.0 ms - a rival's benchmark page, checked 2026-09-30 | 128 s for 10 000 files (real, iDrive e2 eu-west-3, 1154 Mbps, 2026-10-04, commit d0aaf45) | lose |
| small-file-put-4kib | put | put 4 KiB 60.6 ms - a rival's benchmark page, checked 2026-09-30 | 5.68 s (real, iDrive e2 eu-west-3, 1154 Mbps, 2026-10-04, commit d0aaf45) | lose |
| small-file-put-1mib | put | put 1 MiB 126 ms - a rival's benchmark page, checked 2026-09-30 | 5.54 s (real, iDrive e2 eu-west-3, 1154 Mbps, 2026-10-04, commit d0aaf45) | lose |
| small-file-get-1mib | get | get 1 MiB 8.3 ms - a rival's benchmark page, checked 2026-09-30 | 4 ms (real, iDrive e2 eu-west-3, 1154 Mbps, 2026-10-04, commit d0aaf45) | win |
| video-start-at-25M | first-byte | recommends more than 300 Mbps down and 100 Mbps up, no 25 Mbps figure - a rival's FAQ, checked 2026-09-30 | 195 ms (real, iDrive e2 eu-west-3, 1154 Mbps, rclone --bwlimit 25M, 2026-10-04, commit d0aaf45) | win |
| video-start-at-25M | first-100mb | recommends more than 300 Mbps down and 100 Mbps up, no 25 Mbps figure - a rival's FAQ, checked 2026-09-30 | 3.95 s (real, iDrive e2 eu-west-3, 1154 Mbps, rclone --bwlimit 25M, 2026-10-04, commit d0aaf45) | win |
| video-start-at-50M | first-byte | recommends more than 300 Mbps down and 100 Mbps up, no 50 Mbps figure - a rival's FAQ, checked 2026-09-30 | 207 ms (real, iDrive e2 eu-west-3, 1154 Mbps, rclone --bwlimit 50M, 2026-10-04, commit d0aaf45) | win |
| video-start-at-50M | first-100mb | recommends more than 300 Mbps down and 100 Mbps up, no 50 Mbps figure - a rival's FAQ, checked 2026-09-30 | 2.02 s (real, iDrive e2 eu-west-3, 1154 Mbps, rclone --bwlimit 50M, 2026-10-04, commit d0aaf45) | win |
| video-start-at-100M | first-byte | recommends more than 300 Mbps down and 100 Mbps up, no 100 Mbps figure - a rival's FAQ, checked 2026-09-30 | 217 ms (real, iDrive e2 eu-west-3, 1154 Mbps, rclone --bwlimit 100M, 2026-10-04, commit d0aaf45) | win |
| video-start-at-100M | first-100mb | recommends more than 300 Mbps down and 100 Mbps up, no 100 Mbps figure - a rival's FAQ, checked 2026-09-30 | 1.06 s (real, iDrive e2 eu-west-3, 1154 Mbps, rclone --bwlimit 100M, 2026-10-04, commit d0aaf45) | win |
| video-start-at-300M | first-byte | recommends more than 300 Mbps down and 100 Mbps up - a rival's FAQ, checked 2026-09-30 | 218 ms (real, iDrive e2 eu-west-3, 1154 Mbps, rclone --bwlimit 300M, 2026-10-04, commit d0aaf45) | win |
| video-start-at-300M | first-100mb | recommends more than 300 Mbps down and 100 Mbps up - a rival's FAQ, checked 2026-09-30 | 519 ms (real, iDrive e2 eu-west-3, 1154 Mbps, rclone --bwlimit 300M, 2026-10-04, commit d0aaf45) | win |
| install-to-mounted | install-to-first-file | 6-step quickstart, about five minutes - a rival's quickstart, checked 2026-09-30 | 1.02 s (real, iDrive e2 eu-west-3, 1154 Mbps, 2026-10-04, commit d0aaf45) | win |
| mount-ready | ready | 6-step quickstart, about five minutes - a rival's quickstart, checked 2026-09-30 | 208 ms (real, iDrive e2 eu-west-3, 1154 Mbps, 2026-10-04, commit d0aaf45) | win |
| cli-cold-start | version | not published - a rival's benchmark page, checked 2026-09-30 | 4 ms (real Linux VPS run, CLI talks to no storage, 2026-10-04, commit d0aaf45) | win |
| cross-machine-new-file | sync | says a change shows up on every connected device within seconds, no figure - a rival's site, checked 2026-09-30 | 10.2 s (real, iDrive e2 eu-west-3, 1154 Mbps, two mounts on this host, 2026-10-04, commit d0aaf45) | win |
| cross-machine-edit | sync | says a change shows up on every connected device within seconds, no figure - a rival's site, checked 2026-09-30 | 5.33 s (real, iDrive e2 eu-west-3, 1154 Mbps, two mounts on this host, 2026-10-04, commit d0aaf45) | win |
| cross-machine-delete | sync | says a change shows up on every connected device within seconds, no figure - a rival's site, checked 2026-09-30 | 4.89 s (real, iDrive e2 eu-west-3, 1154 Mbps, two mounts on this host, 2026-10-04, commit d0aaf45) | win |

## Mac

Spec step 2 (docs/build-spec.md): from a Mac over home broadband, the first
frame of a 5 GB video under 3 s, and a 1 GB save reaching storage within 10 s.
Not yet measured. Do not estimate.

| Scenario | Metric | Spec | Us | Result |
|---|---|---|---|---|
| mac-first-frame | first-frame | first frame or viewport of a 5 GB video within 3 s | not yet measured | not yet measured |
| mac-1gb-save | 1gb-save | a 1 GB save reaches storage within 10 s | not yet measured | not yet measured |

<!-- end published -->
