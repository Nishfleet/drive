package main

import (
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"strings"
)

// Logout is `drive logout`: stop the mount, then delete this device's key and
// its local config (issue #54, build-spec.md "Commands" — "Unmount, delete
// this device's key and local config"). Nothing outside the CLI's own config
// and cache directories is touched: the drive folder holds the person's files
// and is never this command's to delete.
//
// The device key is the `access_key_id` / `secret_access_key` pair in
// `~/.config/drive/rclone.conf` (config.go `RcloneConfig`), so deleting that
// file deletes the only local copy of the key, and the login item no longer
// has a key to mount with. Revoking the key in storage is the api Worker's
// job (issues #2 and #55, the storage API's key store); the CLI cannot call it
// until that endpoint exists, and this command does not pretend otherwise.
//
// Files waiting to upload are protected: rclone queues them in the VFS cache
// and does not flush them on stop (measured on this host 2026-09-30 with
// rclone v1.75.1: a file written with `--vfs-write-back 120s` stayed `Dirty:
// true` in the cache after a SIGTERM, and the backend never saw it), so
// deleting the cache would throw the person's work away. Logout refuses to do
// that unless `--force` says so in words.
func Logout(goos, home string, force bool) error {
	pending, err := PendingUploads(DefaultCacheDir(home))
	if err != nil {
		return err
	}
	if pending.Files > 0 && !force {
		return fmt.Errorf(
			"%d file(s) waiting to upload (%d bytes) are still in the cache; "+
				"start the mount and let them finish, or run `drive logout --force` to discard them",
			pending.Files, pending.Bytes)
	}
	// Stop the mount before the key goes, so nothing is mid-upload when the
	// config it reads disappears. Unmount stops the login item; stopMount then
	// makes sure the mount point itself is down. Unmount can legitimately fail
	// to disable a login item that was never installed (systemctl exits 1 with
	// "Unit file ... does not exist"), and that failure is not fatal to
	// logout: the login item file is deleted below, so it cannot come back at
	// the next login, and stopMount proves the mount is gone. So the end state
	// is measured, not the exit code: only a still-mounted drive fails.
	stopErr := Unmount(goos, home)
	if err := stopMount(goos, home); err != nil {
		if stopErr != nil {
			return fmt.Errorf("could not disable the login item (%v), and the mount did not come down: %w", stopErr, err)
		}
		return err
	}
	if stopErr != nil {
		// The mount is down and the login item is about to be deleted, so the
		// only thing the disable error could have been protecting (a login
		// item restarting the drive) is already handled. Note it and continue.
		fmt.Fprintf(os.Stderr, "note: could not disable the login item (%v); it is deleted below, so the drive will not start at the next login\n", stopErr)
	}
	// The login item file survives Unmount (it only unloads/disables), and the
	// rclone config is the key. Remove both; a missing one is not an error.
	for _, path := range []string{LoginItemPath(goos, home), DefaultConfigDir(home)} {
		if err := removeIfPresent(path); err != nil {
			return err
		}
	}
	// The cache holds copies of the person's files and the queue; with the
	// force path chosen (or an empty queue) it goes too.
	if err := removeIfPresent(DefaultCacheDir(home)); err != nil {
		return err
	}
	// Prove the key is gone rather than trust the unlink: the acceptance is
	// "leaves no key or config behind", so a leftover file is a failure.
	if _, err := os.Stat(RcloneConfigPath(home)); err == nil {
		return fmt.Errorf("logout left %s behind", RcloneConfigPath(home))
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("stat %s: %w", RcloneConfigPath(home), err)
	}
	fmt.Printf("logged out: the mount is stopped and %s is deleted\n", DefaultConfigDir(home))
	return nil
}

// stopMount brings the mount point itself down and reports success only once
// the kernel agrees it is gone. The login item's stop (launchctl unload,
// systemctl disable --now) is the normal way and usually enough; a mount
// started by hand, or a login item that lost the race, leaves the FUSE mount
// attached, and "the mount stopped" is this command's promise, not a hope.
// fusermount is the stock FUSE unmount on Linux; macOS unmounts with umount.
func stopMount(goos, home string) error {
	on, err := Mounted(goos, home)
	if err != nil {
		return err
	}
	if !on {
		return nil
	}
	mountDir := DefaultMountDir(home)
	// fusermount3 ships with current FUSE; fusermount is the older name. Each
	// attempt is a fresh command (a started exec.Cmd cannot be run twice).
	attempts := [][]string{{"fusermount3", "-u"}, {"fusermount", "-u"}}
	if goos == "darwin" {
		attempts = [][]string{{"umount"}}
	}
	var lastErr error
	for _, argv := range attempts {
		out, err := exec.Command(argv[0], append(argv[1:], mountDir)...).CombinedOutput()
		if err == nil {
			lastErr = nil
			break
		}
		lastErr = fmt.Errorf("%s: %v: %s", argv[0], err, strings.TrimSpace(string(out)))
	}
	if lastErr != nil {
		return fmt.Errorf("unmount %s: %w", mountDir, lastErr)
	}
	on, err = Mounted(goos, home)
	if err != nil {
		return err
	}
	if on {
		return fmt.Errorf("unmount %s: still mounted after fusermount", mountDir)
	}
	return nil
}

// removeIfPresent removes path recursively, treating "already gone" as the
// success it is (logout is safe to run twice).
func removeIfPresent(path string) error {
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("remove %s: %w", path, err)
	}
	return nil
}

// runLogout is `drive logout`.
func runLogout(args []string) error {
	fs := flag.NewFlagSet("logout", flag.ContinueOnError)
	common := addCommonFlags(fs)
	force := fs.Bool("force", false, "discard files waiting to upload instead of stopping")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	return Logout(CurrentGOOS(), common.home, *force)
}
