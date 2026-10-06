---
title: How it works
description: Plain files in object storage, the cache, restore, and how the bill is counted.
---

# How it works

## Plain files

Your Drive is a folder. Inside it, your files have the names you gave them and
open in the apps you already use. Nothing is packed into a database or a
proprietary container, so if you ever leave, your files come with you in the
shape you put them in.

Under the folder, the bytes live in an object store we run. You never see that
layer; you see files.

## Files on demand

A file in your Drive is not fully on your disk. When an app opens one, the
parts it asks for arrive as it reads, so a 5 GB video starts playing without a
5 GB download first. A save uploads after you close the file, and then shows
up on your other machines. How long a save takes to cross between two real
machines is not yet measured. See [Benchmarks](/benchmarks) for the rows that
do and do not carry a figure.

What is on your disk is the parts you have already opened, held in a cache
capped at {{CACHE_LIMIT}} with {{CACHE_FLOOR}} of your disk always kept free.
The cap covers only what has already uploaded: a save that has not gone up yet
stays on disk past the cap until it uploads, so uploads that are paused or
behind can use more disk than the cap.
`drive cache` shows the disk in use and the limit, `drive cache --max <size>`
changes it, and `drive cache --clear` empties it without touching a file still
waiting to upload. `drive status` shows the same cache use. Files you keep
offline stay on this computer, are never evicted, and count toward that limit.

## Keeping a folder on this computer

If you are going somewhere with no network, tell the drive to keep the folder
here first:

```sh
drive offline <path>      # keep this file or folder on the computer
drive offline --list      # what is kept here now
drive online <path>       # stop keeping it here; with no path, all of it
```

`drive status` says what is kept offline. What is kept here is a copy on this
machine's disk, so it is the one thing that a wiped laptop can lose.

## Stopping the uploads for a while

```sh
drive pause       # stop the bytes leaving this computer; survives a restart
drive resume      # let them leave again
```

Pausing holds new saves on this computer and sends nothing. Files already on
the drive keep working, because reads come the other way.

## Versions

{{VERSION_HISTORY}} Saving a file again replaces it, and no
command lists the versions that were there before. {{NOT_OPEN}} See
[Limits](/limits) for what is not in version 1.

## Restore

Deleting a file on the Files page does not erase it. It moves to Recently
deleted and stays there for 30 days, the meter stops counting it the same
hour, and you can put it back yourself: open your drive in the browser, press
the **Recently deleted** tab, find the file, and press **Restore**. After 30
days the file is removed for good.

A delete made anywhere else — `rm` in the mounted folder, an rclone command,
or an S3 client with a storage key — does not pass through Recently deleted.
The storage keeps the previous copy for one day and removes it after. To get
such a file back, leave your email in the form on the [landing page](/)
within that day; we reply and put it back. {{AGENT_DELETE}} See
[Agents](/agents) for what a key can and cannot do.

## How the bill is counted

The meter counts every GB you keep, by the minute. At the end of the month the
rate is {{RATE}} on the month's GB-months, and the bill is never more than
{{MAX_PER_TB}} for each TB. {{NO_PLANS}} {{VERSION_MINIMUM}} Downloads are
counted separately. The numbers worked out for four sizes are on
[Pricing and your bill](/pricing).

## Next

- [Quickstart](/quickstart) — five steps to a mounted drive.
- [Pricing and your bill](/pricing) — the rate and the maximum.
