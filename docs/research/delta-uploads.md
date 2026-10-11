# Research: send only the changed bytes when a big file is saved

**Status: research and recommendation. Every price, limits-page and the competitor-comparison line below is a
proposal for Nish, not a decision — those are reserved classes.**

The competitor's edge, as recorded in the gap list (2026-09-30, internal, no public source): a 4 KiB edit in a
64 MiB file takes them 111 ms because only the touched piece is re-sent. That figure is not
comparable with anything measured here — it is somebody else's network, and this document never
reproduces it. What we can reproduce is the byte count, and stock rclone re-sends the whole file,
so a 2 GB Blender or Premiere project re-uploads 2 GB per save. This issue measures the engines
against a local `rclone serve s3` stand-in and names the one to adopt after launch.

## Recommendation — six points, all proposals

1. **Ship v1 as-is: whole-file re-upload.** Measured here: 67108864 B for a 4 KiB edit in a 64 MiB
   file (0.73 s loopback) and 2147483648 B for a 1 MiB edit in a 2 GB file (25.11 s loopback). Bytes
   are the number that matters and they are exact; seconds are loopback, so they bound protocol
   overhead, not a customer's line. The **"best under about 1 GB" wording is an interpolation, not a
   measurement** — we measured 64 MiB and 2 GB and nothing between, so the threshold comes from the
   2 GB row (25 s here becomes minutes on any real uplink), not from a tested curve.
   *Proposal for Nish:* a limits-page line saying saves re-send the whole file, and no price change
   (uploads are not billed to the user; a hidden version is ours to absorb — see the guarantees
   table).
2. **Adopt after launch: multipart re-save with `UploadPartCopy` reuse of unchanged parts**, done in
   the `drive` CLI (the repo allows hand-writing "the drive CLI"; no new engine). With 8 MiB parts a
   4 KiB edit in a 64 MiB file sends 1 new part and 7 part-copies, and the object in the bucket
   stays a plain multipart object any S3 client can read. The primitive is real and server-side:
   rclone's own client calls `UploadPartCopy` for multipart copies (`backend/s3/s3.go:3164-3181`,
   v1.75.1) and B2's native API has the same operation as `b2_copy_part` ("Copies from an existing
   B2 file, storing it as a part of a large file which has already been started with
   b2_start_large_file", backblaze.com/b2/docs/b2_copy_part.html, fetched 2026-09-30). It could not
   be proven end-to-end here — see row D — so the first step is a capability check plus a spike,
   with the bounds and the fallback spelled out in point 6 below.
3. **Do not adopt the rclone chunker overlay.** Measured: a 4 KiB edit re-sends every chunk, and the
   plain file in the bucket becomes a 79-byte metadata object plus one object per chunk — the
   selling point (a customer can read their files without us) is lost.
4. **Do not adopt JuiceFS for the v1 bucket.** Its block-level write path needs a FUSE mount and a
   metadata database per volume; no FUSE in this worker sandbox
   (`fusermount3: mount failed: Operation not permitted`), so only its S3 gateway path was measured,
   and that path re-sent the whole object and left 2.06× the file's bytes in the bucket until GC. It
   also moves files out of the plain-file model and its restore story bypasses provider versioning.
5. **No pricing change is needed for either path** — a save is a new version, billed to the user
   only while it is the live one, and delta saves do not change GB-minutes materially. *Proposal for
   Nish:* the competitor comparison line ("saves of big files don't re-send what didn't change") waits
   until the re-save actually ships, and the limits page gets the whole-file note from point 1.
6. **What the re-save must handle before it is worth shipping** (from the design, not measured):
   S3 parts have a 5 MiB floor and a 10 000-part cap, so 8 MiB parts cover files up to ~78 GiB and
   anything larger needs a bigger part size or the plain path; the unchanged parts must be copied
   from the *previous version* of the key (`UploadPartCopy` takes a source key + range, and a B2
   version is the natural source), which this document did not measure; if the provider lacks the
   operation the CLI must fall back to a plain whole-file PUT, which is today's behaviour; and each
   re-save becomes several COPY/PUT requests plus multipart init and complete, which is a request
   count to watch rather than a byte-count problem.

## Method

- Host: this VPS (Nishfleet worker sandbox), 2026-09-30, all rows from **one** host and **one**
  stand-in. `rclone serve s3` on `127.0.0.1:39090` over a local directory, loopback throughput
  ~1.3 GB/s for a single PUT, so **seconds measure protocol plus local disk, not a customer's
  internet line**; bytes are exact. Rows A3 and A1 send identical bytes and differ by 0.06 s — warm
  page cache, noise, not a difference.
- Files: 64 MiB and 2 GB of `/dev/urandom`. No digest is quoted for them: random content is
  unreproducible by design, and nothing measured here depends on content — only sizes and offsets do.
- Edit A: 4096 B overwritten at offset 32 MiB (`bs=4096 count=1 seek=8192 conv=notrunc`). Edit B:
  1 MiB at offset 256 MiB (`bs=1M count=1 seek=256 conv=notrunc`).
- "bytes sent" is the client rclone's own accounting (`stats.bytes` on the last non-zero stats
  line); "stored" is `du -sb` of the backing directory. The counter is one client implementation,
  so compare rows with the same client (A and C, both plain `rclone copyto`) and treat the chunker
  rows' doubled total as its own behaviour (footnoted below).
- Version: rclone v1.75.1 (MIT, pushed 2026-09-30), JuiceFS v1.4.1 (Apache-2.0, pushed 2026-09-29).
- Nothing is committed as a script. The commands are pasted into a shell (a small shell function and
  a one-line `python3 -c` reader of rclone's JSON stats), which is not the repo's helper-script
  ban: no `*.sh`, no `scripts/`, nothing executable added to the tree.
- **The recipe block was re-run end to end after the review that flagged it, and it reproduced every
  row's bytes exactly** (67108864 / 2147483648 / 134217728 / 4294967296 / 67108864 / 2147483648 B).
  The seconds differ between runs by up to ~0.3 s on the small rows and ~1 s on the 2 GB rows —
  loopback timing on a shared VPS — so treat the seconds as ±5% and the bytes as exact. The table
  keeps the first run's seconds; the second run's are in the same range.

All keys below are **dummy values for a loopback stand-in with no data worth hiding** — the bucket
holds random bytes and is deleted after the run. They are in the commands so the recipes copy-paste,
and none of them is a real credential; in any real use the key belongs in the 0600 rclone config
file (`--config`) rather than on a command line, because `/proc/<pid>/cmdline` is world-readable.

```sh
cd /tmp && mkdir -p delta-lab && cd delta-lab && mkdir -p bucket/lab data
# stand-in: 127.0.0.1:39090 (not 9090: that port is taken on this host)
rclone serve s3 --addr 127.0.0.1:39090 --auth-key drive,dummydummydummy /tmp/delta-lab/bucket \
  --log-file /tmp/delta-lab/s3.log --log-level INFO &
# every rclone call below names the same --config, or the remotes land in ~/.config/rclone and
# the measured runs fail with "bytes_sent: None" (they did, once, in this document's own history)
rclone config create lab s3 provider Other endpoint http://127.0.0.1:39090 \
  access_key_id drive secret_access_key dummydummydummy --config /tmp/delta-lab/rclone.conf
dd if=/dev/urandom of=data/film.mov bs=1M count=64
dd if=/dev/urandom of=data/big.blend bs=1M count=2048
```

## Results

| # | Engine | Case | bytes sent | seconds | bucket after |
|---|--------|------|-----------:|--------:|--------------|
| A1 | rclone as-is | first upload 64 MiB | 67108864 | 0.79 | 1 object, plain file |
| A3 | rclone as-is | 4 KiB edit in 64 MiB | **67108864** | **0.73** | 1 object, plain file |
| A4 | rclone as-is | 1 MiB edit in 2 GB | **2147483648** | **25.11** | 1 object, plain file |
| B1 | rclone chunker (8 MiB) | first upload 64 MiB | 134217728 (2×) | 1.63 | 9 objects: `film.mov` = 79-byte meta + 8 chunks |
| B3 | rclone chunker (8 MiB) | 4 KiB edit in 64 MiB | **134217728 (all chunks again)** | 1.28 | same 9-object layout |
| B2 | rclone chunker (8 MiB) | first upload 2 GB | 4294967296 (2×) | 39.23 | 257 transfers (256 chunks + meta) |
| B4 | rclone chunker (8 MiB) | 1 MiB edit in 2 GB | **4294967296 (all 256 chunks again)** | 38.17 | 266 objects for 256 chunks + 1 meta = 9 objects of residue (temp puts / the previous run's leftovers), 2214592672 B stored |
| C1 | JuiceFS gateway | first upload 64 MiB | 67108864 | 0.58 | `chunks/0/0/<slice>_<idx>_<size>` blocks |
| C3 | JuiceFS gateway | 4 KiB edit in 64 MiB | **67108864** (whole object) | 0.42 | 32 blocks × 4194304 B = 134221518 B stored for a 64 MiB file (**2.0×**) until GC |
| C4 | JuiceFS gateway | 1 MiB edit in 2 GB | **2147483648** | 18.62 | 1673 chunk objects, 4429188850 B stored for a 2048 MiB file (**2.06×**) until GC |
| D  | multipart `UploadPartCopy` | server-side copy 2 GB, `--s3-copy-cutoff 50M` | **failed** | — | no object; see below |

Readings worth quoting:

- The chunker's extra send is real churn, not accounting noise: each chunk is first PUT under a
  `.rclone_temp_put_<uuid>` key and then moved to its final `film.mov.rclone_chunk.NNN` key, and the
  client reports `serverSideCopies: 2` even for the 4 MiB test file. The exact reason the client
  counts twice the file was not chased further; `no_hash=true` changes nothing (134217728 B,
  9 transfers again), and the 2 GB rows show the same 2× (4294967296 B, 257 transfers).
- **Row D failed, and that itself is the finding.** `rclone copyto --s3-copy-cutoff 50M` against
  the stand-in logs `Starting multipart copy with 41 parts` and then **panics**, exit 2:
  `panic: runtime error: invalid memory address or nil pointer dereference` at
  `backend/s3/s3.go:3181` (`copyMultipart.func3`, dereferencing `uout.CopyPartResult`). Cause: the
  stand-in is `rclone serve s3`, and its fake-S3 backend implements only plain `UploadPart`
  (`cmd/serve/s3/multipart.go:190`, v1.75.1) — no `UploadPartCopy` — so rclone's client gets no
  result and dereferences nil instead of erroring cleanly. So the primitive is proven in rclone's
  client source and in B2's native API, not against this stand-in; re-verify against a provider that
  implements it (B2 does; iDrive e2 unverified).
- JuiceFS through the gateway (no FUSE here) rewrote the whole object: block ids go from slice `5_*`
  to `6_*` and the old slice stays until garbage collection, so a 64 MiB rewrite leaves 134221518 B
  (2.0×) and a 2 GB rewrite leaves 4429188850 B (2.06×) in the bucket. The FUSE path — where only
  the touched 4 MiB block is re-sent — is the engine's whole point, and it is the path this sandbox
  could not measure.
- **Row D proves less than recommendation 2 needs, and one thing it cannot prove at all.** It is a
  key-to-key copy; the recommendation is a *same-key* re-save across versions, where the unchanged
  parts come from the previous version of that key. Nothing here measured that, and nothing here
  measured a provider that supports `UploadPartCopy` — the stand-in does not. The panic is also an
  rclone client bug worth reporting upstream (it should fail cleanly when the server lacks the
  operation, not dereference nil), not a reason to avoid the operation.

## Not run

- **JuiceFS FUSE-mount in-place edit** (both edit sizes): blocked by the worker sandbox —
  `fusermount3: mount failed: Operation not permitted` (no CAP_SYS_ADMIN; `/etc/fuse.conf` also
  lacks `user_allow_other`). Re-run on a host with FUSE before relying on any number for it.
- **rsync delta**: no stock path from rsync to an S3 bucket. rsync's delta algorithm needs the
  rsync wire protocol on the far end; `rclone serve sftp` speaks SFTP, not rsync, and `rclone mount`
  (the usual carrier) is FUSE, blocked here. Not measured; not a candidate.
- **s3fs-fuse / goofys / AWS mountpoint-s3**: same FUSE blocker, and all three are whole-file on
  write anyway. Not installed, not measured.
- **aws cli / s5cmd / boto3 part-reuse**: none of the stock CLIs compose "copy unchanged parts from
  the previous version, upload the rest" (aws cli not installed; boto3 1.34.46 present but a
  hand-rolled part-reuse client is product code, not a stock engine — see recommendation 2).
- **rclone chunker at its default 2 GiB chunk size**: a 2 GB file is one chunk, so the default is a
  passthrough (the file stays plain); splitting only starts above the chunk size. Not measured at
  the default because the 8 MiB rows above already show what splitting buys (nothing).
- **`rclone serve s3` as a delta stand-in**: cannot prove `UploadPartCopy` (no such handler in
  v1.75.1) and a multipart copy panics; use a provider that implements it, or a real S3 provider.

## What each engine does to the product's guarantees

| | plain file in bucket | old versions (B2 + Hetzner) | per-user scoped keys | meter (GB-minutes) | `drive restore` |
|---|---|---|---|---|---|
| rclone as-is | yes — one object per file | every save is a new version; lifecycle hides it after 1 day, Hetzner keeps 30 | key limited to `/u/<id>/` works unchanged | counts both versions until hidden; hidden ones are ours to absorb | version id = object version; restores cleanly |
| rclone chunker | **no** — a meta object + chunk objects; a stock S3/rclone read of `film.mov` returns the 79-byte meta, not the file | chunk objects each get versions; 8× the hidden keys per save | works (still S3 keys) but users see 9 keys where they expect 1 | counts chunk versions; hidden-chunk lifecycle must be separate from the file's | a version restore has to replay the meta + 8 chunk objects through the chunker — not a single GET |
| JuiceFS | **no** — `chunks/0/0/…` blocks + a metadata DB (sqlite/redis/postgres per volume) | provider versioning never sees "the file"; rollback is a metadata operation | the user's S3 key reads noise; the volume is all-or-nothing per metadata DB | blocks linger 2.0–2.06× measured until `juicefs gc`; we absorb the gap | restore means metadata rollback, not B2 version id — the reconciler and `file_versions` model break |
| UploadPartCopy re-save (recommendation 2) | **yes** — a multipart-uploaded object is a plain object to every reader | unchanged: each save is a new version | unchanged | unchanged GB-minutes, but **more requests per save** (1 part PUT + 7 `UploadPartCopy` + init/complete instead of 1 PUT); S3 providers bill COPY requests and some bill unfinished multipart uploads, which the meter does not see today | unchanged |

## Licence and maintenance health

- **rclone** (baseline + chunker): MIT, 60025 stars, last push 2026-09-30. Chunker is in-tree, no
  extra dependency.
- **JuiceFS**: Apache-2.0 (community edition), 14487 stars, last push 2026-09-29, v1.4.1. Active and
  healthy — the costs are operational (a metadata DB per volume, a GC job for stale blocks, a mount
  on every client), not licence ones.
- **S3 multipart + `UploadPartCopy`**: a standard S3 API, implemented by rclone's own backend
  (`copyMultipart` → `UploadPartCopyInput`, `backend/s3/s3.go:3164-3181`, v1.75.1). **B2's
  S3-compatible API support for `UploadPartCopy` was not confirmed**: the S3 compatibility page
  (backblaze.com/b2/docs/s3_compatible_api.html, fetched 2026-09-30) does not name it, so the citable
  evidence is B2's *native* `b2_copy_part`; confirm the S3 spelling against the chosen provider
  before building on it. iDrive e2 likewise unverified. No new licence, no new vendor either way.

## Repeating the measurements

Every number above came from the block below. It builds the fixtures the recipe then edits — the
earlier draft of this section referenced `a.mov`/`b.mov`/`d.mov` that the recipe never created, so
those rows were not actually reproducible; this block is the fixed one. The helper is a pasted
shell function plus a one-line `python3 -c` reader of rclone's JSON stats (no committed script);
`m()` prints the client's last non-zero stats line and the wall seconds.

```sh
CONF=/tmp/delta-lab/rclone.conf
m(){ local tag=$1; start=$(date +%s.%N); rclone copyto "$2" "$3" --config "$CONF" \
      --use-json-log --stats=1ms -v 2>&1 | python3 -c "
import json,sys
best=None
for l in sys.stdin:
    try: o=json.loads(l)
    except: continue
    s=o.get('stats')
    if s and s.get('totalTransfers'): best=s
print('bytes_sent:',best['bytes'] if best else None,'transfers:',best['totalTransfers'] if best else None)
"; end=$(date +%s.%N); echo "${tag}_seconds=$(python3 -c "print(f'{$end-$start:.2f}')")"; }

# fixtures: copies of the two files built in Method, one per engine so edits do not leak across rows
cp data/film.mov a.mov; cp data/film.mov b.mov; cp data/film.mov d.mov
cp data/big.blend a.blend; cp data/big.blend b2.blend; cp data/big.blend d.blend

# A: rclone as-is
m A1 a.mov lab:lab/film.mov
dd if=/dev/urandom of=a.mov bs=4096 count=1 seek=8192 conv=notrunc status=none; m A3 a.mov lab:lab/film.mov
m A2 a.blend lab:lab/big.blend
dd if=/dev/urandom of=a.blend bs=1M count=1 seek=256 conv=notrunc status=none; m A4 a.blend lab:lab/big.blend

# B: chunker (8 MiB)
rclone config create labchunk chunker remote=lab:lab/chunked chunk_size=8M --config "$CONF"
m B1 b.mov labchunk:film.mov
dd if=/dev/urandom of=b.mov bs=4096 count=1 seek=8192 conv=notrunc status=none; m B3 b.mov labchunk:film.mov
m B2 b2.blend labchunk:big.blend
dd if=/dev/urandom of=b2.blend bs=1M count=1 seek=256 conv=notrunc status=none; m B4 b2.blend labchunk:big.blend

# C: JuiceFS gateway (FUSE unavailable in the sandbox; see Not run)
juicefs format --storage s3 --bucket http://127.0.0.1:39090/lab --access-key drive \
  --secret-key dummydummydummy sqlite3:///tmp/delta-lab/jfs.db jfslab
MINIO_ROOT_USER=drivew MINIO_ROOT_PASSWORD=dummydummydummy \
  juicefs gateway --no-banner --no-usage-report sqlite3:///tmp/delta-lab/jfs.db 127.0.0.1:39092 &
rclone config create gw s3 provider Other endpoint http://127.0.0.1:39092 \
  access_key_id drivew secret_access_key dummydummydummy --config "$CONF"
m C1 d.mov gw:jfslab/film.mov
dd if=/dev/urandom of=d.mov bs=4096 count=1 seek=8192 conv=notrunc status=none; m C3 d.mov gw:jfslab/film.mov
m C2 d.blend gw:jfslab/big.blend
dd if=/dev/urandom of=d.blend bs=1M count=1 seek=256 conv=notrunc status=none; m C4 d.blend gw:jfslab/big.blend

# D: the multipart copy primitive, against the stand-in (panics; see row D)
rclone copyto lab:lab/big.blend lab:lab/big-copy.blend --config "$CONF" --s3-copy-cutoff 50M -vv
#   -> "DEBUG : big.blend: Starting  multipart copy with 41 parts" then panic; run it against a
#      provider that implements UploadPartCopy instead
```

## What I searched and did not adopt

- `rclone chunker` overlay (measured above), `rclone --s3-copy-cutoff` multipart copy (measured),
  `rclone mount`/`nfsmount` write paths (documented whole-file; FUSE blocked here).
- `juicefs` mount + gateway (measured gateway), `juicefs sync` (whole-file copy semantics).
- GitHub repo search "delta upload s3 blocks" (top hits irrelevant: playlist mirrors), aws cli and
  s5cmd docs for part reuse (no such subcommand; `aws s3api upload-part-copy` is the bare primitive
  our recommendation 2 would use), boto3 presence on this host (1.34.46, unused — product code, not
  a stock engine).
- rclone v1.75.1 source (`backend/s3/s3.go` copyMultipart, `cmd/serve/s3/multipart.go`) and the B2
  API docs (`b2_copy_part`) to place the part-copy primitive exactly.
- Backup/dedupe engines (restic, borg, kopia): content-defined chunking with own manifests — not a
  customer-readable plain file in the bucket, and not a mount; out.
- SeaweedFS, Garage: self-hosted storage servers replacing the bucket, not a layer on the customer's
  B2 bucket; out of scope for this issue.
