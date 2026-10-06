---
title: Limits
description: What version 1 of Drive does not do, and where it is slower than the alternatives.
---

# Limits

This page is the honest one. Anything here is not in the product today, and we
would rather you read it here than find out in week three.

## Not in version 1

- **We are not open yet.** {{NOT_OPEN}} An account arrives by invitation.
- **The packages publish on a `v*` tag.** GoReleaser builds the
  `.deb`, the `.rpm` and the Homebrew cask from `.goreleaser.yaml`, and the
  release workflow on a `v*` tag publishes them. Signing and notarize stay
  off until their secrets exist. Until a public stable tag, the install
  that works today is to build the same package locally with
  `goreleaser release --snapshot --clean` and install the file under `dist/`.
  The [Quickstart](/quickstart) leads with the released commands and
  keeps the details in its Other ways section.
- **macOS is read-only for us.** We can prove the drive on a Mac only on a
  GitHub macOS runner or by hand, so what we have measured end to end is
  Linux.
- **No `restore` command yet.** A delete from the Files page is restorable for
  30 days in Recently deleted; a delete made any other way is recoverable for
  one day by asking us. `drive restore` is not in the CLI.
- **{{VERSION_HISTORY}}** Save a file again and the file is replaced; no command
  lists the versions that were there before.
- **No app or a desktop icon.** The drive is a folder and a command line.
- **Windows is not in version 1, and its installer is an unsigned MSI, not a
  command.** Windows gets the
  same mount as Mac and Linux, on a drive letter, with WinFsp as the driver
  and a Task Scheduler task at logon. The installer builds in CI with the
  stock WiX toolchain and WinFsp arrives through its own package dependency,
  never a vendored copy. Builds are unsigned until a signing certificate is
  bought, so no published release exists yet (#154).
- **No second person on the account.** There is one account, your devices and
  your agents, so sharing a folder with a colleague is not a version 1 thing.
  When someone leaves there is no access of theirs to take away: revoke that
  machine's key with `drive logout` on the machine itself, and turn its links
  off with `drive share --revoke <t>`.

## Where we are slower than the alternatives

- **First open of a large file.** A file streams on demand, so a 5 GB video
  starts before the whole file has arrived, but the first open on a slow
  connection will stutter. `drive offline <path>` keeps a folder on this
  computer instead, which is what a rival's local copy already does.
- **Rename and move are not free.** A folder move is a copy and a delete on
  plain object storage, so renaming a 200-file folder takes about 0.6 seconds
  and moving a 10 GB folder about 18 seconds on our test storage (a local
  stand-in, so read both as an order of magnitude) — the storage server makes
  the copy, so nothing is re-uploaded through your machine, and a move never
  adds a byte to your bill.
- **Directory listing.** A folder of a million files is not instant to open in
  the Finder.
- **Your disk holds a cache, and it is capped.** What is on disk is the parts
  of your files you have already opened. It grows to at most {{CACHE_LIMIT}},
  and the drive always keeps at least {{CACHE_FLOOR}} of your disk free. The
  cap covers only what has already uploaded: a save waiting to go up stays on
  disk past the cap until it uploads, so uploads that are paused or behind can
  use more disk than the cap.
  {{CACHE_COMMANDS}}; a file waiting to upload is never cleared. Files you keep
  offline stay on this computer, count toward that limit, and `drive status`
  shows the same cache use.

## Where we are better

- **A cap you set.** Set a spending cap with `drive cap <dollars>` and the
  drive goes read-only at it: nothing is deleted, and the bill stops there.
  The default cap is {{DEFAULT_CAP}}.
- **The maximum.** The bill is never more than {{MAX_PER_TB}} for each TB you
  store, so a full drive cannot surprise you.
- **An agent's delete is undoable for a short time only.** {{AGENT_DELETE}}
- **A branch key is not a wall.** {{BRANCH_REACH}}
- **A branch is a real copy.** `drive branch` copies every byte of the folder,
  so a branch counts against your storage until you `discard` it or `approve`
  it, and `approve` stops with a list of conflicting files instead of a
  silent overwrite.
- **A branch still has a size cap.** Copy, approve, discard and rewind now run
  as a queued job in file batches, so they stay inside one Worker's request
  budget. A folder with more than 100,000 files still cannot be branched: the
  snapshot for that many files is about 11 MiB in memory, and that is the
  remaining limit.

## Honest notes on the numbers

- Every figure on the [pricing page](/pricing) is worked out from the
  same config the invoice is worked out from, and a test fails the build if
  the two disagree.
- Where Drive is slower than a rival, we say so here rather than on the
  pricing page, and we would rather add a line to this page than remove one.

## Next

- [Security](/security) — who can see your files.
- [Pricing and your bill](/pricing) — the rate and the maximum.
