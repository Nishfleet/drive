# Scoreboard: us against the competitor, row by row

Nish's standing goal is to beat the competitor on every measurable metric, and this is
the one head-to-head table. Every row compares the competitor's published figure (with
the page it was read on and the date it was checked, or `not published`) against
our own measured or computed number (with the date, the commit and the command
that repeats it, or `not yet measured`). Nothing here is estimated.

- **Verdicts.** `win` means our verified figure or shipped capability beats
  The competitor's published one, or the competitor publishes nothing for the row. `lose` means
  The competitor's published figure is better, or the competitor ships the row and we do not.
  `not yet measured` means we have no verified figure and no shipped capability
  for the row yet, so there is nothing to compare.
- **Our side is never guessed** (issue #114). A row with no measurement says
  `not yet measured` and names the issue that will produce it.
- **Every losing or unmeasured row names its issue**; a row whose issue does not
  exist yet is listed under "Rows with no issue yet" at the bottom, so the
  orchestrator can file it.
- **Speed rows cannot get slower in silence.** The CI ratchet in
  `bench/baseline.json` is a stand-in loopback ceiling (not a published Us
  figure). A PR that makes a row faster lowers that row in the same PR.
- **The price rows are computed, not typed.** `test/scoreboard.test.mjs`
  recomputes them from `monthBillCents` in `src/billing.js` and fails if this
  table drifts from the code. (Issue #114 named `src/pricing.js`; that module
  still holds the superseded per-TB caps and is issue #23's to fix — `src/seo.js`
  documents the divergence — so the scoreboard reads the one billing function
  that `AGENTS.md`'s money gate names instead.) Each price is the month's bill
for that size held all month, after the membership floor, which is what a
customer actually pays.
- **The competitor was checked on 2026-09-30** against the competitor's site (pricing,
  platform and FAQ figures, including its JavaScript bundle for the collapsed
  FAQ answers) and the competitor's docs (benchmarks, quickstart, guides).
  A figure that page did not carry is marked `not published`.

| Metric | Competitor (published, source, date) | Us (measured, date, commit, how to repeat) | Verdict | Issue |
|---|---|---|---|---|
| file open time | "Files open instantly"; 4 KiB get 1.1 ms, 64 MiB get 47.2 ms, 256 MiB stream get 178 ms - the competitor's docs checked 2026-09-30 | 48 ms to open a 4 KiB file through the mount (real, iDrive e2 eu-west-3, 1154 Mbps) - measured 2026-10-04, commit d0aaf45, repeat: `DRIVE_BENCH_ENDPOINT=https://s3.eu-west-3.idrivee2.com DRIVE_BENCH_REGION=eu-west-3 DRIVE_BENCH_LINK_MBPS=1154 unshare -Urm go test ./cmd/drive -run '^$' -bench '^BenchmarkFileOpen$' -benchtime=1x -v`. CI ratchet: `bench/baseline.json` row `file-open`. | lose | #242 |
| 5 GB video start time | streams byte ranges in real time, no 5 GB figure - the competitor's site checked 2026-09-30 | first byte of a 5 GB file 274 ms, first 100 MB 1.72 s (real, iDrive e2 eu-west-3, 1154 Mbps) - measured 2026-10-04, commit d0aaf45, repeat: `DRIVE_BENCH_ENDPOINT=https://s3.eu-west-3.idrivee2.com DRIVE_BENCH_REGION=eu-west-3 DRIVE_BENCH_LINK_MBPS=1154 unshare -Urm go test ./cmd/drive -run '^$' -bench '^BenchmarkVideoStartFirstByte$' -benchtime=1x -v`. CI ratchet: `bench/baseline.json` row `video-start`. | win | #242 |
| cross-machine sync time | "every device connected to the same drive sees the new version within seconds", no figure - the competitor's site checked 2026-09-30 | not yet measured for two real machines; a stand-in proof measured 5.0 s, both directions, on two mounts on one Linux host - measured 2026-09-30, commit fd0b6a8, repeat: `node --test test/two-mount-sync.test.mjs` | not yet measured | #121 |
| small-file speed (under 1 MiB) | put 4 KiB 60.6 ms, put 1 MiB 126 ms, get 1 MiB 8.3 ms - the competitor's docs checked 2026-09-30 | put 4 KiB 5.68 s, put 1 MiB 5.54 s, get 1 MiB 4 ms (real, iDrive e2 eu-west-3, 1154 Mbps) - measured 2026-10-04, commit d0aaf45, repeat: `DRIVE_BENCH_ENDPOINT=https://s3.eu-west-3.idrivee2.com DRIVE_BENCH_REGION=eu-west-3 DRIVE_BENCH_LINK_MBPS=1154 unshare -Urm go test ./cmd/drive -run '^$' -bench '^BenchmarkSmallFiles$' -benchtime=1x -v`. CI ratchet: `bench/baseline.json` rows `small-file-put`, `small-file-get`. | lose | #242 |
| small edit in a big file | append 4 KiB to a 64 MiB file 111 ms - the competitor's docs checked 2026-09-30 | append 4 KiB to 64 MiB 6.31 s, to 2 GiB 40.9 s (real, iDrive e2 eu-west-3, 1154 Mbps) - measured 2026-10-04, commit d0aaf45, repeat: `DRIVE_BENCH_ENDPOINT=https://s3.eu-west-3.idrivee2.com DRIVE_BENCH_REGION=eu-west-3 DRIVE_BENCH_LINK_MBPS=1154 unshare -Urm go test ./cmd/drive -run '^$' -bench '^BenchmarkSmallEdit$' -benchtime=1x -v`. CI ratchet: `bench/baseline.json` row `small-edit`. | lose | #97 |
| big-folder rename | move dir, 200 x 64 KiB, 99.0 ms - the competitor's docs checked 2026-09-30 | rename of 10000 files 128 s (real, iDrive e2 eu-west-3, 1154 Mbps) - measured 2026-10-04, commit d0aaf45, repeat: `DRIVE_BENCH_ENDPOINT=https://s3.eu-west-3.idrivee2.com DRIVE_BENCH_REGION=eu-west-3 DRIVE_BENCH_LINK_MBPS=1154 unshare -Urm go test ./cmd/drive -run '^$' -bench '^BenchmarkBigFolderRename$' -benchtime=1x -v`. CI ratchet: `bench/baseline.json` row `big-folder-rename`. | lose | #104 |
| bandwidth needed | recommends more than 300 Mbps down and 100 Mbps up - the competitor's site FAQ checked 2026-09-30 | first byte of the 5 GB video at rclone `--bwlimit` 25M 195 ms, 50M 207 ms, 100M 217 ms, 300M 218 ms; first 100 MB 3.95 s, 2.02 s, 1.06 s, 519 ms (real, iDrive e2 eu-west-3, 1154 Mbps) - measured 2026-10-04, commit d0aaf45, repeat: `DRIVE_BENCH_ENDPOINT=https://s3.eu-west-3.idrivee2.com DRIVE_BENCH_REGION=eu-west-3 DRIVE_BENCH_LINK_MBPS=1154 unshare -Urm go test ./cmd/drive -run '^$' -bench '^BenchmarkVideoStartBandwidth$' -benchtime=1x -v` | win | #242 |
| setup steps and time to first file | 6-step quickstart, about five minutes - the competitor's docs checked 2026-09-30 | first-run screen: 7 lines before this PR, 2 after (already signed in, no agent tools); path is `drive init` then `drive mount` - measured 2026-10-03, commit d899202, repeat: `go test ./cmd/drive -run TestFirstRunTranscript -count=1`; install to first file 1.02 s and mount-ready 208 ms (real, iDrive e2 eu-west-3, 1154 Mbps) - measured 2026-10-04, commit d0aaf45, repeat: `DRIVE_BENCH_ENDPOINT=https://s3.eu-west-3.idrivee2.com DRIVE_BENCH_REGION=eu-west-3 DRIVE_BENCH_LINK_MBPS=1154 unshare -Urm go test ./cmd/drive -run '^$' -bench BenchmarkInstallToMounted -benchtime=1x -v` and the same for BenchmarkMountReady; CI stand-in ratchet: `bench/baseline.json` rows `mount-ready`, `cli-cold-start` | win | #105 |
| offline pinning | pin a file or folder and a complete copy stays until unpin - the competitor's site FAQ checked 2026-09-30 | stand-in through the installed login item (`drive init` writes a unit that runs `drive mount --foreground`): two devices kept both saves as a conflict copy, and a pinned file stayed readable after storage was stopped; the whole two-device proof ran 61.8 s of wall clock on this host (the number is the proof's own run time, not a speed figure - the test reports no benchmark numbers) - measured 2026-10-08, commit 4e61f02, repeat: `unshare -Urm go test ./cmd/drive -run TestTwoDevicesKeepBothSavesThroughTheInstalledUnit -v`. Earlier stand-in-only proofs (14.6 s / 12.7 s) used `--foreground` or bare rclone and did not start the installed unit. | win | #515 |
| version history | every change is a version, kept; the competitor's history command lists every version - the competitor's site and the competitor's docs checked 2026-09-30 | not yet measured (30 days planned: 1 day on B2, then one a day) | lose | #9 |
| price at 100 GB | $15 a month billed yearly ($180 a year; the 1 TB plan is the smallest) - the competitor's site checked 2026-09-30 | $2.00 a month - measured 2026-10-07, commit 0245aba, repeat: `node --test test/scoreboard.test.mjs` | win | #642 |
| price at 500 GB | $15 a month billed yearly ($180 a year) - the competitor's site checked 2026-09-30 | $10.00 a month - measured 2026-10-07, commit 0245aba, repeat: `node --test test/scoreboard.test.mjs` | win | #642 |
| price at 1 TB | $15 a month billed yearly ($180 a year), about $20 month to month ("save 25%") - the competitor's site checked 2026-09-30 | $15.00 a month (a tie at 1 TB, dearer above it) - measured 2026-10-07, commit 0245aba, repeat: `node --test test/scoreboard.test.mjs` | lose | #642 |
| price at 2 TB | $27 a month billed yearly ($15 + 2 x $6 per extra 500 GB) - the competitor's site checked 2026-09-30 | $30.00 a month (a tie at 1 TB, dearer above it) - measured 2026-10-07, commit 0245aba, repeat: `node --test test/scoreboard.test.mjs` | lose | #642 |
| price at 5 TB | $63 a month billed yearly ($15 + 8 x $6 per extra 500 GB) - the competitor's site checked 2026-09-30 | $75.00 a month (a tie at 1 TB, dearer above it) - measured 2026-10-07, commit 0245aba, repeat: `node --test test/scoreboard.test.mjs` | lose | #642 |
| agent features: MCP setup | not published (the competitor documents an SDK, not MCP) - the competitor's docs checked 2026-09-30 | one command per tool for claude, codex, cursor, gemini and kiro - shipped 2026-09-30, commit 73beb26, repeat: `go test ./cmd/drive` | win | #5 |
| agent features: no-delete keys | not published (keys are read, write or admin scoped, and write includes object deletes) - the competitor's docs checked 2026-09-30 | an agent key carries list, read and write and can never carry delete - shipped 2026-09-30, commit ab97aa8, repeat: `node --test test/cap-keyprovider-table.test.mjs` | win | #55 |
| agent features: undo | keep every version and roll back any time - the competitor's docs checked 2026-09-30 | not yet measured (not built) | lose | #13 |
| agent features: spending cap | "spending controls", no default or figure - the competitor's changelog checked 2026-09-30 | default $20; at the cap the write key is swapped read-only and nothing is deleted - shipped 2026-10-05, commit 1125fdb, repeat: `node --test test/cap.test.mjs test/abuse-guards.test.mjs` | win | #464 |
| agent features: branches with review | fork a whole drive without copying a byte; no review step published - the competitor's site and the competitor's docs checked 2026-09-30 | not yet measured (not built) | lose | #8 |
| agents finish real tasks from the docs | not published - the competitor's site and the competitor's docs checked 2026-10-02 | train cheap 86.82% / capable 82.17% (43 tasks x 3 epochs, 3-epoch spread 16.28 cheap and 6.98 capable, eval-vK6); held-out cheap 97.92% / capable 95.83% (16 tasks, one task is 6.25 points, eval-FMf) - measured 2026-10-03, commit 2168ae9, repeat: `npm run eval:agents` (train) and `DRIVE_EVAL_SPLIT=/home/nish/.local/share/drive/eval-holdout.yaml npm run eval:agents` (test) | win | #222 |
| disk use | zero bytes on disk; caches only the parts an app asks for - the competitor's site checked 2026-09-30 | stand-in: read 36 MiB (6 x 6 MiB) through a 24M cap, cache on disk 24.0 MiB in 4 files (rclone's own count 24.0 MiB); shipped cap 20G with a 1G free-space floor - measured 2026-10-03, commit e722ef2, repeat: `unshare -Urm go test ./cmd/drive -run TestCacheCapHoldsThroughAReadPastIt -v` | win | #112 |
| minimum macOS | macOS Tahoe 26.4 or later - the competitor's site FAQ checked 2026-09-30 | not yet measured; the mount proof now runs on macOS through `rclone nfsmount` (no macFUSE), and #116's CI job runs it on the Mac images GitHub offers; the publishable minimum is the oldest of those images with a green run | not yet measured | #116 |
| pause and resume an upload | not published - the competitor's site checked 2026-09-30 | not yet measured | not yet measured | #100 |
| Windows install and mount | "Mac and Linux; Windows 'coming soon'" - the competitor's changelog checked 2026-09-30 | not yet measured (the Windows MSI builds with the stock WiX toolchain; the windows-latest job in drive#291 runs the silent install, the drive-letter write and read back, and the clean uninstall, and this row takes its figure from that run's log) | not yet measured | #154 |

## Rows with no issue yet

None. Every losing or unmeasured row names its issue.
