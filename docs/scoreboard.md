# Scoreboard: us against Space, row by row

Nish's standing goal is to beat Space on every measurable metric, and this is
the one head-to-head table. Every row compares Space's published figure (with
the page it was read on and the date it was checked, or `not published`) against
our own measured or computed number (with the date, the commit and the command
that repeats it, or `not yet measured`). Nothing here is estimated.

- **Verdicts.** `win` means our verified figure or shipped capability beats
  Space's published one, or Space publishes nothing for the row. `lose` means
  Space's published figure is better, or Space ships the row and we do not.
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
  for that size held all month, after the $1 free credit, which is what a
  customer actually pays.
- **Space was checked on 2026-09-30** against `https://spacefs.com` (pricing,
  platform and FAQ figures, including its JavaScript bundle for the collapsed
  FAQ answers) and `https://docs.spacefs.com` (benchmarks, quickstart, guides).
  A figure that page did not carry is marked `not published`.

| Metric | Space (published, link, date) | Us (measured, date, commit, how to repeat) | Verdict | Issue |
|---|---|---|---|---|
| file open time | "Files open instantly"; 4 KiB get 1.1 ms, 64 MiB get 47.2 ms, 256 MiB stream get 178 ms - [docs.spacefs.com/benchmarks](https://docs.spacefs.com/benchmarks/) checked 2026-09-30 | not yet measured; CI stand-in ratchet: `bench/baseline.json` row `file-open` | not yet measured | #242 |
| 5 GB video start time | streams byte ranges in real time, no 5 GB figure - [spacefs.com](https://spacefs.com) checked 2026-09-30 | not yet measured; CI stand-in ratchet: `bench/baseline.json` row `video-start` | not yet measured | #242 |
| cross-machine sync time | "every device connected to the same Space sees the new version within seconds", no figure - [spacefs.com](https://spacefs.com) checked 2026-09-30 | not yet measured for two real machines; a stand-in proof measured 5.0 s, both directions, on two mounts on one Linux host - measured 2026-09-30, commit fd0b6a8, repeat: `node --test test/two-mount-sync.test.mjs` | not yet measured | #121 |
| small-file speed (under 1 MiB) | put 4 KiB 60.6 ms, put 1 MiB 126 ms, get 1 MiB 8.3 ms - [docs.spacefs.com/benchmarks](https://docs.spacefs.com/benchmarks/) checked 2026-09-30 | not yet measured; CI stand-in ratchet: `bench/baseline.json` rows `small-file-put`, `small-file-get` | not yet measured | #242 |
| small edit in a big file | append 4 KiB to a 64 MiB file 111 ms - [docs.spacefs.com/benchmarks](https://docs.spacefs.com/benchmarks/) checked 2026-09-30 | not yet measured; CI stand-in ratchet: `bench/baseline.json` row `small-edit` | not yet measured | #97 |
| big-folder rename | move dir, 200 x 64 KiB, 99.0 ms - [docs.spacefs.com/benchmarks](https://docs.spacefs.com/benchmarks/) checked 2026-09-30 | not yet measured; CI stand-in ratchet: `bench/baseline.json` row `big-folder-rename` | not yet measured | #104 |
| bandwidth needed | recommends more than 300 Mbps down and 100 Mbps up - [spacefs.com](https://spacefs.com) FAQ checked 2026-09-30 | not yet measured | not yet measured | #242 |
| setup steps and time to first file | 6-step quickstart, about five minutes - [docs.spacefs.com/start/quickstart](https://docs.spacefs.com/start/quickstart/) checked 2026-09-30 | not yet measured (one `drive init` command ships; its time is unmeasured); CI stand-in ratchet: `bench/baseline.json` rows `mount-ready`, `cli-cold-start` | not yet measured | #105 |
| offline pinning | pin a file or folder and a complete copy stays until unpin - [spacefs.com](https://spacefs.com) FAQ checked 2026-09-30 | not yet measured (not built) | lose | #115 |
| version history | every change is a version, kept; `space history` lists every version - [spacefs.com](https://spacefs.com) and [docs.spacefs.com/start/mount](https://docs.spacefs.com/start/mount/) checked 2026-09-30 | not yet measured (30 days planned: 1 day on B2, then one a day) | lose | #9 |
| price at 100 GB | $15 a month billed yearly ($180 a year; the 1 TB plan is the smallest) - [spacefs.com](https://spacefs.com) checked 2026-09-30 | $1.00 a month - measured 2026-09-30, commit 9059239, repeat: `node --test test/scoreboard.test.mjs` | win | #23 |
| price at 500 GB | $15 a month billed yearly ($180 a year) - [spacefs.com](https://spacefs.com) checked 2026-09-30 | $9.00 a month - measured 2026-09-30, commit 9059239, repeat: `node --test test/scoreboard.test.mjs` | win | #23 |
| price at 1 TB | $15 a month billed yearly ($180 a year), about $20 month to month ("save 25%") - [spacefs.com](https://spacefs.com) checked 2026-09-30 | $11.00 a month - measured 2026-09-30, commit 9059239, repeat: `node --test test/scoreboard.test.mjs` | win | #23 |
| price at 2 TB | $27 a month billed yearly ($15 + 2 x $6 per extra 500 GB) - [spacefs.com](https://spacefs.com) checked 2026-09-30 | $15.00 a month - measured 2026-09-30, commit 9059239, repeat: `node --test test/scoreboard.test.mjs` | win | #23 |
| price at 5 TB | $63 a month billed yearly ($15 + 8 x $6 per extra 500 GB) - [spacefs.com](https://spacefs.com) checked 2026-09-30 | $39.00 a month - measured 2026-09-30, commit 9059239, repeat: `node --test test/scoreboard.test.mjs` | win | #23 |
| agent features: MCP setup | not published (Space documents an SDK, not MCP) - [docs.spacefs.com/agents](https://docs.spacefs.com/agents/) checked 2026-09-30 | one command per tool for claude, codex, cursor, gemini and kiro - shipped 2026-09-30, commit 73beb26, repeat: `go test ./cmd/drive` | win | #5 |
| agent features: no-delete keys | not published (keys are read, write or admin scoped, and write includes object deletes) - [docs.spacefs.com/start/access-keys](https://docs.spacefs.com/start/access-keys/) checked 2026-09-30 | an agent key carries list, read and write and can never carry delete - shipped 2026-09-30, commit ab97aa8, repeat: `node --test test/cap-keyprovider-table.test.mjs` | win | #55 |
| agent features: undo | keep every version and roll back any time - [docs.spacefs.com/guides/history-and-rollback](https://docs.spacefs.com/guides/history-and-rollback/) checked 2026-09-30 | not yet measured (not built) | lose | #13 |
| agent features: spending cap | "spending controls", no default or figure - [spacefs.com/changelog](https://spacefs.com/changelog/) checked 2026-09-30 | default $12; at the cap the write key is swapped read-only and nothing is deleted - shipped 2026-09-30, commit 7db1c3c, repeat: `node --test test/cap.test.mjs` | win | #64 |
| agent features: branches with review | fork a whole drive without copying a byte; no review step published - [spacefs.com](https://spacefs.com) and [docs.spacefs.com/guides/forks](https://docs.spacefs.com/guides/forks/) checked 2026-09-30 | not yet measured (not built) | lose | #8 |
| disk use | zero bytes on disk; caches only the parts an app asks for - [spacefs.com](https://spacefs.com) checked 2026-09-30 | not yet measured | not yet measured | #112 |
| minimum macOS | macOS Tahoe 26.4 or later - [spacefs.com](https://spacefs.com) FAQ checked 2026-09-30 | not yet measured | not yet measured | #116 |
| pause and resume an upload | not published - [spacefs.com](https://spacefs.com) checked 2026-09-30 | not yet measured | not yet measured | #100 |

## Rows with no issue yet

None. Every losing or unmeasured row names its issue.
