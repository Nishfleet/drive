---
title: Limits
description: What version 1 of Drive does not do, and where it is slower than the alternatives.
---

# Limits

This page is the honest one. Anything here is not in the product today, and we
would rather you read it here than find out in week three.

## Not in version 1

- **We are not open yet.** Sign-ups on the pricing page go to a waitlist, and
  an account arrives by invitation.
- **The CLI is not packaged.** There is no install script and no release
  download. Today you build it from the source, with one command:
  `go install github.com/Nishfleet/drive/cmd/drive@latest`. A one-line
  install is on the way.
- **macOS is read-only for us.** We can prove the drive on a Mac only on a
  GitHub macOS runner or by hand, so what we have measured end to end is
  Linux.
- **No `restore` command yet.** A delete is still reversible through the
  storage provider's own versioning, but `drive restore` is not in the CLI.
- **No branch or approve commands.** Agents work in the live folder, so a
  large edit has no copy to sit in while you check it.
- **No app or a desktop icon.** The drive is a folder and a command line.
- **No Windows.** macOS and Linux.
- **No second person on the account.** One account, your devices, your agents.

## Where we are slower than the alternatives

- **First open of a large file.** A file streams on demand, so a 5 GB video
  starts before the whole file has arrived, but the first open on a slow
  connection will stutter. A drive that holds local copies of the files you
  keep offline is faster to reopen.
- **Rename and move are not free.** A folder move is a copy and a delete on
  plain object storage, so renaming a 200-file folder takes about 0.6 seconds
  and moving a 10 GB folder about 18 seconds on our test storage (a local
  stand-in, so read both as an order of magnitude) — the storage server makes
  the copy, so nothing is re-uploaded through your machine, and a move never
  adds a byte to your bill.
- **Directory listing.** A folder of a million files is not instant to open in
  the Finder.
- **One machine's disk is still a cache.** Your machine holds what it has
  already read. Clearing the cache means re-reading from the network.

## Where we are better

- **A cap you set.** Set a spending cap and the drive goes read-only at it:
  nothing is deleted, and the bill stops there. The default cap is
  {{DEFAULT_CAP}}.
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
