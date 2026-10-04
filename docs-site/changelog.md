---
title: Changelog
description: One line per thing that shipped, newest first.
---

# Changelog

One line per shipped thing. Newest first, and the date is the day it reached
the live site.

## 2026-10-04

- The home page's worked examples read as sentences: "about $1 of storage, and
  you pay the $10 membership", instead of "$1 → $10" and "$12 of storage → $12".
- Membership copy: $10 a month, storage use counts toward it, founding members
  keep $5, and sign-up asks for a card because there is no free tier.
- Closing an account revokes every key at once, keeps files for 30 days, emails
  on day 0 and day 25, and lets the person cancel until then by typing their
  email on the usage page.
- A public savings calculator on the pricing page: enter a size, see this
  month's bill beside our own flat-plan ceiling. The number is
  `monthBillCents`, so it cannot drift from the invoice. No rival names or
  rival prices.
- `drive import <remote>` copies files from an rclone remote you already have
  (`rclone config` on your machine) into the mounted drive. Docs show the
  three commands: `rclone config`, `drive import photos:`, `drive status`.

## 2026-10-03

- The three build step 1 storage questions are now measured against the real iDrive
  e2 account (bucket `drive-prod`, region `eu-west-3`), and every setting was read
  back from that bucket: versioning on, a one-day hidden-version rule, SSE-S3. A key
  cannot be scoped to one folder there — the endpoint refuses `AssumeRole` — so
  iDrive e2 is not our storage, and the seat moves to Backblaze B2.
- `drive branch` mints a branch key scoped to `u/<account>/.branches/<name>/`
  with no delete, stores it 0600, and prints the prefix plus the two env var
  names an agent tool would run on — never the secret, never on the command
  line. One api base fronts both `/api/branches` and `/v1/keys`.
- The Dodo billing push host is configurable via `DODO_BASE_URL` (env), defaulting
  to `test.dodopayments.com`, so live billing can be switched on with one env var
  instead of a code change. The source never names the live host; a misconfigured
  URL is rejected at ingest time to keep the bearer token on an https
  `dodopayments.com` host.
- One command installs the drive CLI and rclone together: the Linux `.deb` and
  `.rpm` declare `Depends: rclone`, the Homebrew formula depends on `rclone`,
  and `drive init` then checks rclone is 1.68.0 or newer, mounts, and starts
  the mount at login (launchd, systemd, or Task Scheduler). `drive uninstall`
  removes that login item.

- `drive cache`, `drive cache --max` and `drive cache --clear`: the cache on
  disk is rclone's own VFS cache, capped at 20G with 1G of free space always
  kept, and a size you choose. `drive status` shows the same use. Files waiting
  to upload and files kept offline survive `--clear` and count toward the
  limit.

- `drive offline` and `drive online`: keep a file or folder on this computer
  so it opens with no internet, and `drive status` lists what is kept and how
  much disk it uses. New files in a kept folder stay kept. The copy lives in
  rclone's own cache; filling the cache does not drop it.

- `drive status` says what is waiting to upload and why: a cut-off upload
  resumes from rclone's VFS cache, a full cache disk fails with the table's
  disk-full words and loses nothing already saved, and a killed mount still
  shows the waiting files until they go up.
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
- `drive offline <path>` and `drive online`: keep a file or folder on this
  computer before you lose the network, see what is kept with
  `drive offline --list`, and let the disk go again with `drive online`. The
  offline list is on `drive status`.
- `drive pause` and `drive resume`: hold new saves on this computer and send
  nothing, and the hold survives a restart.
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
- A key one of your tools holds now stops working after an hour of not being
  used, and the api Worker restarts that hour quietly on every request the tool
  makes. Revoking a tool stops the renewal at once. A key that leaks is
  therefore a key that is worth nothing to whoever holds it once you stop
  working, and one hour is the longest a copied tool entry is useful without
  you. Your own device sign-in is unchanged.

## 2026-09-30

- The pricing page, with the rate, the ceiling and a waitlist sign-up.
- The bill ceiling: the metered cost cut off at a flat {{CEILING_FLOOR}} until
  the drive passes 1.5 TB, then {{CEILING_PER_TB}} a TB. This replaced the
  older per-TB caps.
- The membership: storage use counts toward it, and a card is needed at
  sign-up because there is no free tier. Downloads over
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
  Limits, Benchmarks, Security and this changelog, each also served as Markdown.
- The FAQ page: it publishes an answer only once the scoreboard row under it
  is a measured win, so a line we have not measured yet stays off it.

## Earlier

Before 2026-09-30 the drive was built in steps, not shipped. See
`docs/build-spec.md` in the repository for the plan and the proof of each step.
