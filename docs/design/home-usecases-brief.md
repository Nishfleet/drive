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
Body text on `--paper` (#faf6ee): ink-soft 7.18:1, ink 15.2:1, accent
10.7:1 — all pass AA for normal and large text.

## Open checks (not faked)
- Real iDrive e2 storage (#173): the numbers above are measured on the
  local rclone serve s3 stand-in through the product's own mount flags;
  re-run `DRIVE_STANDIN_ENDPOINT=… node --test test/home-demos.test.mjs`
  against real storage when #173 lands and update docs/demos.md — the
  page re-renders from the record, so the number follows.
- Mac side (a real Finder window, Final Cut scrub) — listed on issue
  #113 as an open check; not measured here.
