# Research: send only the changed bytes when a big file is saved

Space's strongest edge (gap list, 2026-09-30): a 4 KiB edit in a 64 MiB file takes them 111 ms
because only the touched piece is re-sent. Stock rclone re-uploads the whole file, so a 2 GB
Blender or Premiere project re-uploads 2 GB per save. This issue measures the engines against a
local `rclone serve s3` stand-in and picks one.

## Recommendation (first five lines)

1. **Ship v1 as-is: whole-file re-upload, best for files under about 1 GB.** Stock rclone sends
   67108864 B for a 4 KiB edit in a 64 MiB file in 0.73 s locally and 2147483648 B for a 1 MiB edit
   in a 2 GB file in 25.11 s on this VPS; on a customer's line that 2 GB save is minutes, so put a
   practical-size note on the limits page ("saves of files over about 1 GB re-send the whole file")
   and price nothing extra — a save is a new version the user is not billed for while hidden.
2. **Adopt after launch: the `drive` CLI doing multipart re-save with `UploadPartCopy` reuse of
   unchanged parts** (8 MiB parts: a 4 KiB edit sends 1 part + 7 part-copies, and the object in the
   bucket stays a plain, multipart-uploaded object any S3 client can read). The primitive is real
   and server-side on both ends of our plan: rclone's client calls `UploadPartCopy` for multipart
   copies (`backend/s3/s3.go:3164-3181` in v1.75.1), and B2's native API has the same operation as
   `b2_copy_part` ("Copies from an existing B2 file, storing it as a part of a large file which has
   already been started", backblaze.com/b2/docs/b2_copy_part.html). It could not be proven
   end-to-end here — see row D — so the first step after launch is a support check on the chosen
   primary (iDrive e2; unverified) plus a spike of the re-save in the CLI. rclone itself only ever
   uses part-copy to copy, never to re-save, so the re-save path is product logic in our own CLI —
   allowed by the repo rule "hand-write only the product's own logic: the drive CLI".
3. **Do not adopt the rclone chunker overlay.** Measured: it re-sends all chunks on a 4 KiB edit
   (134217728 B for 64 MiB) and replaces the plain file in the bucket with a 79-byte metadata object
   plus 8 chunk objects — the selling point (a customer can read their files without us) is lost.
4. **Do not adopt JuiceFS for the v1 bucket.** Its block-level write path needs a FUSE mount and a
   metadata database (no FUSE in this worker sandbox: `fusermount3: mount failed: Operation not
   permitted`, so only its S3 gateway path was measured — a whole-object PUT, which re-sent all
   67108864 B and left 2.15× the logical bytes in the bucket until GC). It also moves the file out
   of the plain-file model, and its restore story bypasses provider versioning.
5. **Say on the pricing page: nothing changes.** Uploads are not billed to the user (downloads are),
   and delta saves do not change GB-minutes materially; the limits page gets the "over about 1 GB"
   save note. What we gain after launch is save speed only — the Space comparison line ("saves of
   big files don't re-send what didn't change") waits for the UploadPartCopy re-save to ship.

## Method

- Host: this VPS (Nishfleet worker sandbox), 2026-09-30. Stand-in bucket: `rclone serve s3` on
  `127.0.0.1:39090` over a local directory (loopback, ~1.3 GB/s single PUT), so **seconds measure
  protocol + local throughput, not a customer's internet line**; bytes are exact.
- Files: 64 MiB random (`film.mov`, sha256 `97e7f607bc5a5c2a…`) and 2 GB random (`big.blend`).
- Edit A: 4096 B overwritten at offset 32 MiB (seek 8192 × 4096). Edit B: 1 MiB at offset 256 MiB.
- "bytes sent" is the client's own rclone accounting (`stats.bytes`, the last non-zero stats line);
  "stored" is `du -sb` of the backing directory.
- Version: rclone v1.75.1 (MIT, pushed 2026-09-30), JuiceFS v1.4.1 (Apache-2.0, pushed 2026-09-29).
- No helper scripts: every command below is a one-liner a shell can repeat.

```sh
rclone serve s3 --addr 127.0.0.1:39090 --auth-key drive,testsecret123 /tmp/delta-lab/bucket \
  --log-file /tmp/delta-lab/s3.log --log-level INFO
rclone config create lab s3 provider Other endpoint http://127.0.0.1:39090 \
  access_key_id drive secret_access_key testsecret123
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
| B4 | rclone chunker (8 MiB) | 1 MiB edit in 2 GB | **4294967296 (all 256 chunks again)** | 38.17 | 266 objects, 2214592672 B stored |
| C1 | JuiceFS gateway | first upload 64 MiB | 67108864 | 0.58 | `chunks/0/0/<slice>_<idx>_<size>` blocks |
| C3 | JuiceFS gateway | 4 KiB edit in 64 MiB | **67108864** (whole object) | 0.42 | 32 blocks of 4194304 B = **2× logical bytes** until GC |
| C4 | JuiceFS gateway | 1 MiB edit in 2 GB | **2147483648** | 18.62 | 1673 chunk objects, 4429188850 B stored for 2064 MiB logical |
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
  to `6_*` and the old slice stays until garbage collection, so one rewrite doubles what the bucket
  holds. The FUSE path — where only the touched 4 MiB block is re-sent — is the engine's whole
  point, and it is the path this sandbox could not measure.

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
| JuiceFS | **no** — `chunks/0/0/…` blocks + a metadata DB (sqlite/redis/postgres per volume) | provider versioning never sees "the file"; rollback is a metadata operation | the user's S3 key reads noise; the volume is all-or-nothing per metadata DB | blocks linger ~2× logical until `juicefs gc`; we absorb the gap | restore means metadata rollback, not B2 version id — the reconciler and `file_versions` model break |
| UploadPartCopy re-save (recommendation 2) | **yes** — a multipart-uploaded object is a plain object to every reader | unchanged: each save is a new version | unchanged | unchanged | unchanged |

## Licence and maintenance health

- **rclone** (baseline + chunker): MIT, 60025 stars, last push 2026-09-30. Chunker is in-tree, no
  extra dependency.
- **JuiceFS**: Apache-2.0 (community edition), 14487 stars, last push 2026-09-29, v1.4.1. Active and
  healthy — the costs are operational (a metadata DB per volume, a GC job for stale blocks, a mount
  on every client), not licence ones.
- **S3 multipart + `UploadPartCopy`**: a standard S3 API, implemented by rclone's own backend
  (`copyMultipart` → `UploadPartCopyInput`) and by the B2 S3-compatible API for large files. No new
  licence, no new vendor.

## Repeating the measurements

Every number above came from one of these one-liners on the VPS (stand-in up, config as in Method);
`m()` prints the client's last non-zero stats line and the wall seconds:

```sh
m(){ local tag=$1; start=$(date +%s.%N); rclone copyto "$2" "$3" --config rclone.conf \
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
# A: rclone as-is
m A1 a.mov lab:lab/film.mov
dd if=/dev/urandom of=a.mov bs=4096 count=1 seek=8192 conv=notrunc status=none; m A3 a.mov lab:lab/film.mov
dd if=/dev/urandom of=a.blend bs=1M count=1 seek=256 conv=notrunc status=none; m A4 a.blend lab:lab/big.blend
# B: chunker
rclone config create labchunk chunker remote=lab:lab/chunked chunk_size=8M
m B1 b.mov labchunk:film.mov
dd if=/dev/urandom of=b.mov bs=4096 count=1 seek=8192 conv=notrunc status=none; m B3 b.mov labchunk:film.mov
# C: JuiceFS (gateway; FUSE unavailable here)
juicefs format --storage s3 --bucket http://127.0.0.1:39090/lab --access-key drive \
  --secret-key testsecret123 sqlite3:///tmp/delta-lab/jfs.db jfslab
MINIO_ROOT_USER=drivew MINIO_ROOT_PASSWORD=gwsecret456 \
  juicefs gateway --no-banner --no-usage-report sqlite3:///tmp/delta-lab/jfs.db 127.0.0.1:39092
m C1 d.mov gw:jfslab/film.mov
dd if=/dev/urandom of=d.mov bs=4096 count=1 seek=8192 conv=notrunc status=none; m C3 d.mov gw:jfslab/film.mov
# D: the multipart copy primitive rclone already proves
rclone copyto lab:lab/big.blend lab:lab/big-copy.blend --s3-copy-cutoff 50M -vv
#   -> "DEBUG : big.blend: Starting  multipart copy with 41 parts" then panic (see row D);
#      run it against the real provider instead
rclone copyto b2.blend labchunk:big.blend --config rclone.conf   # chunker 2 GB, 8 MiB chunks
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
