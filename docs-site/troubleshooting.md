---
title: When something goes wrong
description: The three commands to run first, where the log lives on each system, moving to a new laptop, a lost laptop, your email, and taking your files out.
---

# When something goes wrong

Most trouble is one of a few things: the mount is not running, a piece of the
install is too old, this device's key no longer works, or the network is down.
Every failure the command prints names what happened and the next step; this
page is the map for the rest. What it does not fix, it hands you as a block to
send: [Support](https://drive-pricing.nishant345.workers.dev/support) says how
to reach a person.

## The three commands

Run them in this order and read what each prints. The third pair is for a
mount that will not come up.

```sh
drive status
drive doctor
drive unmount
drive mount
```

1. `drive status` says whether the drive is mounted, what is waiting to
   upload, and what this month costs so far. Near the end it names this
   page, so the way in is one `drive status` away whether the drive is
   broken or not.
2. `drive doctor` prints one block: the drive and rclone versions, whether the
   mount is up, the last lines of the log, and whether the account side
   answers. If you write to support, paste that block. It is the whole first
   reply you would otherwise wait a day for.
3. If the mount is the trouble, start it again: `drive unmount`, then
   `drive mount`. A mount that started before the network was up, or that lost
   the network halfway, comes back with this.

## The log, on each system

The mount writes what it does, and the log is the first thing a support reply
reads.

- **macOS:** the log file is `~/.config/drive/mount.log`. The login item
  redirects the mount's output there, so the file holds what the mount last
  said. Open it in any text editor.
- **Linux:** the log is journald's, read with
  `journalctl --user -u drive-mount.service -n 20`. A machine with no user
  session (a container, a headless box) has the same file macOS has instead:
  `~/.config/drive/mount.log`.
- **Windows is not in version 1: it installs with an unsigned MSI, not a
  published release.** When it does run, the logon task writes the log to
  `%USERPROFILE%\.config\drive\mount.log`, the same place the other two
  systems use.

`drive doctor` reads the right one for your system and puts its last lines in
the block, so you do not have to find the file unless you want to.

## Move to a new laptop

Nothing needs copying. Your files are in your storage, not on the old
machine's disk, and the new machine fetches a file when you open it.

1. Install the command on the new machine (the one line is in the
   [Quickstart](/quickstart)).
2. Run `drive login`, then `drive init`. The folder appears, with everything
   it had.
3. On the old machine, run `drive logout` when you stop using it. It stops the
   mount and turns off that machine's key, so a machine you no longer hold
   cannot reach the account.

Each device gets its own key, which is why one machine's logout never touches
another.

## A lost laptop

Sign out everywhere from a machine you do have:

```sh
drive logout --all --yes
```

`drive logout --all` prints what it is about to do and waits; `--yes` is the
go-ahead. It turns off every key and signs out every signed-in session, this
machine included, so anything you still use signs in again after.

It turns off the keys, not the disk: what the lost laptop had already pulled
onto its own disk stays on that disk. [Security](/security) has what a key
could reach up to the moment you revoked it.

## Change your email

There is no page for this yet. Write to us from the address the account uses,
so we can find the account, and name the new address:
[Support](https://drive-pricing.nishant345.workers.dev/support). Never send a
key, a password or a sign-in link.

## Take your files out

The Drive folder is a normal folder. Copy out of it the way you would copy out
of any folder — drag it in the file manager, or
`cp -R ~/Drive/my-folder ~/Desktop/` — and a file you copy is read like any
file you opened.

`drive export` is a different thing: it writes a file of account data (the
file list, versions, keys), not the file bytes. The bytes leave through the
folder, so the folder is the way to take your files anywhere.

## Still stuck

Run `drive doctor`, copy its block, and write to
[Support](https://drive-pricing.nishant345.workers.dev/support). Say what you
did, what you saw, and when. What version 1 does not do at all is on the
[Limits](/limits) page, so it is worth a look before you write.
