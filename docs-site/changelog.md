---
title: Changelog
description: One line per thing that shipped, newest first.
---

# Changelog

One line per shipped thing. Newest first, and the date is the day it reached
the live site.

## 2026-10-06

- A Rewind tab in the web app lists the branches an agent worked in, names the
  files each one changed, and puts your files back in one tap. The new
  `drive undo` command does the same thing from the command line: it rewinds
  the last branch an agent worked in, prints what it removes first, and says
  when it is done. Both read the same /api/rewind route, so the screen and the
  command cannot disagree about what a rewind undoes, and a branch stays
  rewindable for 30 days.
- A branch copies the files your folder held when you made the branch, not the
  files it holds when the copy runs. A file added in between is not in the
  branch, and the next branch takes it. A file that grew in between is copied in
  full, and `drive diff` reports it as changed in the original.
- An upload link now says who it belongs to. The page a stranger opens shows
  the owner's name above the folder, and once a day the owner gets one email
  listing the files that arrived through that link since the last one, rather
  than one email per file.
- An account holds at most 20 live keys, and a mint past that is refused with
  the words to fix it. The storage vendor sets no limit of its own, and a
  nightly sweep removes the vendor keys of expired or revoked entries and
  records how many keys the vendor holds.
- A share link fixes on the file's version at the moment you make it. If that
  file is replaced afterwards, the link refuses with a short page instead of
  handing out the new bytes. A file on the stock known-bad hash list is
  refused when you share it and when someone drops it on an upload page.
- Each agent tool gets its own folder at `~/Drive-agents/<tool>`, mounted on
  that tool's own key, instead of sharing the folder you use.
- A test now fails the build if a page names a command or links to a page that
  does not exist, so a page that promises `drive restore` cannot come back.
- The conflict guard hashes a save where it already lives instead of keeping a
  second copy, works through a large drop a hundred files at a time, and
  `drive status` names a backlog as "conflict guard behind by N saves".
- A public status page that reads the Worker's own health route, an
  accessibility statement, and the site's own 5xx page (a browser that hits an
  error now sees the site instead of a JSON body). The security page states
  where files are stored and what each key can do.
- `drive doctor`: one block with the versions, the mount state, the log's last
  lines and the api answer, to paste into a support message.
- `drive --help` no longer names tracker rows, and names the page below
  instead. Two failure lines fixed: the Linux unmount hint names the
  `fusermount` fallback the code runs, and the key-still-live line no longer
  repeats its own next step.
- New docs page, [When something goes wrong](/troubleshooting): the three
  commands to run, the log on each system, a new laptop, a lost laptop, your
  email, and taking your files out. Linked from the 404 page and from
  `drive status`.
- Customer pages now say only what version 1 does: no $5 roll-over, no live
  team bill, Get drive opens the waitlist while sign-up is invite-only, and
  get-started names Mac and Linux.

## 2026-10-05

- Your account can carry a second factor: a rotating six-digit code from an
  authentication app. Approving a new device asks for that code after the code
  from the terminal, and ten one-time recovery codes are shown once when you
  turn it on. You can also add a passkey, which is a way to sign in and is not
  asked for when you approve a device. The security page has the recovery rule.
- The home page, the upload page and the docs pages pass the accessibility
  engine's checks, on a desktop and on a phone. The home page's tagline is
  dark enough to read on the orange, a wide docs table now scrolls sideways
  inside itself instead of dragging the page with it, the upload page's file
  picker is no longer an unlabelled stop in the keyboard order, the closing
  banner is plain text a screen reader reads out, and every page links the
  favicon instead of asking for the old missing one.
- Your drive never works on an old copy: the app says which build it is when
  it talks to the server, and the server tells an old build to run
  `drive update` instead of failing in some other way.
- `drive status` says when a newer drive is available, once a day, so you
  learn about the update without running `drive update` to find out.
- `drive update` now puts the drive back on the new build for you, and tells
  you when the tool it uses to talk to the drive is too old for the new
  mount.
- The stored-bytes mark for one hour is what your drive held at the end of
  that hour, so a file you replace several times inside an hour counts once, not
  once per save. Each save is still billed for at least one hour, and the
  pricing page, the how-it-works page, the FAQ and llms.txt now say so.
- The free download allowance follows the average your GB-minutes work out to,
  not the biggest single hour mark, so an hour where two versions were both
  live no longer raises the allowance on its own.
- A month whose files are all empty bills $0 through the usage and cap routes
  instead of failing them.
- The last-sync time on the Get started page is written in the time zone your
  own computer is in, with the day first and the month short, the order the
  site's other dates use.
- The day a closing account's files are deleted now says which time zone that
  day is in.
- Prepaid balance: add $10 or more, and storage and downloads are drawn
  from your balance at {{RATE}}, never more than {{MAX_PER_TB}} per TB. The
  balance never expires. Nothing is charged to your card after use. The
  account page shows the balance, top-up, auto top-up and recent lines.
- An agent key the app makes for you is capped at the published $20 a month,
  not the $12 an old schema default had been setting on its row. The daily
  count also adds each request in the database itself, so a tool sending many
  requests at once counts every one instead of about one.
- Abuse guards: one active account per card, 1 TB storage until the first
  charge, and a spending cap default of $20.
- New pricing: pay only for what you store. {{RATE}}, never more than
  {{MAX_PER_TB}} per TB, and no minimum. The old flat plan, its half-price
  intro and the old ceiling are gone.
- The half-price offer for early members is removed. Every account pays the same
  rate.

- After `drive login`, every command reads the api address it saved, so
  `drive init`, `drive cap` and `drive share` work without `DRIVE_API_URL`.
  Login prints `Signed in as` plus the email. Opening the approve link while
  signed out goes to sign-in and back; after Approve the tab says this Mac is
  connected.

## 2026-10-04

- `drive login` connects the app to your account: it opens the browser, mints
  this machine's key, and writes the storage settings, so `drive init` needs
  no pasted keys. Get started shows the real install and login lines.
- The notes `drive init` writes for agents no longer advertise `drive restore`,
  a command that does not exist. The CLI now keeps one command table, and a
  test holds the notes' command lists and `drive --help` to it in both
  directions: neither can name a command that does not run, and no shipped
  command is left out of the help.
- Every minted storage key is scoped to the bucket that is the account's own
  rather than the deployment's one shared bucket, and a minted answer now names
  the bucket it can reach. A key that named no bucket is refused at the mint
  instead of being handed the shared one. The two-account refusal is measured
  on the stand-in and by the recorded mint table; the same proof against the
  real vendor ships as an opt-in test and runs when the account's reseller
  token is in the environment.
- The usage page's spending cap is now a control and not a readout: move the
  slider, choose Save cap, and the new cap is written through the same api
  route `drive cap` writes. The page's confirmation is the api's own cap line,
  and an error names what to do next in plain words instead of a command.
- The home page's worked examples read as sentences about the bill instead of
  arrow tables of numbers.
- The pricing copy states the bill directly: storage use sets it, and
  sign-up asks for a card because there is no
  free tier.
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
  iDrive e2 is not our storage, and the seat moves to Backblaze B2. Reversed the
  next day: files stay on iDrive e2 in Paris (eu-west-3), and each key is scoped
  to a bucket instead (drive#371).
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
  the mount at login (a login item on macOS, a user unit on Linux, or a
  Task Scheduler task on Windows). `drive uninstall`
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
- `drive update` and `drive version`: an update hands off to the package
  manager that installed the CLI (brew, apt, dnf or winget), and `drive
  version` prints the version the binary was built and installed at, so an
  update is visible.
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
- The bill ceiling: the metered cost cut off at a flat $12 until the drive
  passes 1.5 TB, then $8 a TB. This replaced the older per-TB caps.
- The retired plan: storage use counted toward a monthly charge, and a card was
  needed at sign-up because there is no free tier. Downloads over
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
  When something goes wrong, Limits, Benchmarks, Security and this changelog,
  each also served as Markdown.
- The FAQ page: it publishes an answer only once the scoreboard row under it
  is a measured win, so a line we have not measured yet stays off it.

## Earlier

Before 2026-09-30 the drive was built in steps, not shipped. See
`docs/build-spec.md` in the repository for the plan and the proof of each step.
