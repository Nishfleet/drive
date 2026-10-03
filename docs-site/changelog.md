---
title: Changelog
description: One line per thing that shipped, newest first.
---

# Changelog

One line per shipped thing. Newest first, and the date is the day it reached
the live site.

## 2026-10-03

- One command installs the drive CLI and rclone together: the Linux `.deb` and
  `.rpm` declare `Depends: rclone`, the Homebrew formula depends on `rclone`,
  and `drive init` then checks rclone is 1.68.0 or newer, mounts, and starts
  the mount at login (launchd, systemd, or Task Scheduler). `drive uninstall`
  removes that login item.
- `drive update` and `drive version`: an update replaces the installed CLI
  with the latest released version by the same `go install` command a person
  installs with, and `drive version` prints the version the binary was built
  and installed at, so an update is visible.
- Windows gets the same `drive mount` the Mac and Linux have had: `rclone
  mount` with WinFsp as the driver, mounted at the first free drive letter from
  D: up, started at login by a stock Task Scheduler task (no helper scripts),
  with `drive unmount`/`logout`/`status`/`uninstall` and unit tests for every
  branch. A missing WinFsp is an error that points at reinstalling Drive.
- `drive unmount`, `logout` and `uninstall` on Windows now wait for WinFsp to
  detach the letter, and find a stale mount by reading the letters the running
  rclone processes hold, so a letter rclone is still holding is never reported
  as stopped.
- Windows installs from an MSI built with the stock WiX toolchain: it puts
  `drive.exe` and rclone on PATH, brings WinFsp in through WinFsp's own
  package dependency (never a vendored copy), registers the logon task, and
  uninstalls to a clean machine. The builds are unsigned and pre-release, so
  there is nothing to install from a public release yet.

- The Benchmarks page: every speed scenario the suite measures, next to the
  published rival figure for the same case, with losses labelled losses. Linux
  and Mac numbers that have not been run yet say so; nothing here is estimated.
- The share card is now rendered from a committed source page, and its price is
  gated against the one price config, so a re-priced product moves the card
  with the page instead of leaving a stale picture behind.

## 2026-09-30

- The pricing page, with the rate, the ceiling and a waitlist sign-up.
- The bill ceiling: the metered cost cut off at a flat {{CEILING_FLOOR}} until
  the drive passes 1.5 TB, then {{CEILING_PER_TB}} a TB. This replaced the
  older per-TB caps.
- The free {{FREE_USD}} comes off the month's total, and downloads over
  {{FREE_DOWNLOAD_MULTIPLE}} times what you store are charged at
  {{DOWNLOAD_RATE}}.
- The spending cap: at your cap the drive goes read-only and nothing is
  deleted. The default cap is {{DEFAULT_CAP}}.
- The first-run page, which shows a new machine going from signed out to
  mounted.
- The usage page, which shows the month's stored size and what it cost, worked
  out from the same numbers as the invoice.
- The api Worker: health, keys and usage routes, with one capability table for
  what each kind of key can do.
- `drive status` and `drive logout`.
- `drive init` connects Claude, Codex, Gemini, Cursor and Kiro, and writes
  each tool's own instruction note.
- These docs: Quickstart, How it works, Agents, Pricing and your bill, FAQ,
  Limits, Security and this changelog, each also served as Markdown.
- The FAQ page: it publishes an answer only once the scoreboard row under it
  is a measured win, so a line we have not measured yet stays off it.

## Earlier

Before 2026-09-30 the drive was built in steps, not shipped. See
`docs/build-spec.md` in the repository for the plan and the proof of each step.
