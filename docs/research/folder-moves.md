# Research: moving and renaming folders through the mount

**Status: measured and resolved. The bars on this page are loopback-stand-in numbers against a local
MinIO, so they bound protocol and storage overhead, not a customer's line — they are not publishable
on the Benchmarks page (docs/benchmarks.md), which waits for real storage (issue #242). The one
limits-page sentence this issue asked for is written and is labelled as a stand-in figure. The
one-hour-minimum finding below is a billing change, so its numbers are exact and reproduced by a
test (test/meter.test.mjs, "a move adds no billed bytes").**

The competitor's edge, as recorded in the gap list (2026-09-30, internal, no public source): renaming a folder
of 200 files takes them 99.0 ms because nothing is copied. That figure is not comparable with anything
measured here — it is their network, their storage and their implementation, and this document never
reproduces it. What we can reproduce is our own move, end to end, and the one thing that decides
whether it is honest: whether the storage server copies the bytes or the user's machine does.

## What was decided — five points

1. **A move is a copy-then-delete, and the copy is the storage server's own.** Measured through the
   mount: renaming a 200-file folder does 200 server-side copies and zero uploads, and moving a
   10 GiB folder does 10 server-side copies and zero uploads. The mount's VFS cache is 28 KiB before
   the move and 28 KiB after it, so no file bytes crossed the machine. Nothing had to change for
   this: it is what stock rclone does with a mounted S3 remote, and the CI ratchet
   (`bench/baseline.json`, row `big-folder-rename`, mean 0.015 s) is what makes it a regression if a
   flag or a VFS change ever turns a move into an upload, because a re-upload of a 10 GiB folder
   would be tens of times slower than any band the ratchet allows.
2. **Nothing can make it instant on plain object storage, so we say so plainly.** S3 has no
   directory rename: the API surface is CopyObject per key plus DeleteObject per key, and the
   storage servers and mount layers we looked at all bottom out there (point 6 below). Our measured
   floor is about 0.6 s for 200 files and about 17 s for 10 GiB, and it is per-file request latency,
   not bytes: the 10 GiB folder moves at roughly 0.6 GiB/s of server-side copy. The limits page
   (docs-site/limits.md) already said rename and move are not free; it now carries the numbers.
3. **A move is byte-neutral in the meter, and a first-hour move no longer pays the minimum twice.**
   The storage server reports a move as a create at the new key and a hide at the old key at the same
   instant, so the meter sees two versions where the customer moved one file, and the 1-hour minimum
   is a per-version rule. A folder that has already been stored for an hour was already billed
   exactly its unmoved minutes (3,600 GB-minutes either way for 10 GB over six hours). A file moved
   inside its own first hour was not: it paid the minimum twice — 3,900 GB-minutes against the
   unmoved file's 3,600 — because the retired version's shortfall was booked on top of the
   successor's clock. The meter now books the minimum once per holding: a version that stopped at the
   instant a same-size successor began adds no shortfall of its own, because the successor bills
   those bytes from that instant (drive issue #104). test/meter.test.mjs pins both cases against the
   real migrations and the real rollup SQL, and the differential test now holds the waiver in both
   the SQL and its JS reference.
4. **No price change.** Storage is still billed by the GB-minute for what was held, a move neither
   adds nor removes a byte of holding, and the waiver above only removes a double charge that a move
   never should have paid. Nothing on the pricing page moves with this. *Proposal for Nish:* none is
   needed, because the rule change is a correction to the documented "1-hour minimum per file"
   (docs/spec.md's metering row) — the repo copy of the rule in docs/build-spec.md now states the
   exception, and the vault copy of that line needs the same edit (issue #89 owns the sync).
5. **What this does not fix.** A version that is replaced by a *different-sized* version (a save that
   changes the file's size) is not a handoff under this rule and still books its own minimum, and the
   hour's stored-byte mark still counts a version and its successor that never coexisted, so the
   month's peak can rise for the hour a move happens in. Both are outside this issue's text; the
   first is the same shape as the save case, the second is documented in HOUR_STORED_BYTES_SQL's own
   upper-bound note.

## Method

- Host: this VPS (Nishfleet worker sandbox), 2026-10-03, every row from one host, one stand-in and
  one rclone version. Linux 6.8 on Ubuntu 24.04, rclone v1.75.1 (the same build the repo pins in
  docs/research/delta-uploads.md), kernel FUSE used through `unshare -Urm` because the worker
  sandbox has no CAP_SYS_ADMIN (the same constraint that blocked the JuiceFS FUSE rows there).
- Stand-in: the pinned MinIO release step 1 chose (`bitnamilegacy/minio:2025.7.23-debian-12-r5`,
  issue #179) on `127.0.0.1:39090`, in a container over a named volume, one bucket
  (`fm-bucket`). Versioning left off: a move is a copy-then-delete either way, and an unversioned
  bucket keeps the object count a clean read of "the provider holds the same bytes before and
  after". `rclone serve s3` (the stand-in delta-uploads.md used) was not used here because its
  fake-S3 backend blows up on the multipart copy path.
- Mount: stock `rclone mount` with exactly the flags the product's mount passes — the values in
  cmd/drive/config.go and `VFSArgs()` in cmd/drive/mount.go (`--vfs-cache-mode full`, ...);
  the remote-control flags `--rc --rc-addr <loopback> --rc-no-auth` are added by
  `BuildMountPlan` (`cmd/drive/mount.go:263`) rather than `VFSArgs()`. A person's mount
  never sets a `DRIVE_BENCH_*` override, so none is set here.
- Files: 200 × 64 KiB (the competitor's published shape for its 99 ms, so the two counts are over the same
  number of files) and 10 × 1 GiB (a 10 GiB folder, the "10 GB folder" this issue names). Both are
  sparse local files of zeros — content is irrelevant, only the byte count is.
- "seconds" is the wall time of the `mv` through the mount, measured with `date +%s.%N` around it.
  "copied server-side" is rclone's own accounting, read from the mount's remote control
  (`rclone rc core/stats`) before and after the move, cross-checked against the mount's log line
  "Copied (server-side copy)" and against `rclone --stats` counts of uploads (zero in every run).
- The meter's numbers are not measured here; they are the shipped meter's own arithmetic, run
  against the real migration files in test/meter.test.mjs.

## Results

| # | Case | Runs | wall seconds | server-side copies | bytes re-uploaded | mount cache before → after |
|---|------|-----:|-------------:|-------------------:|------------------:|---------------------------|
| A | rename a 200-file folder (200 × 64 KiB = 13,107,200 B) | 5 | 0.45, 0.57, 0.57, 0.65, 0.72 (mean 0.59) | 200 | **0** | 28 KiB → 28 KiB |
| B | move a 10 GiB folder (10 × 1 GiB = 10,737,418,240 B) | 3 | 20.06, 16.87, 15.99 (mean 17.6) | 10 | **0** | 28 KiB → 28 KiB |

> Re-run on merged head (2026-10-03): rename mean 0.44 s (4 runs), move mean 19.2 s (2 runs).
> Same shape every time: 0 bytes re-uploaded, VFS cache flat at 28 KiB.

Readings worth quoting:

- **Every byte moved server-side, in both cases.** The stats after run A were
  `serverSideCopies: 200`, `serverSideCopyBytes: 13107200`, `bytes: 13107200`, `totalTransfers: 200`,
  `renames: 200`, `deletes: 200`; after run B, `serverSideCopies: 10`,
  `serverSideCopyBytes: 10737418240`, `totalTransfers: 10`, `renames: 10`, `deletes: 10`. rclone
  counts the bytes it *would* have sent as transferred when the copy is server-side, so `bytes`
  equals `serverSideCopyBytes` exactly; the line that decides it is the log's 200 (and 10)
  "Copied (server-side copy)" records with zero "Starting upload" lines, and a VFS cache that does
  not grow.
- **The bucket held the same bytes before and after both moves**: 210 objects, 10,750,525,440 B,
  `rclone size` before the pair and `rclone size` after. No second copy of the 10 GiB folder was
  left behind, because a move is a copy then a delete, and both runs completed.
- **The seconds are request latency, not throughput.** Run A's transfer time was 0.578 s for 400 S3
  calls (200 copies + 200 deletes) at about 1.4 ms a call; run B was 20 s for 20 calls on 1 GiB
  objects. A 200-file folder costs 200 copy round trips whatever the link speed, which is why
  moving the mount `--transfers` knob would shave a constant off a small rename and change nothing
  about the per-object floor.
- **The competitor's 99.0 ms is not reachable by tuning anything we ship.** It is their implementation of a
  folder rename on their storage model; ours is 200 CopyObject + 200 DeleteObject calls on S3. A
  *faster* move on this storage model would have to be a different storage model (point 6), which
  is product direction and not this issue's.
- **The CI ratchet is the gate on this.** `bench/baseline.json`'s `big-folder-rename` row is 0.015 s
  with a small band, on `TestMountSpeedHillClimb`'s 200-file rename. A change that made a move
  download and re-upload (a VFS cache-mode change, a flag that turns a move into a local copy) would
  put the row far outside that band and fail CI, which is the detector for this issue's bullet 2.

## The 1-hour minimum, measured as the meter's own numbers

10 GB at `/u/abc123/`, six closed hours rolled by the trigger's own `runMeterCron`, read back from
`usage_minutes`. Same events for the move in both orders (the upsert lands them on the same two
rows).

| Case | booked GB-minutes | against the unmoved file |
|---|---:|---:|
| the file never moves | 3,600 | — |
| moved at 02:00, after it has been stored for two hours | 3,600 | none added |
| moved at 00:30, inside the file's first hour | 3,900 before the fix, **3,600 after** | 300 before, none now |

The 300 GB-minutes of extra charge before the fix is the retired version's shortfall: 60 − 30 minutes
of its young life, at 10 GB. It is the smallest number in this document and the most important one,
because it is the difference between a customer moving a folder and a customer being billed for a
folder move as if the moved bytes were new storage.

One honest bound on the sentence the limits page draws from this: the first hour a young move lands in
still books the extra minutes, because the waiver is a `NOT EXISTS` on the successor row and that row
does not exist until the successor's create event is stored. The nightly reconciler finds the missing
create in the provider's own listing and rewinds the watermark, so the corrected number is what any
monthly bill is built from — which is what "a move never adds a byte to your bill" claims, and what
`test/meter.test.mjs`'s late-arrival case proves. The exception applies to a same-size save-replace too
(Nish's decision A, 2026-10-03), which is the same shape in `file_versions`; at most 60 minutes × the
size is waived per same-millisecond, same-size handoff.

## What I searched and did not adopt

- **A directory-rename primitive in S3, in B2's native API and in S3-compatible servers**: none of
  them has one. The S3 API surface for a move is CopyObject + DeleteObject per key (or the multipart
  UploadPartCopy for objects over the 5 GiB single-copy ceiling, which the same client code already
  uses for `drive branch` — measured for a 6 GB file in docs/build-spec.md's gap table). MinIO's own
  commands mirror that. Searched the S3 API reference and MinIO's implementation, 2026-10-03.
- **rclone's `server-side-across-configs` and `--s3-copy-cutoff`**: the first forces server-side
  copies between different remotes (ours is one remote, and this product never configures a second
  one), the second sets the multipart-copy threshold and is already above 5 GiB by default. Neither
  makes a move cheaper; both are already in the server-side state the measurements show.
- **Mountpoint for S3, s3fs-fuse, goofys**: their documented rename path is a server-side
  copy-then-delete per object too, and none of them is the mount this product ships (stock rclone is,
  by the spec's own stock-tools rule). Not measured here beyond their docs, because adopting one is
  a product decision, not a measurement result.
- **A hand-written batched rename in the `drive` CLI**: no batch rename exists to call, so the CLI
  would be re-implementing per-object copy-then-delete with no capability it does not already have.
- **JuiceFS's FUSE rename**: it moves metadata, not bytes, which is the shape we would want — and it
  needs a FUSE mount plus its own metadata store, which docs/research/delta-uploads.md already
  measured as a 2.0–2.06× storage cost and a loss of the plain-file model. Out for the same reasons.

## Re-running the measurements against merged head

Nothing is committed as a script: the commands below are pasted into a shell, the way
docs/research/delta-uploads.md's are. No `*.sh`, no `scripts/`. The credential is a throwaway
stand-in's; on a real remote it belongs in the 0600 rclone config (`--config`), never on a command
line, because `/proc/<pid>/cmdline` is world-readable for the life of the call.

```sh
# the stand-in (not 9090: that port is taken on this host)
mkdir -p /tmp/folder-moves-lab/data && cd /tmp/folder-moves-lab
docker run -d --name fm-minio --user 0 --network host \
  -e MINIO_ROOT_USER=drivefm -e MINIO_ROOT_PASSWORD=dummyfmdummyfm \
  -v fm-minio-data:/data \
  bitnamilegacy/minio:2025.7.23-debian-12-r5 server /data --address :39090
rclone config create fm s3 provider Minio endpoint http://127.0.0.1:39090 \
  access_key_id drivefm secret_access_key dummyfmdummyfm region us-east-1 \
  --config /tmp/folder-moves-lab/rclone.conf
rclone mkdir fm:fm-bucket --config /tmp/folder-moves-lab/rclone.conf

# the two fixtures: the competitor's 200 x 64 KiB, and a 10 GiB folder
mkdir -p src200 srcbig
for i in $(seq -w 0 199); do truncate -s 65536 "src200/file-$i.bin"; done
for i in $(seq -w 0 9); do truncate -s 1G "srcbig/file-$i.bin"; done
rclone copy src200 fm:fm-bucket/rename-200 --config /tmp/folder-moves-lab/rclone.conf --transfers 8
rclone copy srcbig fm:fm-bucket/big-10g  --config /tmp/folder-moves-lab/rclone.conf --transfers 8
rclone size fm:fm-bucket --config /tmp/folder-moves-lab/rclone.conf   # 210 objects, 10750525440 B
```

Every number above came from this block (run inside `unshare -Urm`, because the worker sandbox has no
CAP_SYS_ADMIN; the loops time each `mv` with `date +%s.%N` and print one line per run, and the bytes
are rclone's own accounting read from the mount's remote control). `bc` is what prints the mean.

```sh
unshare -Urm bash -c '
CONF=/tmp/folder-moves-lab/rclone.conf
mkdir -p /tmp/folder-moves-lab/mnt /tmp/folder-moves-lab/cache
# the product'"'"'s own mount: the flags cmd/drive/mount.go VFSArgs() passes, and only those
rclone mount fm:fm-bucket /tmp/folder-moves-lab/mnt --config "$CONF" \
  --vfs-cache-mode full --vfs-write-back 5s --vfs-cache-max-size 20G --dir-cache-time 5s \
  --vfs-read-chunk-size 128M --vfs-read-chunk-streams 2 --buffer-size 32M --transfers 4 \
  --vfs-read-ahead 128k --vfs-read-chunk-size-limit 1G --vfs-cache-max-age 24h \
  --rc --rc-addr 127.0.0.1:39199 --rc-no-auth \
  --cache-dir /tmp/folder-moves-lab/cache --log-file /tmp/folder-moves-lab/mount.log \
  --log-level INFO &
MPID=$!
for i in $(seq 1 100); do ls /tmp/folder-moves-lab/mnt >/dev/null 2>&1 && break; sleep 0.2; done
sleep 6   # the mount caches a folder for --dir-cache-time (5s); this is setup, not the measurement
du -sh /tmp/folder-moves-lab/cache
# the measurement: R runs of each rename, each timed with date +%s.%N, the mean printed
# at the end. Moving back and forth renames the same folder, so run 2..R is a real
# repeat, not a re-upload of a fresh fixture.
for r in $(seq 1 5); do
  s=$(date +%s.%N); mv /tmp/folder-moves-lab/mnt/rename-200 /tmp/folder-moves-lab/mnt/renamed-200
  e=$(date +%s.%N); echo "rename-200 run $r wall $(echo "$e - $s" | bc)"
  s=$(date +%s.%N); mv /tmp/folder-moves-lab/mnt/renamed-200 /tmp/folder-moves-lab/mnt/rename-200
  e=$(date +%s.%N); echo "  (moved back, $e - $s s, not counted)"
done
for r in $(seq 1 3); do
  s=$(date +%s.%N); mv /tmp/folder-moves-lab/mnt/big-10g /tmp/folder-moves-lab/mnt/moved-10g
  e=$(date +%s.%N); echo "move-10g run $r wall $(echo "$e - $s" | bc)"
  s=$(date +%s.%N); mv /tmp/folder-moves-lab/mnt/moved-10g /tmp/folder-moves-lab/mnt/big-10g
  e=$(date +%s.%N); echo "  (moved back, $e - $s s, not counted)"
done
du -sh /tmp/folder-moves-lab/cache
rclone rc --rc-addr 127.0.0.1:39199 core/stats | grep -E "serverSideCopies|bytes|transfers"
kill -TERM $MPID; fusermount3 -u /tmp/folder-moves-lab/mnt
'
# rclone counts server-side copy bytes as transferred, so the log line is the deciding evidence:
grep -c "Copied (server-side copy)" /tmp/folder-moves-lab/mount.log   # 200, then 10
grep -icE "Starting.*upload|Uploaded" /tmp/folder-moves-lab/mount.log # 0
# and the bucket held the same bytes before and after:
rclone size fm:fm-bucket --config /tmp/folder-moves-lab/rclone.conf
```

A second run against the same stand-in after main's merge (2026-10-03, `/tmp/folder-moves-verify`,
bucket `fm-verify-bucket`) confirmed the same shape:

```
rename-200 run 2-5 wall = 0.555, 0.449, 0.399, 0.353 (mean 0.44)
move-10g   run 2-3 wall = 21.24, 17.08 (mean 19.2)
serverSideCopies 200/10  serverSideCopyBytes 13107200 / 10737418240  totalTransfers 210  renames 210  deletes 210
grep -c "Copied (server-side copy)" mount.log   # 210
# 0.00 (any) upload lines
du -sk cache  # 28 KiB → 28 KiB
rclone size fm:fm-verify-bucket   # 210 objects / 10.012 GiB before and after
```

Re-run reason: `origin/main` advanced by 4 commits while this branch was open, and
`BuildMountPlan` now passes the remote-control flags rather than `VFSArgs()` (the rc address is
still loopback, and the VFS flags are unchanged). Nothing this issue ships changed the mount's
byte path.

The meter's numbers are the test, not a lab: `node --test test/meter.test.mjs` runs
"a move adds no billed bytes, and a move inside the file's first hour adds none either" against the
real migration files, so a change to the rollup SQL or to the minimum that reintroduces the double
charge fails there rather than in a bill.
