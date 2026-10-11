---
title: Quickstart
description: Put your files on Storagebun and open them from any app, in one command.
---

# Quickstart

A Storagebun drive is a folder that works like any other folder. Your files live in our
storage, your machine opens them on demand, and your agents read and write the
same files.

## Before you start

You need an invite and a machine running macOS or Linux. Windows is not in
version 1: it installs with an unsigned MSI, not a command, and no signed
release exists yet.
{{NOT_OPEN}} Ask on the pricing page.

Nothing else. One line below installs the command and everything it needs with
it, and `drive init` checks the versions and prints the fix when a piece is
older than the drive mounts with, so you never have to know a version floor in
advance.

## 1. Install the command

macOS, with Homebrew:

```sh
{{INSTALL_MACOS}}
```

Linux, Debian or Ubuntu — download the `.deb` for your CPU from the GitHub
release, then:

```sh
{{INSTALL_DEBIAN}}
```

Linux, Fedora or RHEL — download the `.rpm` for your CPU from the GitHub
release, then:

```sh
{{INSTALL_FEDORA}}
```

One line per system, and nothing else to do by hand: the command and the parts
it needs (the storage driver among them) arrive together, because each drive
package declares the parts it needs and the package manager resolves them.
`drive init` in step 3 refuses to mount when a part is older than it needs and
prints the fix, so the version talk lives in [Other ways](#other-ways-to-install)
and not in your way.

These packages publish on a `v*` tag. Linux still needs the file from that
release sitting in the folder you run the line from.

When a new version ships, one command moves you to it:

```sh
drive update
```

It leaves your Drive folder and mount working throughout. `drive version` says
which version you are on.

## 2. Log in

```sh
drive login
```

`drive login` opens the browser to the device-approve page, waits until you
approve this machine, mints its key, and writes the storage settings. You do
not paste keys. After it finishes, `drive init` and `drive mount` work on this
machine with no environment variables.

## 3. Mount it, at login and now

```sh
drive init
```

`drive init` is the rest of the first run: it checks the installed parts are
present and new enough, sets the drive to start on its own at every login,
starts it now, and then looks for Claude, Codex, Gemini, Cursor and Kiro and
connects each one it finds. A folder called **Drive** appears in your home
directory, and every app on the machine can open it. [Agents](/agents) has the
details, including what an agent key cannot do.

`drive uninstall` is the other half of the login item: it stops the mount and
removes the item, so the drive does not start at the next login.

## 4. Check it

```sh
drive status
```

Storage is metered from the moment the mount starts. {{NO_PLANS}}
[Pricing and your bill](/pricing) has the maximum and four
worked sizes.

## 5. Keep it current

```sh
drive update
```

`drive update` asks the package manager that installed this binary (Homebrew,
apt, dnf or winget) whether a newer package exists. If one does, it hands the
upgrade to that manager and prints the version the installed binary now
reports. `drive update --check` says whether a newer package exists and
changes nothing. A Linux install from a downloaded `.deb` or `.rpm` has no
package repo, so when apt or dnf has nothing newer the command prints the
same install line step 1 used.

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

- Build the Linux and macOS packages on your machine with
  `goreleaser release --snapshot --clean`, then install the file the build
  writes under `dist/`.
- Build the command from this repository's source with the Go toolchain
  (`drive --help` prints the module path). That route needs a public module.
- Windows is not in version 1: it installs with an unsigned MSI built with the
  stock WiX toolchain, which puts the command and rclone on your PATH, brings
  WinFsp in through WinFsp's own package dependency, and registers the logon
  task.

The mount needs rclone 1.68.0 or newer. `drive init` refuses an older one and
prints the fix, which is to install rclone from
[rclone.org/downloads](https://rclone.org/downloads/): Ubuntu 24.04's archive
rclone is 1.60.1, below the floor, and Fedora 43's is 1.74.3, above it.

## Next

- [How it works](/how-it-works) — plain files, the cache, restore, the bill.
- [Limits](/limits) — what version 1 does not do.
