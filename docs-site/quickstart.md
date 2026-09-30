---
title: Quickstart
description: Put your files on a Drive and open them from any app, in one command.
---

# Quickstart

A Drive is a folder that works like any other folder. Your files live in our
storage, your machine opens them on demand, and your agents read and write the
same files.

## Before you start

You need an invite and a machine running macOS or Linux. The drive is not open
yet, so ask on the pricing page. You also need [rclone](https://rclone.org) and
[Go](https://go.dev) on the machine; both are stock tools, and neither is
installed for you.

## 1. Install the command

```sh
go install github.com/Nishfleet/drive/cmd/drive@latest
```

That puts `drive` in your Go bin directory. There is no install script and no
release download yet — see [Limits](/limits) — so this is the one that works
today.

## 2. Point it at your storage

Your invite comes with the endpoint, bucket and prefix for your own folder, and
a key pair. Put them in your shell environment, not on the command line, so the
secret never lands in your shell history or in `ps`:

```sh
export DRIVE_S3_ENDPOINT=https://your-endpoint
export DRIVE_S3_BUCKET=your-bucket
export DRIVE_S3_PREFIX=your-folder
export DRIVE_S3_ACCESS_KEY_ID=...
export DRIVE_S3_SECRET_ACCESS_KEY=...
```

## 3. Mount

```sh
drive mount
```

`drive mount` writes the rclone config and the login item, then starts the
mount. A folder called **Drive** appears in your home directory, and every app
on the machine can open it.

## 4. Connect your agents

```sh
drive init
```

`drive init` looks for Claude, Codex, Gemini, Cursor and Kiro, and connects each
one it finds to the Drive folder. [Agents](/agents) has the details, including
what an agent key cannot do.

## 5. Check it

```sh
drive status
```

Storage is metered from the moment the mount starts, and {{FREE_USD}} of it is
free every month. [Pricing and your bill](/pricing) has the ceiling and four
worked sizes.

## Next

- [How it works](/how-it-works) — plain files, versions, restore.
- [Limits](/limits) — what version 1 does not do.
