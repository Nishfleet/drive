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
yet, so ask on the pricing page.

Nothing else. The install command brings rclone with it: the Linux packages
declare `Depends: rclone` and the macOS formula declares a `rclone` dependency,
so the package manager installs both. The mount needs rclone 1.68.0 or newer,
and `drive init` says so and prints the fix if the one your package manager
picks is older — Ubuntu 24.04's archive rclone is 1.60.1, so on that release
install rclone from [rclone.org/downloads](https://rclone.org/downloads/)
first.

## 1. Install the command

Linux, Debian or Ubuntu:

```sh
sudo apt install ./drive_1.0.0_linux_amd64.deb
```

Linux, Fedora or RHEL:

```sh
sudo dnf install ./drive_1.0.0_linux_amd64.rpm
```

macOS, with Homebrew:

```sh
brew install nishfleet/tap/drive
```

One command installs the drive CLI and rclone together. The release that
publishes these packages runs on a `v*` tag (`.goreleaser.yaml`), and until the
first release you can build the same package from the source with
`goreleaser release --snapshot --clean` and install the file it writes under
`dist/`.

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

## 3. Mount it, at login and now

```sh
drive init
```

`drive init` is the whole first run: it checks rclone is present and new
enough, writes the login item that starts the mount at the next login (a
launchd item on macOS, a systemd user unit on Linux), starts it now, and then
looks for Claude, Codex, Gemini, Cursor and Kiro and connects each one it
finds. A folder called **Drive** appears in your home directory, and every app
on the machine can open it. [Agents](/agents) has the details, including what
an agent key cannot do.

`drive uninstall` is the other half of the login item: it stops the mount and
removes the item, so the drive does not start at the next login.

## 4. Check it

```sh
drive status
```

Storage is metered from the moment the mount starts, and {{FREE_USD}} of it is
free every month. [Pricing and your bill](/pricing) has the ceiling and four
worked sizes.

## Next

- [How it works](/how-it-works) — plain files, versions, restore.
- [Limits](/limits) — what version 1 does not do.
