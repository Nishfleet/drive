---
title: Limits
description: What version 1 of Drive does not do, and where it is slower than the alternatives.
---

# Limits

This page is the honest one. Anything here is not in the product today, and we
would rather you read it here than find out in week three.

Version 1 is not open yet, has no restore command, has no second person on the
one account, and Windows has no public installer yet.

## Not in version 1

- **We are not open yet.** Sign-ups on the pricing page go to a waitlist, and
  an account arrives by invitation.
- **The CLI is not packaged.** There is no install script and no release
  download. Today you build it from the source, with one command:
  `go install github.com/Nishfleet/drive/cmd/drive@latest`. A one-line
  install is on the way.
- **macOS is read-only for us.** The Mac mount is stock `rclone nfsmount`, which
  uses the system's own NFS server, so there is no macFUSE to install. The mount
  proof runs on a Mac, but we cannot measure a person's real Mac, so what we
  have measured end to end is Linux. We name the oldest Mac version only after
  a green Mac run (#116 owns both).
- **No `restore` command yet.** A delete is still reversible through the
  storage provider's own versioning, but `drive restore` is not in the CLI.
- **No version history.** Save a file again and the file is replaced; no command
  lists the versions that were there before.
- **No app or a desktop icon.** The drive is a folder and a command line.
- **Windows installs with an MSI, not a command.** Windows gets the
  same mount as Mac and Linux, on a drive letter, with WinFsp as the driver
  and a Task Scheduler task at logon. The installer builds in CI with the
  stock WiX toolchain and WinFsp arrives through its own package dependency,
  never a vendored copy. Builds are unsigned until a signing certificate is
  bought, so no published release exists yet (#154).
- **No second person on the account.** There is one account, and adding a
  teammate is not in version 1. When someone leaves there is no access of
  theirs to take away: revoke that machine's key with `drive logout` on the
  machine itself, and turn its links off with `drive share --revoke <t>`.
- **No write-conflict rule.** The docs do not say what happens when two agents
  write the same file at once.

## Where we are slower than the alternatives

- **First open of a large file.** The first open has extra latency: a 5 GB
  video streams on demand and starts before the whole file has arrived, but a
  slow connection will stutter. `drive offline <path>` keeps a cache copy of
  the folder on this computer instead.
- **Rename and move are not free.** A folder move is a copy and a delete on
  plain object storage. It does not copy the bytes through your machine, but
  it is still not an instant rename, and a big move takes time.
- **Directory listing.** A folder of a million files is not instant to open in
  the Finder.
- **Your disk holds a cache, and it is capped.** Your disk never fills up; the
  cache is capped at a size you choose. What is on disk is the parts of your
  files you have already opened. It grows to at most {{CACHE_LIMIT}}, and the
  drive always keeps at least {{CACHE_FLOOR}} of your disk free.
  {{CACHE_COMMANDS}}; a file waiting to upload is never cleared. Files you keep
  offline stay on this computer, count toward that limit, and `drive status`
  shows the same cache use.

## Where we are better

- **A cap you set.** Set a spending cap with `drive cap <dollars>` and the
  drive goes read-only at it: nothing is deleted, and the bill stops there.
  The default cap is {{DEFAULT_CAP}}.
- **The bill ceiling.** The metered cost is cut off at a flat
  {{CEILING_FLOOR}} until the drive passes 1.5 TB, then {{CEILING_PER_TB}} for
  each TB after, so a full drive cannot surprise you.
- **Agents cannot delete.** An agent key cannot remove a file; only a person
  can, and a person's delete is restorable.

## Honest notes on the numbers

- Every figure on the [pricing page](/pricing) is worked out from the
  same config the invoice is worked out from, and a test fails the build if
  the two disagree.
- Where Drive is slower than a rival, we say so here rather than on the
  pricing page, and we would rather add a line to this page than remove one.

## Next

- [Security](/security) — who can see your files.
- [Pricing and your bill](/pricing) — the rate and the ceiling.
