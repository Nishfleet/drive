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

// TokenRevoker revokes this device's own signed-in device token at the api Worker (DELETE /v1/device/token).
type TokenRevoker interface {
	RevokeDeviceToken() error
}

// AccountRevoker signs the WHOLE account out of every device at once, and is what `drive logout --all` asks for (drive#236, the standalone action `nish3451` resolved in #34: sign out every device, separate from closing the account).
type AccountRevoker interface {
	RevokeAllKeys() error
}

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

// LogoutEveryDevice is `drive logout --all`: sign every device signed in to this account out, then sign this one out locally (drive#236).
func LogoutEveryDevice(goos, home string, force bool, revoker TokenRevoker, revoke KeyRevoker, account AccountRevoker) error {
	if account == nil {
		return fail("signout-everywhere-no-account")
	}
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

// Logout is `drive logout`: stop the mount, revoke this device's key and its device token on the server, then delete the key and its local config (issue #75, build-spec.md "Commands" — "Unmount, delete this device's key and local config").
func Logout(goos, home string, force bool, revoker TokenRevoker, revoke KeyRevoker) error {
	if revoke == nil {
		revoke = noAPIKeyStore{}
	}
	if err := stopLogoutMount(goos, home); err != nil {
		return err
	}
	if err := pendingUploadsRefusal(force, home); err != nil {
		fmt.Fprintf(os.Stderr, "note: the drive is unmounted; waiting files stay in the cache\n")
		return err
	}
	if clearer, ok := revoker.(interface{ ClearQueueReport() error }); ok {
		if err := clearer.ClearQueueReport(); err != nil {
			fmt.Fprintf(os.Stderr, "note: the live queue report could not be cleared: %v\n", err)
		}
	}
	wasLive, receiptErr := PendingRevoke(home)
	var key *KeyPair
	var revokeFailed, keyUnreadable error
	pair, keyErr := ReadDeviceKey(home)
	switch {
	case keyErr != nil:
		keyUnreadable = keyErr
	case pair != nil:
		key = pair
		if err := revoke.Revoke(*pair); err != nil {
			revokeFailed = err
		}
	}
	if revoker != nil {
		if err := revoker.RevokeDeviceToken(); err != nil {
			return fmt.Errorf("revoke the device token: %w", err)
		}
	}
	var removed error
	for _, path := range append(LoginItemFiles(goos, home), DefaultConfigDir(home)) {
		if err := removeIfPresent(path); err != nil {
			removed = errors.Join(removed, err)
		}
	}
	if err := removeIfPresent(DefaultCacheDir(home)); err != nil {
		removed = errors.Join(removed, err)
	}
	if _, err := os.Stat(RcloneConfigPath(home)); err == nil {
		return failf("logout-leftover", RcloneConfigPath(home))
	} else if !errors.Is(err, fs.ErrNotExist) {
		return failDetail("unexpected", fmt.Errorf("stat %s: %w", RcloneConfigPath(home), err))
	}
	var live []string
	if key != nil && revokeFailed == nil {
		live = withoutKeyID(wasLive, key.AccessKeyID)
	} else {
		live = append([]string(nil), wasLive...)
	}
	if revokeFailed != nil {
		live = withKeyID(live, key.AccessKeyID)
	}
	if keyUnreadable != nil || receiptErr != nil {
		live = withKeyID(live, "")
	}
	if len(live) > 0 {
		if err := WriteRevokePending(home, live...); err != nil {
			return fmt.Errorf("%s, and the receipt could not be written: %w",
				revokeSentence(revokeFailed, keyUnreadable, receiptErr), err)
		}
	}
	switch {
	case revokeFailed != nil:
		return failDetail("key-still-live", revokeFailed)
	case len(live) > 0:
		return fail("key-still-live-elsewhere")
	}
	if removed != nil {
		return removed
	}
	if err := removeIfPresent(pendingRevokePath(home)); err != nil {
		fmt.Fprintf(os.Stderr, "note: the key is revoked, but the spent receipt %s could not be deleted: %v\n", pendingRevokePath(home), err)
	}
	if key != nil {
		fmt.Printf("logged out: the mount is stopped, the key is revoked on the server and %s is deleted\n", DefaultConfigDir(home))
		return nil
	}
	fmt.Printf("logged out: the mount is stopped and %s is deleted; there was no key on this device to revoke\n", DefaultConfigDir(home))
	return nil
}

func revokeSentence(errs ...error) string {
	for _, err := range errs {
		if err != nil {
			return fmt.Sprintf("%s (%v)", revokeWarning, err)
		}
	}
	return revokeWarning
}

// ReadDeviceKey reads this device's key out of the rclone config.
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
	if c.AccessKey == "" || c.SecretKey == "" {
		return nil, fmt.Errorf("%s: the [%s] remote needs both an access key id and a secret key to be revoked", path, RcloneRemoteName)
	}
	return &KeyPair{AccessKeyID: c.AccessKey, SecretKey: c.SecretKey}, nil
}

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
		fmt.Fprintf(os.Stderr, "note: the login item could not be disabled; it is deleted below, so the drive will not start at the next login\n")
	}
	return nil
}

func stopMount(goos, home string) error {
	if goos == "windows" {
		return stopWindowsMount(home)
	}
	mountDir := DefaultMountDir(home)
	on, err := Mounted(goos, home)
	if err == nil && !on && !mountDirNotConnected(goos, mountDir) {
		return nil
	}
	stale := err != nil || mountDirNotConnected(goos, mountDir)
	// fusermount3 ships with current FUSE; fusermount is the older name.
	if goos == "darwin" {
		if stale {
			if err := runUmountFlag(mountDir, "-f"); err != nil {
				return fmt.Errorf("unmount %s: %w", mountDir, err)
			}
		} else if err := runUmount(mountDir); err != nil {
			return fmt.Errorf("unmount %s: %w", mountDir, err)
		}
		return expectUnmounted(goos, home)
	}
	if stale {
		if err := runFusermountFlag(mountDir, "-uz"); err != nil {
			return fmt.Errorf("unmount %s: %w", mountDir, err)
		}
	} else if err := runFusermount(mountDir); err != nil {
		return fmt.Errorf("unmount %s: %w", mountDir, err)
	}
	return expectUnmounted(goos, home)
}

func runUmount(mountDir string) error {
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- literal binary "umount"; the only path argument is the mount dir derived from --home; exec.Command takes an argument vector, not a shell.
	if _, err := exec.Command("umount", mountDir).CombinedOutput(); err == nil {
		return nil
	}
	return runUmountFlag(mountDir, "-f")
}

func runUmountFlag(mountDir, umountFlag string) error {
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- literal binary "umount" and literal flag -f; the only path argument is the mount dir derived from --home; exec.Command takes an argument vector, not a shell.
	out, err := exec.Command("umount", umountFlag, mountDir).CombinedOutput()
	return unmountError("umount", err, out)
}

// -uz is lazy so a dead FUSE entry (ENOTCONN) comes down even when a plain -u would block.
func runFusermount(mountDir string) error {
	if err := runFusermountFlag(mountDir, "-u"); err == nil {
		return nil
	}
	return runFusermountFlag(mountDir, "-uz")
}

func runFusermountFlag(mountDir, fuseFlag string) error {
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- literal binary "fusermount3" and literal flag -u or -uz; the only path argument is the mount dir derived from --home; exec.Command takes an argument vector, not a shell.
	if _, err := exec.Command("fusermount3", fuseFlag, mountDir).CombinedOutput(); err == nil {
		return nil
	}
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- literal binary "fusermount" and literal flag -u or -uz; the only path argument is the mount dir derived from --home; exec.Command takes an argument vector, not a shell.
	out, err := exec.Command("fusermount", fuseFlag, mountDir).CombinedOutput()
	return unmountError("fusermount", err, out)
}

func unmountError(name string, err error, out []byte) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %v: %s", name, err, strings.TrimSpace(string(out)))
}

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

func removeIfPresent(path string) error {
	if err := os.RemoveAll(path); err != nil {
		return failDetail("unexpected", fmt.Errorf("remove %s: %w", path, err))
	}
	return nil
}

const signOutEverywhereWarning = `About to sign out EVERY device signed in to this account: every key and every
signed-in session, on this machine and on every other one. The files stay
where they are; each device has to sign in again before it can reach them.
Run drive logout --all --yes to go ahead.`

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
		revoker = client
		account = client
	}
	keyRevoker := resolveKeyRevoker(base)
	if *all {
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
