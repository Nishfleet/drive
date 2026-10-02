# Home-page demos: the three recorded runs

Every figure the home page prints comes from this file, and
`test/home-demos.test.mjs` is the gate: it re-runs the three demos against a
stock `rclone serve s3` stand-in and the product's own mount flags, and
fails CI when a measurement is missing or a budget is broken. A number is
written here only by a run that produced it; nothing is estimated.

- **Storage:** local rclone serve s3 stand-in
- **Date:** 2026-10-02
- **Commit:** 2ed957d925cc28b1e3fe14fc2aa4c04cddece228

| Demo | What was measured | Figure |
|---|---|---|
| `agent` | claude read brief.md and edited todo.md on the drive | 8.56 s |
| `video-first-frame` | 5.0 GB H.264 opened and its first frame decoded off the mount | 0.15 s |
| `video-scrub` | seeked to 1493s and decoded a frame from the same 5.0 GB file | 0.21 s |
| `blend-open` | a 0.4 MB .blend opened off the mount in a fresh Blender process | 0.50 s |
| `blend-save` | added a second object and saved back over the same file on the drive | 0.45 s |

Reproduce with `node --test test/home-demos.test.mjs`. A Mac run (a real
Finder window, Final Cut, a Finder-side scrub) is out of reach for a Linux
build machine and is listed on issue #113 as an open check, never
estimated here.
