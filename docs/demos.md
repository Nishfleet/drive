# Home-page demos: the three recorded runs

Every figure the home page prints comes from this file, and
`test/home-demos.test.mjs` is the gate: it re-runs the three demos against a
stock `rclone serve s3` stand-in and the product's own mount flags, and
fails CI when a measurement is missing or a budget is broken. A number is
written here only by a run that produced it; nothing is estimated.

- **Storage:** local rclone serve s3 stand-in
- **Date:** 2026-10-02
- **Commit:** a499071bcf5e0456a0e22a22bcc451d62af2a4cb

| Demo | What was measured | Figure |
|---|---|---|
| `agent` | claude read brief.md and edited todo.md on the drive | 8.47 s |
| `video-first-frame` | 5.0 GB H.264 opened and its first frame decoded off the mount | 0.16 s |
| `video-scrub` | seeked to 1493s and decoded a frame from the same 5.0 GB file | 0.26 s |
| `blend-open` | a 0.4 MB .blend opened off the mount in a fresh Blender process | 0.48 s |
| `blend-save` | added a second object and saved back over the same file on the drive | 0.49 s |

Reproduce with `node --test test/home-demos.test.mjs`. A Mac run (a real
Finder window, Final Cut, a Finder-side scrub) is out of reach for a Linux
build machine and is listed on issue #113 as an open check, never
estimated here.
