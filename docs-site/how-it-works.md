---
title: How it works
description: Plain files in object storage, versions, restore, and how the bill is counted.
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
Your disk never fills up; the cache is capped at a size you choose.
`drive cache` shows the disk in use and the limit, `drive cache --max <size>`
changes it, and `drive cache --clear` empties it without touching a file still
waiting to upload. `drive status` shows the same cache use. Files you keep
offline stay on this computer, are never evicted, and count toward that limit.

## Versions

Version history is not in version 1. See [Limits](/limits) for what is not in
version 1.

## Restore

Deleting a file moves it aside rather than erasing it, and a delete can be
undone. The `drive restore` command is not in the CLI yet — see
[Limits](/limits) — but an agent cannot delete at all, so an agent's
mistake cannot cost you a file. See [Agents](/agents) for what a key can
and cannot do.

## How the bill is counted

The meter counts every GB you keep, by the minute. At the end of the month the
rate is {{RATE}} on the month's GB-months, and that number is cut off at the
ceiling: a flat {{CEILING_FLOOR}} until the drive passes 1.5 TB, then
{{CEILING_PER_TB}} a TB. Then {{FREE_USD}} comes off, and downloads are counted
separately. The numbers worked out for four sizes are on
[Pricing and your bill](/pricing).

## Next

- [Quickstart](/quickstart) — five steps to a mounted drive.
- [Pricing and your bill](/pricing) — the rate and the ceiling.
