---
title: Quickstart
description: Put your files on a Drive and open them from any app, in one command.
---

# Quickstart

A Drive is a folder that works like any other folder. Your files live in our
storage, your machine opens them on demand, and your agents read and write the
same files.

## Before you start

You need an invite and a machine running macOS, Linux or Windows. The drive is
not open yet, so ask on the pricing page.

Nothing else. One line below installs the command and everything it needs with
it, and `drive init` checks the versions and prints the fix when a piece is
older than the drive mounts with, so you never have to know a version floor in
advance.

## 1. Install the command

macOS, with Homebrew:

```sh
brew install drive
```

Linux, Debian or Ubuntu:

```sh
sudo apt install drive
```

Linux, Fedora or RHEL:

```sh
sudo dnf install drive
```

One line per system, and nothing else to do by hand: the command and the parts
it needs (the storage driver among them) arrive together, because each drive
package declares the parts it needs and the package manager resolves them.
`drive init` in step 3 refuses to mount when a part is older than it needs and
prints the fix, so the version talk lives in [Other ways](#other-ways-to-install)
and not in your way.

These packages are not published yet — they land with the first release, and the
line above is the one to paste once your package manager can resolve them.
Until then use one of the [other ways](#other-ways-to-install).

Windows installs with an installer that puts the command on your PATH and
registers the logon task; it comes with the first published release.

When a new version ships, one command moves you to it:

```sh
drive update
```

It leaves your Drive folder and mount working throughout. `drive version` says
which version you are on.

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

The first three say where your folder is. The last two are the key pair: the
`DRIVE_S3_SECRET_ACCESS_KEY` one is never a flag (`--secret-key` is refused),
and `drive mount --secret-key-stdin` reads it from stdin instead.

## 3. Mount it, at login and now

```sh
drive init
```

`drive init` is the whole first run: it checks the installed parts are present
and new enough, sets the drive to start on its own at every login, starts it
now, and then looks for Claude, Codex, Gemini, Cursor and Kiro and connects
each one it finds. A folder called **Drive** appears in your
home directory on macOS and Linux, and a drive letter on Windows, and every app
on the machine can open it. [Agents](/agents) has the details, including what
an agent key cannot do.

`drive uninstall` is the other half of the login item: it stops the mount and
removes the item, so the drive does not start at the next login.

## 4. Check it

```sh
drive status
```

Storage is metered from the moment the mount starts. {{MEMBERSHIP}}
[Pricing and your bill](/pricing) has the ceiling and four
worked sizes.

## 5. Keep it current

```sh
drive update
```

`drive update` installs the newest released version and prints the version the
installed binary now reports. `drive update --check` says whether a newer
version exists and changes nothing.

## 6. Bring files in

rclone already talks to the folders you have elsewhere. Name a remote once,
then this command copies it into the mounted drive:

```sh
rclone config
drive import photos:
drive status
```

`rclone config` is rclone's own setup. It has Dropbox and Google Drive
backends; we never see those passwords, and we register no app of ours. Name
the remote something other than `drive` — that name is the mount. `drive import
photos:` copies into the mounted drive folder with rclone's own `copy`. The
drive must be mounted (`drive init` first). `drive status` shows the files
landing.

## Other ways to install

The one-line install above asks your package manager for the released package.
The packages come from the same tagged release, so these are the ways when
that release has not run yet, or you would rather build the command yourself:

- Build the command from the source with the Go toolchain. `drive --help` prints
  the exact route, and `drive update` runs the same build when a new version
  ships, so it leaves the old binary in place until the new one is built.
- Build the Linux and macOS packages on your machine with
  `goreleaser release --snapshot --clean`, then install the file the build
  writes under `dist/`.
- Windows installs with an MSI built with the stock WiX toolchain: it puts the
  command and rclone on your PATH, brings WinFsp in through WinFsp's own
  package dependency, and registers the logon task.

The mount needs rclone 1.68.0 or newer. `drive init` refuses an older one and
prints the fix, which is to install rclone from
[rclone.org/downloads](https://rclone.org/downloads/): Ubuntu 24.04's archive
rclone is 1.60.1, below the floor, and Fedora 43's is 1.74.3, above it.

## Next

- [How it works](/how-it-works) — plain files, versions, restore.
- [Limits](/limits) — what version 1 does not do.
