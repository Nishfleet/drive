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

// Logout is `drive logout`: stop the mount, revoke this device's key on the
// server, then delete the key and its local config (issue #75, build-spec.md
// "Commands" — "Unmount, delete this device's key and local config"). Nothing
// outside the CLI's own config and cache directories is touched: the drive
// folder holds the person's files and is never this command's to delete.
//
// The device key is the `access_key_id` / `secret_access_key` pair in
// `~/.config/drive/rclone.conf` (config.go `RcloneConfig`). Deleting that file
// deletes the only local copy; revoke is what turns the copy on the server
// off, and without it a key that was copied off this machine keeps working
// after the person believes they signed out. revoke is the key store
// (drive#2) behind the KeyRevoker interface; revoke_test.go proves this half
// against a test server.
//
// The revoke runs while the config is still readable, and after the mount is
// stopped, so a live upload cannot be cut off mid-file by a key that just went
// off. The order the issue sets is kept: the server is asked first, the local
// copy is deleted second. When the server cannot be reached, the local copy is
// still deleted — "keeps nothing secret on disk" — and the returned error is
// the plain sentence that the key is still live, which main turns into a
// non-zero exit. A clean-looking success is never printed for that case, and
// not on a later run either: a failed revoke leaves a receipt carrying no
// secret (revoke.go pendingRevokePath), and any later logout that finds the
// receipt reports the live key again instead of succeeding over it. That is
// what keeps the issue's own advice — run `drive logout` again when online —
// from being an instruction this command cannot follow: it keeps saying the
// key is live, and points at the devices page, which is where a key nobody
// holds can be turned off.
//
// Files waiting to upload are protected: rclone queues them in the VFS cache
// and does not flush them on stop (measured on this host 2026-09-30 with
// rclone v1.75.1: a file written with `--vfs-write-back 120s` stayed `Dirty:
// true` in the cache after a SIGTERM, and the backend never saw it), so
// deleting the cache would throw the person's work away. Logout refuses to do
// that unless `--force` says so in words, and the refusal happens before the
// key is revoked or deleted, so a refusal leaves the device exactly as it was.
func Logout(goos, home string, force bool, revoke KeyRevoker) error {
	if revoke == nil {
		revoke = noAPIKeyStore{}
	}
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
	// The server is asked while the config still holds the key. A missing
	// config is no key at all, and a receipt from an earlier run that could
	// not revoke is the state that says a key is still live with nothing on
	// this device to reach it with (revoke.go pendingRevokePath): it is
	// reported, not succeeded over. An unreadable config is neither missing
	// nor revocable: it is reported, because a key that cannot be named is a
	// key that may still be live.
	var revokeErr error
	var key *KeyPair
	if pair, err := ReadDeviceKey(home); err != nil {
		revokeErr = err
	} else if pair != nil {
		key = pair
		revokeErr = revoke.Revoke(*pair)
		if revokeErr == nil {
			// The key this device held is off on the server, so a receipt from
			// an earlier failed run is cleared with everything else.
			if err := removeIfPresent(pendingRevokePath(home)); err != nil {
				return err
			}
		}
	} else if RevokePending(home) {
		// Clean-up below still runs; the exit carries the receipt.
		revokeErr = errPendingRevoke
	}
	// The local copy goes even when the revoke failed: the finding is a key
	// left live on the server, and leaving a second copy on disk would be a
	// second one. The exit code and the message below carry the truth about
	// the server side.
	//
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
	// "keeps nothing secret on disk", so a leftover config is a failure.
	if _, err := os.Stat(RcloneConfigPath(home)); err == nil {
		return fmt.Errorf("logout left %s behind", RcloneConfigPath(home))
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("stat %s: %w", RcloneConfigPath(home), err)
	}
	if revokeErr != nil {
		if errors.Is(revokeErr, errPendingRevoke) {
			// The receipt already names this state; rewriting it would say the
			// same thing twice. Non-zero: a key from an earlier logout is still
			// live and this device has nothing to authenticate a revoke with.
			return fmt.Errorf("%s (%w)", revokePendingWarning, revokeErr)
		}
		// local state is gone, server state is not. The receipt is written
		// after the config is gone, so the next run knows a key is live with
		// nothing here to authenticate it. It returns non-zero: a logout that
		// cannot revoke must never look like one that did.
		if err := WriteRevokePending(home); err != nil {
			return fmt.Errorf("%s (%v), and the receipt could not be written: %w", revokeWarning, revokeErr, err)
		}
		return fmt.Errorf("%s (%w)", revokeWarning, revokeErr)
	}
	if key != nil {
		fmt.Printf("logged out: the mount is stopped, the key is revoked on the server and %s is deleted\n", DefaultConfigDir(home))
		return nil
	}
	// Nothing to revoke is a complete logout, but it is not the same event as a
	// revoked key: without a config there is nothing this command could have
	// turned off, and saying exactly that is what keeps a retry from reading
	// as a successful revocation.
	fmt.Printf("logged out: the mount is stopped and %s is deleted; there was no key on this device to revoke\n", DefaultConfigDir(home))
	return nil
}

// ReadDeviceKey reads this device's key out of the rclone config. A missing
// config is no key at all (nil, nil): there is nothing to revoke, and that is
// not an error. A config that cannot be read is an error, not a missing key —
// logout would otherwise print a clean sign-out while a key it could not name
// is still live.
// errPendingRevoke says a receipt from an earlier logout is on file: a key was
// left live and this device no longer holds it.
var errPendingRevoke = errors.New("an earlier logout left a key live; this device no longer has the key to revoke it with")

// ReadDeviceKey reads this device's key out of the rclone config. A missing
// config is no key at all (nil, nil): there is nothing to revoke, and that is
// not an error. A config that cannot be read is an error, not a missing key —
// logout would otherwise print a clean sign-out while a key it could not name
// is still live.
func ReadDeviceKey(home string) (*KeyPair, error) {
	path := RcloneConfigPath(home)
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("stat %s: %w", path, err)
	}
	c, err := ParseRcloneConfig(path)
	if err != nil {
		return nil, err
	}
	return &KeyPair{AccessKeyID: c.AccessKey, SecretKey: c.SecretKey}, nil
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
	// fusermount3 ships with current FUSE; fusermount is the older name. Every
	// call site runs a literal binary name, never a variable, and the only
	// argument is the mount dir (the caller's --home); exec.Command takes an
	// argument vector and no shell.
	if goos == "darwin" {
		if err := runUmount(mountDir); err != nil {
			return fmt.Errorf("unmount %s: %w", mountDir, err)
		}
		return expectUnmounted(goos, home)
	}
	if err := runFusermount(mountDir); err != nil {
		return fmt.Errorf("unmount %s: %w", mountDir, err)
	}
	return expectUnmounted(goos, home)
}

// runUmount unmounts with the stock macOS umount.
func runUmount(mountDir string) error {
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- literal binary "umount"; the only argument is the mount dir derived from --home; exec.Command takes an argument vector, not a shell.
	out, err := exec.Command("umount", mountDir).CombinedOutput()
	return unmountError("umount", err, out)
}

// runFusermount unmounts with the stock Linux FUSE tool: fusermount3 where it
// exists, fusermount otherwise. Each is a literal binary and the only argument
// is the mount dir.
func runFusermount(mountDir string) error {
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- literal binary "fusermount3"; the only argument is the mount dir derived from --home; exec.Command takes an argument vector, not a shell.
	if _, err := exec.Command("fusermount3", "-u", mountDir).CombinedOutput(); err == nil {
		return nil
	}
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- literal binary "fusermount"; the only argument is the mount dir derived from --home; exec.Command takes an argument vector, not a shell.
	out, err := exec.Command("fusermount", "-u", mountDir).CombinedOutput()
	return unmountError("fusermount", err, out)
}

// unmountError turns a failed unmount command into an error with the tool's
// own output, or nil when it exited 0.
func unmountError(name string, err error, out []byte) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %v: %s", name, err, strings.TrimSpace(string(out)))
}

// expectUnmounted re-checks the kernel's answer after an unmount attempt. A
// command that exits 0 is not proof the mount is gone, so this is.
func expectUnmounted(goos, home string) error {
	on, err := Mounted(goos, home)
	if err != nil {
		return err
	}
	if on {
		return fmt.Errorf("unmount %s: still mounted after fusermount", DefaultMountDir(home))
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
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL (env DRIVE_API_URL); the key-revoke endpoint")
	force := fs.Bool("force", false, "discard files waiting to upload instead of refusing")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	return Logout(CurrentGOOS(), common.home, *force, resolveKeyRevoker(*api))
}
