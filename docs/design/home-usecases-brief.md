# Home-page use-case section — design brief

## Why
The home page says "A Finder drive for people and their agents" but
shows no real proof. The section below the price strip answers "work
on a real drive" with three jobs that actually ran on the drive,
each with the command that ran it and the figure the run measured.

## Section order and composition
1. **Heading + lede** — names the business ("Real work on the drive")
   and the proof architecture (command + figure, one row per job).
2. **Three rows**, each row has: a job name (h3), the monospace command
   that produced the figure, and the measured figure (tabular-nums,
   accent color). Rows differ intentionally (agent = one line + turn;
   video = two commands + two figures; 3D = one command + open/save) —
   no equal repeated card grid.
3. **Caveat footer** — source of the figures, the stand-in label, the
   date, and the open checks (iDrive e2 real storage #173; Mac-side
   Finder/Final Cut).

## Above-fold
Unchanged: the price strip stays first. The section is a scroll section
— below the price, not a replacement.

## Typography rhythm
Same as the page: serif display for h2, sans for h3, mono for
commands (var(--mono)), tabular-nums figures. Sizes scale with `clamp`.

## Accent
One accent: `--accent` (#1f3a5f) for figures and the command prompt —
the same accent the page already uses.

## Proof architecture
Figures are produced by `test/home-demos.test.mjs` (each demo runs once,
asserted against the bytes the mount returned) and committed in
`docs/demos.md`. `test/home-demos.test.mjs` also reads the page and
fails CI if a figure on the page has no matching run row. Nothing is
estimated; a run that produces nothing writes nothing.

## Mobile behavior
The page links `public/site.css` first (site-styles gate). The section
uses one column on narrow viewports; no horizontal scroll at 360 px
or 1440 px (verified against `.demos`), console-error-free.

## Contrast
Body text on `--paper` (#faf6ee): ink-soft 7.29:1, ink 15.13:1, accent
10.65:1 — all pass AA for normal and large text.

## Audit (the section, re-measured on the committed page)

Headless Chrome on `public/` served over `http://127.0.0.1`, because the
page links `/site.css` as a real stylesheet and a `file://` load 404s it.
Viewport 1440x900 and 360x780, device scale 2.

| Check | Result |
|---|---|
| Desktop 1440x900 | `scrollWidth == clientWidth == body.scrollWidth == 1440`, 0 elements past the viewport, 0 console errors (the only 404 is the browser's own `/favicon.ico`, which the page does not reference) |
| Phone 360x780 | `scrollWidth == clientWidth == body.scrollWidth == 360`, 0 elements past the viewport, 0 console errors |
| Contrast, every text node in `.demos`, WCAG AA | h2 15.13 (3.0 needed), lede 7.29, job name 15.13, command 7.29, prompt `$` 10.65, figures 10.65 (3.0 needed), figure units 7.29, caveat 7.29 — all pass |
| Screenshots | `home-demos-desktop.png`, `home-demos-phone-360.png` |

## Second audit, 2026-10-02 (re-shot after the record was re-measured)

The three demos were run again on this host and produced new figures
(`agent` 9.01 s, `video-first-frame` 0.26 s, `video-scrub` 0.37 s,
`blend-open` 0.48 s, `blend-save` 0.51 s, recorded in `docs/demos.md`), so
the page was updated from the record and the two screenshots were shot
again against it. Headless Chrome on `public/` served over
`http://127.0.0.1:4599`, same viewports and device scale as above.

| Check | Result |
|---|---|
| Desktop 1440x900 | `scrollWidth == clientWidth == 1440`, 0 elements in `.demos` past the viewport |
| Phone 360x780 | `scrollWidth == clientWidth == 360`, 0 elements in `.demos` past the viewport; the section is 1261 px tall, so it scrolls vertically and never horizontally |
| Console errors | 0 from the page: the single 404 is the browser's own `favicon.ico` request, which the page does not reference |
| Figures in the shot | the `.demos` text read back from the rendered page is the same five figures `docs/demos.md` carries, and each is `font-variant-numeric: tabular-nums` in `--accent` (rgb(31, 58, 95)) |
| Console errors | the single 404 is the browser's own `favicon.ico` request, which the page does not reference |
| Contrast | unchanged: this run changed no colour, only the figures, so the table above still stands |

## Open checks (not faked)
- Cache state: the video figures are reads served by the mount's own VFS
  cache, because the demo writes the file and reads it back through the same
  mount (the same path a Finder window takes). A cold-read first frame needs a
  second mount with a fresh cache dir and a re-run, and is listed here rather
  than claimed.
- Real iDrive e2 storage (#173): the numbers above are measured on the
  local rclone serve s3 stand-in through the product's own mount flags;
  re-run `DRIVE_STANDIN_BLENDER=… node --test test/home-demos.test.mjs`
  against real storage when #173 lands and update docs/demos.md — the
  page re-renders from the record, so the number follows.
- Mac side (a real Finder window, Final Cut scrub) — listed on issue
  #113 as an open check; not measured here.
- `drive init` itself (sign-in, then a per-tool key for every installed
  agent) needs the live api Worker, so it is #173's run too. What the
  agent row measures is the half the page claims: the agent reading and
  editing through the mounted drive folder.
