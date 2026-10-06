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

// AccountRevoker signs the WHOLE account out of every device at once, and is
// what `drive logout --all` asks for (drive#236, the standalone action
// `nish3451` resolved in #34: sign out every device, separate from closing the
// account). It is its own interface, not another method on TokenRevoker,
// because it is not about this device's token: it is the route behind the
// account gate that revokes every key and every token the gate resolved, so the
// two revokes are not two views of one credential and one cannot stand in for
// the other. A CLI half can be handed the one and not the other — the account
// store is not configured — and that has to be a state it can report, not a
// silent skip.
type AccountRevoker interface {
	RevokeAllKeys() error
}

// The pending-uploads refusal, factored out of Logout so `drive logout --all`
// can ask the same question first (pendingUploadsRefusal). The account-wide
// revoke cannot run before this answer is known: it turns off every key on the
// account, this device's included, so asking afterwards would leave a person
// who has files still queued with a machine that can no longer upload them and
// a command that then refuses to clear the queue. Refuse first, revoke second.
//
// With force the queue is the person's call to discard, exactly as in Logout,
// and the answer here is nil so the account-wide revoke proceeds to the same
// judgement Logout makes.
func pendingUploadsRefusal(force bool, home string) error {
	pending, err := PendingUploads(DefaultCacheDir(home))
	if err != nil {
		return failDetail("queue-unreadable", err, DefaultCacheDir(home))
	}
	if pending.Files > 0 && !force {
		return failf("uploads-stuck", fmt.Sprint(pending.Files), fmt.Sprint(pending.Bytes))
	}
	return nil
}

// LogoutEveryDevice is `drive logout --all`: sign every device signed in to
// this account out, then sign this one out locally (drive#236).
//
// The order is the whole design. The upload queue is checked FIRST, because the
// account-wide revoke takes this device's key with it like any other and a
// command that asked afterwards would kill the device's upload path before it
// had looked. Then the account-wide revoke runs while the credentials file that
// holds the token is still on disk, and only then does Logout do its own local
// work: stop the mount, ask the server about this device's key and token again
// (both answer "already dead" and both are read as the state logout wants),
// and delete the local config.
//
// Two failures are refused rather than worked around, and both leave this
// device exactly as it was:
//
//   - No account revoker at all is "there is no signed-in account here", not a
//     local-only logout. Running it as a plain `drive logout` would sign this
//     machine out and leave every other device live, which is the opposite of
//     what --all means.
//   - An account-wide revoke that fails stops the command before Logout runs.
//     The account is unchanged, so the local half would print a clean sign-out
//     over an account that is still signed in on every other device.
//
// The confirm step is not here: it belongs to the command line (runLogout),
// which is the only place that knows whether the person said yes. This function
// is the work, and taking an unconfirmed argument to a function would put the
// gate one layer away from the person who typed the flags.
func LogoutEveryDevice(goos, home string, force bool, revoker TokenRevoker, revoke KeyRevoker, account AccountRevoker) error {
	if account == nil {
		return fail("signout-everywhere-no-account")
	}
	// Stop this device's mount before counting dirty files, so a save in the
	// window between the count and the stop cannot vanish with the cache.
	if err := stopLogoutMount(goos, home); err != nil {
		return err
	}
	if err := pendingUploadsRefusal(force, home); err != nil {
		fmt.Fprintf(os.Stderr, "note: the drive is unmounted; waiting files stay in the cache\n")
		return err
	}
	if err := account.RevokeAllKeys(); err != nil {
		return failDetail("signout-everywhere-failed", err)
	}
	return Logout(goos, home, force, revoker, revoke)
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
	// Stop the mount first, then count dirty files. A save that lands after
	// the count and before the stop used to vanish with the cache. With the
	// mount already down, the count is the whole remaining queue.
	if err := stopLogoutMount(goos, home); err != nil {
		return err
	}
	// The same question `drive logout --all` asks before it revokes the account
	// (pendingUploadsRefusal), asked through the one helper so the two answers
	// cannot drift. A refusal here keeps the cache: the files are still queued
	// and the key is still live, so the person can mount again and let them up.
	if err := pendingUploadsRefusal(force, home); err != nil {
		fmt.Fprintf(os.Stderr, "note: the drive is unmounted; waiting files stay in the cache\n")
		return err
	}
	if clearer, ok := revoker.(interface{ ClearQueueReport() error }); ok {
		if err := clearer.ClearQueueReport(); err != nil {
			fmt.Fprintf(os.Stderr, "note: the live queue report could not be cleared: %v\n", err)
		}
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
	for _, path := range append(LoginItemFiles(goos, home), DefaultConfigDir(home)) {
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
		return failf("logout-leftover", RcloneConfigPath(home))
	} else if !errors.Is(err, fs.ErrNotExist) {
		return failDetail("unexpected", fmt.Errorf("stat %s: %w", RcloneConfigPath(home), err))
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
		return failDetail("key-still-live", revokeFailed)
	case len(live) > 0:
		// Nothing this run held is live, but the record says something is: a
		// key from an earlier logout, or one this run could not name. The
		// success line would be a lie about the whole of it, so the live-key
		// sentence is what reaches the person instead.
		return fail("key-still-live-elsewhere")
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
	if c.SecretKey == "" {
		if secret, envErr := secretFromEnvFile(RcloneEnvPath(home)); envErr != nil {
			return nil, envErr
		} else {
			c.SecretKey = secret
		}
	}
	// The parser reports what the file carries, so this is where a half-written
	// config is refused: a key id with no secret cannot be revoked, and a secret
	// with no id names no key.
	if c.AccessKey == "" || c.SecretKey == "" {
		return nil, fmt.Errorf("%s: the [%s] remote needs both an access key id and a secret key to be revoked", path, RcloneRemoteName)
	}
	return &KeyPair{AccessKeyID: c.AccessKey, SecretKey: c.SecretKey}, nil
}

// stopLogoutMount brings the login item and the mount point down before logout
// counts dirty files or deletes anything. Unmount stops the login item;
// stopMount then makes sure the mount point itself is down. Unmount can
// legitimately fail to disable a login item that was never installed
// (systemctl exits 1 with "Unit file ... does not exist"), and that failure is
// not fatal to logout: the login item file is deleted later, so it cannot come
// back at the next login, and stopMount proves the mount is gone. So the end
// state is measured, not the exit code: only a still-mounted drive fails.
func stopLogoutMount(goos, home string) error {
	stopErr := Unmount(goos, home)
	if err := stopMount(goos, home); err != nil {
		mountDir := DefaultMountDir(home)
		if stopErr != nil {
			return failDetail("unmount-failed",
				fmt.Errorf("could not disable the login item (%v), and the mount did not come down: %w", stopErr, err),
				mountDir)
		}
		return failDetail("unmount-failed", err, mountDir)
	}
	if stopErr != nil {
		// The mount is down and the login item is about to be deleted, so the
		// only thing the disable error could have been protecting (a login
		// item restarting the drive) is already handled. Note it and continue.
		fmt.Fprintf(os.Stderr, "note: the login item could not be disabled; it is deleted below, so the drive will not start at the next login\n")
	}
	return nil
}

// stopMount brings the mount point itself down and reports success only once
// the kernel agrees it is gone. The login item's stop (launchctl unload,
// systemctl disable --now) is the normal way and usually enough; a mount
// started by hand, or a login item that lost the race, leaves the FUSE mount
// attached, and "the mount stopped" is this command's promise, not a hope.
// fusermount is the stock FUSE unmount on Linux; macOS unmounts with umount.
func stopMount(goos, home string) error {
	if goos == "windows" {
		return stopWindowsMount(home)
	}
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
		return failf("unmount-failed", DefaultMountDir(home))
	}
	return nil
}

// removeIfPresent removes path recursively, treating "already gone" as the
// success it is (logout is safe to run twice).
func removeIfPresent(path string) error {
	if err := os.RemoveAll(path); err != nil {
		return failDetail("unexpected", fmt.Errorf("remove %s: %w", path, err))
	}
	return nil
}

// signOutEverywhereWarning is what `drive logout --all` prints before it asks
// for --yes. It is the whole confirm step: `--all` on its own says exactly what
// would happen and changes nothing, and only `--yes` goes on. The words name
// every device, this one included, because the thing a person must weigh is not
// "my key dies" (they asked to log out) but "the laptop in my bag stops
// working" — the cost of running this by accident, and the reason it is not one
// keystroke away on the way to an ordinary logout.
const signOutEverywhereWarning = `About to sign out EVERY device signed in to this account: every key and every
signed-in session, on this machine and on every other one. The files stay
where they are; each device has to sign in again before it can reach them.
Run drive logout --all --yes to go ahead.`

// runLogout is `drive logout`.
func runLogout(args []string) error {
	fs := flag.NewFlagSet("logout", flag.ContinueOnError)
	common := addCommonFlags(fs)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL (env DRIVE_API_URL); the key-revoke endpoint")
	force := fs.Bool("force", false, "discard files waiting to upload instead of stopping")
	forgetPending := fs.Bool("forget-pending", false, "clear the failed-revoke record after you revoked the key on the devices page")
	all := fs.Bool("all", false, "sign out every device signed in to this account, not just this one (asks for --yes)")
	yes := fs.Bool("yes", false, "answer yes to --all's confirm step")
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
	var account AccountRevoker
	creds, _ := LoadCredentials(common.home)
	base, err := resolveAPIBase(common.home, *api)
	if err != nil {
		return err
	}
	if creds.DeviceToken != "" && base != "" {
		client, err := NewAPIClient(base, creds.DeviceToken)
		if err != nil {
			return err
		}
		// One client, both seams: the account-wide revoke and this device's own
		// token revoke are the same token against the same api Worker, and
		// holding two clients would mean two credentials for one account.
		revoker = client
		account = client
	}
	// The storage-key revoker is built from the RESOLVED base, not from the
	// raw --api flag. `drive login` writes the api address into the credentials
	// file, so a person who signed in once has no DRIVE_API_URL in their
	// environment and passes no --api; handing that empty string to the revoker
	// answered every revoke with "set --api or DRIVE_API_URL" (noAPIKeyStore),
	// which is how a device whose sign-in had already lapsed signed out with
	// its key still live on the server (drive#557). The key revoke is
	// authenticated with the key pair itself and never with the device token,
	// so it works for an expired token; it only ever needed the address, and
	// the address the person signed in to is the one above.
	keyRevoker := resolveKeyRevoker(base)
	if *all {
		// The confirm step, and it is a step: `--all` says what it would do
		// and stops, so an account-wide revoke can never be one keystroke away
		// on the way to an ordinary logout. The words are the account-wide ones
		// on purpose — "every device", including the laptop in the bag — because
		// the cost of running it by accident is every other signed-in machine
		// needing to sign in again, and the cost of not saying so is that
		// surprise. --yes is the answer; there is no prompt to mistype.
		if !*yes {
			fmt.Println(signOutEverywhereWarning)
			return fail("signout-everywhere-unconfirmed")
		}
		return LogoutEveryDevice(CurrentGOOS(), common.home, *force, revoker, keyRevoker, account)
	}
	if *yes {
		return fail("confirm-without-all")
	}
	return Logout(CurrentGOOS(), common.home, *force, revoker, keyRevoker)
}
