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
5 GB download first. A save reaches storage a few seconds after you close the
file, and then shows up on your other machines.

## Versions

Every save keeps the version it replaced. A file's history holds every change
for one day, then one version per day for 30 days. Version history is included;
there is no extra charge for it.

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

- [Quickstart](/quickstart) — three steps to a mounted drive.
- [Pricing and your bill](/pricing) — the rate and the ceiling.
