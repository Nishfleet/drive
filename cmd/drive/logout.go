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

// TokenRevoker revokes this device's own signed-in device token at the api
// Worker (DELETE /v1/device/token). The pattern mirrors ToolMinter.RevokeKey
// (cmd/drive/agents.go): the server-side revoke happens first, so a failed
// revoke leaves a token that still works rather than a token nothing can
// revoke. An already-dead token (401) is the state logout wants, so it is a
// note and not a failure.
type TokenRevoker interface {
	RevokeDeviceToken() error
}

// Logout is `drive logout`: stop the mount, revoke this device's key and its
// device token on the server, then delete the key and its local config
// (issue #75, build-spec.md "Commands" — "Unmount, delete this device's key
// and local config"). Nothing outside the CLI's own config and cache
// directories is touched: the drive folder holds the person's files and is
// never this command's to delete.
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
// The device token (api.go Credentials) is revoked after the storage key: it
// is revoked over the signed-in client, not the key pair. A token revoke that
// fails stops the logout with the local files intact (the #176 pattern), so
// the person can retry; a token revoke that answers 401 is a token that is
// already dead, which is the state logout wants.
//
// Files waiting to upload are protected: rclone queues them in the VFS cache
// and does not flush them on stop (measured on this host 2026-09-30 with
// rclone v1.75.1: a file written with `--vfs-write-back 120s` stayed `Dirty:
// true` in the cache after a SIGTERM, and the backend never saw it), so
// deleting the cache would throw the person's work away. Logout refuses to do
// that unless `--force` says so in words, and the refusal happens before the
// key is revoked or deleted, so a refusal leaves the device exactly as it was.
func Logout(goos, home string, force bool, revoker TokenRevoker, revoke KeyRevoker) error {
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
	//
	// What is on file is read first, and this run's revoke is folded into it
	// rather than replacing it. That is the whole reason the receipt records
	// access key ids: a receipt says which keys are still live, so revoking one
	// key settles nothing about another, and a later logout that holds a
	// different key — someone who signed in again got a new one — must not be
	// able to read this run's success as having turned the older one off.
	wasLive, receiptErr := PendingRevoke(home)
	var key *KeyPair
	var revokeFailed, keyUnreadable error
	pair, keyErr := ReadDeviceKey(home)
	switch {
	case keyErr != nil:
		// The config is there but not usable: a mode fault or a parse fault.
		// This device does not know which key it holds, so no revoke is
		// attempted and a key that is probably live is recorded as unnamed.
		keyUnreadable = keyErr
	case pair != nil:
		key = pair
		if err := revoke.Revoke(*pair); err != nil {
			revokeFailed = err
		}
	}
	// The device token goes second, while the credentials file it authenticates
	// with is still on disk. A 401 is an already-dead token and answers nil
	// inside the client. A real failure stops the logout here, with the files
	// intact, because the token can re-present itself (issue #176's pattern).
	if revoker != nil {
		if err := revoker.RevokeDeviceToken(); err != nil {
			return fmt.Errorf("revoke the device token: %w", err)
		}
	}
	// The local key copy goes even when the storage-key revoke failed: the
	// finding is a key left live on the server, and leaving a second copy on
	// disk would be a second one. The exit code and the message below carry
	// the truth about the server side.
	//
	// This deletion is unconditional and comes before any further receipt work,
	// because the acceptance is that a logout keeps nothing secret on disk. A
	// receipt that cannot be written or cleared is a fact to report on the way
	// out, and never a reason to leave the storage key on the disk it was
	// trying to remove.
	//
	// The login item file survives Unmount (it only unloads/disables), and the
	// rclone config is the key. Remove both; a missing one is not an error.
	//
	// Both are attempted before either error is returned, because the second
	// one is the storage secret and the first is not: stopping at the first
	// failure would leave the key on the disk this command was run to clear,
	// with the key already dead on the server. The error is still returned, so
	// nothing is hidden — it just no longer buys a leftover.
	var removed error
	for _, path := range []string{LoginItemPath(goos, home), DefaultConfigDir(home)} {
		if err := removeIfPresent(path); err != nil {
			removed = errors.Join(removed, err)
		}
	}
	// The cache holds copies of the person's files and the queue; with the
	// force path chosen (or an empty queue) it goes too.
	if err := removeIfPresent(DefaultCacheDir(home)); err != nil {
		removed = errors.Join(removed, err)
	}
	// Prove the key is gone rather than trust the unlink: the acceptance is
	// "keeps nothing secret on disk", so a leftover config is a failure.
	if _, err := os.Stat(RcloneConfigPath(home)); err == nil {
		return errors.Join(removed, fmt.Errorf("logout left %s behind", RcloneConfigPath(home)))
	} else if !errors.Is(err, fs.ErrNotExist) {
		return errors.Join(removed, fmt.Errorf("stat %s: %w", RcloneConfigPath(home), err))
	}
	// What the person is told is decided by what is left live, not by this run's
	// own revoke. The record is folded forward after the config is gone — so the
	// next run knows which keys are live with nothing here to authenticate them
	// — and the exit is non-zero whenever anything survives on it. A logout that
	// cannot turn off every key it is responsible for must never look like one
	// that did.
	var live []string
	// A key this run turned off is not live and leaves the record.
	if key != nil && revokeFailed == nil {
		live = withoutKeyID(wasLive, key.AccessKeyID)
	} else {
		live = append([]string(nil), wasLive...)
	}
	if revokeFailed != nil {
		// The key this device held is still live on the server, and this run
		// knows exactly which one: its access key id.
		live = withKeyID(live, key.AccessKeyID)
	}
	if keyUnreadable != nil || receiptErr != nil {
		// Either a key this device cannot name, or a receipt this run cannot
		// read, and both mean a key that may be live and cannot be recorded by
		// id. The empty id is that admission: a receipt that cannot be counted
		// is never the same as a receipt that is empty.
		live = withKeyID(live, "")
	}
	if len(live) > 0 {
		if err := WriteRevokePending(home, live...); err != nil {
			// Both causes, so the person is not left with "<nil>" for the one
			// that matters. The write error is wrapped, so it is matchable.
			return fmt.Errorf("%s, and the receipt could not be written: %w",
				revokeSentence(revokeFailed, keyUnreadable, receiptErr), err)
		}
	}
	switch {
	case revokeFailed != nil:
		// This device's own key is live and still has its secret on this
		// machine, so this is the acceptance sentence of issue #75.
		return fmt.Errorf("%s (%w)", revokeWarning, revokeFailed)
	case len(live) > 0:
		// Nothing this run held is live, but the record says something is: a
		// key from an earlier logout, or one this run could not name. The
		// success line would be a lie about the whole of it, so the live-key
		// sentence is what reaches the person instead.
		return errors.New(revokePendingWarning)
	}
	if removed != nil {
		// Nothing is live and nothing secret is on disk any more, so this is
		// not a security failure; it is a file that outlived its own removal.
		// Saying it costs nothing and hiding it would be worse.
		return removed
	}
	if err := removeIfPresent(pendingRevokePath(home)); err != nil {
		// Nothing is left live, so the sign-out succeeded; a spent receipt this
		// run cannot delete is reported rather than hidden, because the next
		// run would otherwise report it with no trace of why.
		fmt.Fprintf(os.Stderr, "note: the key is revoked, but the spent receipt %s could not be deleted: %v\n", pendingRevokePath(home), err)
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

// revokeSentence names, in one line, whichever of this run's faults has to
// reach the person with a receipt that could not be written. It never returns
// an empty string and never prints a nil error: a cause that does not exist is
// not a reason to write "<nil>" next to the sentence that matters.
func revokeSentence(errs ...error) string {
	for _, err := range errs {
		if err != nil {
			return fmt.Sprintf("%s (%v)", revokeWarning, err)
		}
	}
	return revokeWarning
}

// ReadDeviceKey reads this device's key out of the rclone config. A missing
// config is no key at all (nil, nil): there is nothing to revoke, and that is
// not an error. A config that cannot be read is an error, not a missing key —
// logout would otherwise print a clean sign-out while a key it could not name
// is still live. The mode rule is inside the parser, so a key this device is
// about to send on the wire has already been checked not to be readable by
// every user on the machine.
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
	// The parser reports what the file carries, so this is where a half-written
	// config is refused: a key id with no secret cannot be revoked, and a secret
	// with no id names no key.
	if c.AccessKey == "" || c.SecretKey == "" {
		return nil, fmt.Errorf("%s: the [%s] remote needs both an access key id and a secret key to be revoked", path, RcloneRemoteName)
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
	force := fs.Bool("force", false, "discard files waiting to upload instead of stopping")
	forgetPending := fs.Bool("forget-pending", false, "clear the failed-revoke record after you revoked the key on the devices page")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if *forgetPending {
		// This one does not mount, revoke or delete anything: it is the
		// acknowledgement that a key recorded as live has been turned off
		// elsewhere. It prints what it cleared, so the person can see the ids
		// the CLI could not check for itself.
		ids, err := ForgetPendingRevokes(common.home)
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			fmt.Println("no failed-revoke record to clear")
			return nil
		}
		fmt.Printf("cleared the failed-revoke record for %s; a later drive logout reports them as still live only if another revoke fails\n", NamedKeyIDs(ids))
		return nil
	}
	// Load credentials to find the api Worker base and the device token. If the
	// file is absent or has no token, there is nothing to revoke; a missing file
	// is the "not signed in" case, not an error.
	var revoker TokenRevoker
	creds, _ := LoadCredentials(common.home)
	if creds.DeviceToken != "" && creds.APIBase != "" {
		client, err := NewAPIClient(creds.APIBase, creds.DeviceToken)
		if err != nil {
			return fmt.Errorf("build api client: %w", err)
		}
		revoker = client
	}
	return Logout(CurrentGOOS(), common.home, *force, revoker, resolveKeyRevoker(*api))
}
