package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func configOnlyHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(testStorage())), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

// testRevoker is the key store stand-in every logout test that has a config
// file needs, keyed to the pair configOnlyHome writes.
func testRevoker(t *testing.T, home string) *keyServer {
	t.Helper()
	return newKeyServer(t, home, testStorage().AccessKey, testStorage().SecretKey)
}

// storageWithKey returns a copy of the test storage config carrying a specific
// access key id and secret, so a test can write a device's config and stand up
// a key server for that exact pair.
func storageWithKey(accessKey, secret string) StorageConfig {
	c := testStorage()
	c.AccessKey = accessKey
	c.SecretKey = secret
	return c
}

// writeDeviceKey puts a key pair into a home the way a sign-in would, with the
// 0600 mode the CLI itself writes.
func writeDeviceKey(t *testing.T, home, accessKey, secret string) {
	t.Helper()
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(storageWithKey(accessKey, secret))), 0o600); err != nil {
		t.Fatal(err)
	}
}

func configWithLoginItem(t *testing.T) string {
	t.Helper()
	home := configOnlyHome(t)
	item := LoginItemPath("linux", home)
	if err := os.MkdirAll(filepath.Dir(item), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(item, []byte("unit file"), 0o644); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestLogoutDeletesTheKeyAndConfig(t *testing.T) {
	home := configOnlyHome(t)

	if err := Logout("linux", home, false, testRevoker(t, home)); err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{
		RcloneConfigPath(home),
		DefaultConfigDir(home),
		DefaultCacheDir(home),
	} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("%s still exists after logout", gone)
		}
	}
}

func TestLogoutAlsoDeletesTheLoginItemWhenPresent(t *testing.T) {
	home := configWithLoginItem(t)

	if err := Logout("linux", home, false, testRevoker(t, home)); err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{
		RcloneConfigPath(home),
		DefaultConfigDir(home),
		LoginItemPath("linux", home),
		DefaultCacheDir(home),
	} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("%s still exists after logout", gone)
		}
	}
}

func TestLogoutIsSafeToRunTwice(t *testing.T) {
	home := configOnlyHome(t)
	ks := testRevoker(t, home)
	if err := Logout("linux", home, false, ks); err != nil {
		t.Fatal(err)
	}
	// The key is gone, so the second run has nothing to revoke and needs no
	// server: a nil revoker must not turn "nothing to revoke" into a failure.
	if err := Logout("linux", home, false, nil); err != nil {
		t.Fatalf("second logout: %v", err)
	}
	if got := ks.count(); got != 1 {
		t.Errorf("revoke attempts = %d, want exactly 1 (no key is left to revoke)", got)
	}
}

// The headline finding of issue #75: the key must be turned off on the server
// before the local copy is deleted. The stand-in server records whether the
// config file still existed when the revoke arrived, which is the ordering
// proof, not a hope.
func TestLogoutRevokesTheKeyOnTheServerBeforeDeletingIt(t *testing.T) {
	home := configOnlyHome(t)
	ks := testRevoker(t, home)

	if err := Logout("linux", home, false, ks); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if got := ks.count(); got != 1 {
		t.Fatalf("revoke attempts = %d, want 1", got)
	}
	if !ks.sawConfigAtRequestTime() {
		t.Error("the revoke was sent after the local key was deleted; it must be sent while the key is still readable")
	}
	if _, err := os.Stat(RcloneConfigPath(home)); !os.IsNotExist(err) {
		t.Error("the local key must be deleted after the revoke")
	}
}

func TestLogoutSaysTheKeyIsStillLiveWhenTheServerIsUnreachable(t *testing.T) {
	home := configOnlyHome(t)
	// Port 1 on loopback refuses; the revoke cannot get there.
	unreachable := &APIKeyRevoker{BaseURL: "http://127.0.0.1:1"}

	err := Logout("linux", home, false, unreachable)
	if err == nil {
		t.Fatal("logout must fail, not claim a clean sign-out, when the key is still live")
	}
	const sentence = "signed out here; the key is still live, run drive logout again when online"
	if !strings.Contains(err.Error(), sentence) {
		t.Errorf("error %q must say %q plainly", err, sentence)
	}
	if strings.Contains(err.Error(), testStorage().SecretKey) {
		t.Errorf("error %q carries the secret", err)
	}
	// "keeps nothing secret on disk": the local copy still goes.
	if _, statErr := os.Stat(RcloneConfigPath(home)); !os.IsNotExist(statErr) {
		t.Error("the local key must be deleted even when the revoke fails, so nothing secret stays on disk")
	}
}

func TestLogoutWithNoAPIConfiguredNamesThatAndStillCleansUp(t *testing.T) {
	home := configOnlyHome(t)

	err := Logout("linux", home, false, nil)
	if err == nil {
		t.Fatal("a key that cannot be revoked must not read as a clean sign-out")
	}
	if !strings.Contains(err.Error(), "signed out here; the key is still live, run drive logout again when online") {
		t.Errorf("error %q must carry the plain sentence", err)
	}
	if !strings.Contains(err.Error(), "DRIVE_API_URL") {
		t.Errorf("error %q must name what to configure", err)
	}
	if _, statErr := os.Stat(RcloneConfigPath(home)); !os.IsNotExist(statErr) {
		t.Error("the local key must be deleted so nothing secret stays on disk")
	}
}

// A malformed config is not a silent "no key": logout must not claim the key
// is gone when it never learned which key it held.
func TestLogoutNamesAnUnreadableConfigInsteadOfSkippingTheRevoke(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(DefaultConfigDir(home), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(RcloneConfigPath(home), []byte("not a config at all\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := Logout("linux", home, false, testRevoker(t, home))
	if err == nil {
		t.Fatal("an unreadable config must fail logout, not pass as nothing to revoke")
	}
	if !strings.Contains(err.Error(), "still live") {
		t.Errorf("error %q must carry the plain sentence", err)
	}
}

func TestLogoutRefusesToDeleteAQueueThatHasNotGoneUp(t *testing.T) {
	home := configOnlyHome(t)
	writeMeta(t, DefaultCacheDir(home), "queued.bin", queuedMeta)
	ks := testRevoker(t, home)

	err := Logout("linux", home, false, ks)
	if err == nil {
		t.Fatal("got no error with a file waiting to upload, want one")
	}
	if !strings.Contains(err.Error(), "1 file(s) waiting to upload") {
		t.Errorf("got %q, want the pending count named", err)
	}
	if _, statErr := os.Stat(RcloneConfigPath(home)); statErr != nil {
		t.Errorf("the refusal must not delete the key: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(DefaultCacheDir(home), "vfsMeta")); statErr != nil {
		t.Errorf("the refusal must not delete the queued file: %v", statErr)
	}
	// The refusal comes first: a key that stays on disk must not be revoked
	// server-side, or the person would be locked out when the upload resumes.
	if got := ks.count(); got != 0 {
		t.Errorf("revoke attempts = %d, want 0 when logout refuses", got)
	}

	if err := Logout("linux", home, true, ks); err != nil {
		t.Fatalf("--force: %v", err)
	}
	if _, statErr := os.Stat(DefaultCacheDir(home)); !os.IsNotExist(statErr) {
		t.Errorf("the cache is still there after --force logout")
	}
	if got := ks.count(); got != 1 {
		t.Errorf("revoke attempts after --force = %d, want 1", got)
	}
}

// The exit code is part of the acceptance: the honest message alone is not
// enough, the shell must see the failure. This runs the built CLI.
func TestLogoutBinaryExitsNonZeroWhenTheKeyCannotBeRevoked(t *testing.T) {
	home := configOnlyHome(t)
	cmd := exec.Command(driveBin(t), "logout", "--home", home)
	cmd.Env = append(os.Environ(), "DRIVE_API_URL=")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("want a non-zero exit when the key cannot be revoked, got 0 with output:\n%s", out)
	}
	if !strings.Contains(string(out), "signed out here; the key is still live, run drive logout again when online") {
		t.Errorf("output does not say the key is still live:\n%s", out)
	}
	if _, statErr := os.Stat(RcloneConfigPath(home)); !os.IsNotExist(statErr) {
		t.Error("the local key must still be deleted on the failing path")
	}
}

func TestLogoutBinaryExitsZeroWhenTheServerRevokesTheKey(t *testing.T) {
	home := configOnlyHome(t)
	ks := testRevoker(t, home)
	cmd := exec.Command(driveBin(t), "logout", "--home", home, "--api", ks.BaseURL)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("logout --api: %v\n%s", err, out)
	}
	if got := ks.count(); got != 1 {
		t.Errorf("revoke attempts = %d, want 1", got)
	}
	if !strings.Contains(string(out), "the key is revoked on the server") {
		t.Errorf("output does not say the key was revoked:\n%s", out)
	}
}

// TestLogoutStopsALiveMount is the end-to-end proof: a real rclone mount, a
// file written and uploaded, then `drive logout` — after which the mount is
// down, the key is revoked on the stand-in key server and the config is gone.
// It runs in the same namespace trick the mount proof uses, so it skips where
// FUSE is refused rather than failing every PR.
func TestLogoutStopsALiveMount(t *testing.T) {
	if testing.Short() {
		t.Skip("live-mount proof skipped in -short mode")
	}

	root := t.TempDir()
	dataDir := filepath.Join(root, "data", "bucket")
	home := filepath.Join(root, "home")
	mountDir := filepath.Join(home, "Drive")
	for _, d := range []string{dataDir, home, mountDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	port := freePort(t)
	const accessKey, secretKey = "ACCESSKEYID", "SECRETACCESSKEY"
	serve := exec.Command("rclone", "serve", "s3", filepath.Join(root, "data"),
		"--auth-key", accessKey+","+secretKey,
		"--addr", "127.0.0.1:"+port,
		"--log-level", "INFO")
	serve.Stdout, serve.Stderr = os.Stdout, os.Stderr
	if err := serve.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = serve.Process.Kill(); _ = serve.Wait() }()
	waitForPort(t, port)

	// Seed the stand-in so there is something in the drive to read. The seed
	// runs after the server is up and writes through the rclone config the
	// CLI wrote, exactly as the mount proof seeds its own.
	if err := writePatternFile(filepath.Join(dataDir, "seed.bin"), 1<<20); err != nil {
		t.Fatal(err)
	}
	cfg := testStorage()
	cfg.AccessKey = accessKey
	cfg.SecretKey = secretKey
	cfg.Endpoint = "http://127.0.0.1:" + port
	cfg.Bucket = "bucket"
	cfg.Prefix = "u/standin"
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		t.Fatal(err)
	}
	seedEnv := append(os.Environ(),
		"RCLONE_CONFIG="+RcloneConfigPath(home),
	)
	seed := exec.Command("rclone", "copy", filepath.Join(dataDir, "seed.bin"),
		"drive:"+cfg.Bucket+"/"+cfg.Prefix+"/")
	seed.Env = seedEnv
	seed.Stdout, seed.Stderr = os.Stdout, os.Stderr
	if err := seed.Run(); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Start the mount in the foreground so there's no login item to manage;
	// Logout's stopMount will catch and unmount it. The mount uses the default
	// 5s write-back so a write lands quickly. The secret reaches the CLI on
	// stdin, the way the flag it replaced no longer can (issue #75).
	cmd := exec.Command(driveBin(t), "mount",
		"--home", home, "--endpoint", cfg.Endpoint, "--bucket", cfg.Bucket,
		"--prefix", cfg.Prefix, "--access-key", accessKey, "--secret-key-stdin",
		"--foreground")
	cmd.Stdin = strings.NewReader(secretKey + "\n")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := cmd.Process.Signal(os.Interrupt); err != nil {
			t.Logf("signal mount: %v", err)
		}
		done := make(chan struct{})
		go func() { _ = cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	}()

	if !waitForMount(t, cmd, mountDir) {
		t.Skipf("this host does not permit an unprivileged FUSE mount on %s; "+
			"run the proof in a user namespace: unshare -Urm go test ./cmd/drive -run TestLogoutStopsALiveMount", mountDir)
	}

	// Write a file and wait out the 5s write-back so the upload lands. The
	// queue being empty afterwards is what lets `drive logout` refuse
	// nothing; the proof is that a real, finished upload leaves no Dirty
	// metadata behind.
	if err := os.WriteFile(filepath.Join(mountDir, "file.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(8 * time.Second)
	if q, err := PendingUploads(DefaultCacheDir(home)); err != nil {
		t.Fatal(err)
	} else if q.Files != 0 {
		t.Fatalf("the upload did not finish inside the write-back: %d file(s) still queued", q.Files)
	}

	// Now run `drive logout` against the same home, with the key store
	// stand-in as the revoke endpoint. The mount is a foreground rclone
	// process with no login item; Unmount will no-op and stopMount will
	// fusermount it down.
	ks := newKeyServer(t, home, accessKey, secretKey)
	if err := Logout("linux", home, false, ks); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if got := ks.count(); got != 1 {
		t.Errorf("revoke attempts = %d, want 1: logout must turn the key off on the server", got)
	}

	// The mount must be down and the config gone.
	if on, _ := Mounted("linux", home); on {
		t.Fatal("mount still up after logout")
	}
	if _, err := os.Stat(RcloneConfigPath(home)); err == nil {
		t.Fatal("config still present after logout")
	}
	t.Logf("logout revoked the key, stopped the mount and deleted %s", RcloneConfigPath(home))
}

// The issue's own advice is "run drive logout again when online". This proves
// what that run does now: it cannot revoke (the secret went with the key), so
// it must keep saying the key is live and must never print a clean sign-out
// over it. A later logout that does have a key clears the receipt.
func TestLogoutAfterAFailedRevokeNeverClaimsSuccess(t *testing.T) {
	home := configOnlyHome(t)
	unreachable := &APIKeyRevoker{BaseURL: "http://127.0.0.1:1"}

	if err := Logout("linux", home, false, unreachable); err == nil {
		t.Fatal("the first logout must fail when the key cannot be revoked")
	} else if !strings.Contains(err.Error(), revokeWarning) {
		t.Errorf("first failure = %q, want the issue's sentence", err)
	}
	if _, statErr := os.Stat(RcloneConfigPath(home)); !os.IsNotExist(statErr) {
		t.Fatal("the local key must be gone after the failed revoke")
	}
	if ids, err := PendingRevoke(home); err != nil || len(ids) == 0 {
		t.Fatalf("a failed revoke must leave a receipt, or the next run cannot know a key is live (ids=%v, err=%v)", ids, err)
	}

	// The retry, offline or not: no key on this device, so nothing to revoke.
	err := Logout("linux", home, false, nil)
	if err == nil {
		t.Fatal("a retry with a live key and no way to revoke it must not succeed")
	}
	if !strings.Contains(err.Error(), revokePendingWarning) {
		t.Errorf("retry failure = %q, want the receipt sentence", err)
	}
	if strings.Contains(err.Error(), "run drive logout again") {
		t.Errorf("retry failure %q repeats advice this command cannot carry out", err)
	}
	if ids, err := PendingRevoke(home); err != nil || len(ids) == 0 {
		t.Errorf("the receipt must survive the retry so the state is not forgotten (ids=%v, err=%v)", ids, err)
	}

	// A device that signs in again and logs out for real clears it. The key it
	// signs in with is the one the first run left live, so revoking it settles
	// the receipt.
	writeDeviceKey(t, home, testStorage().AccessKey, testStorage().SecretKey)
	if err := Logout("linux", home, false, testRevoker(t, home)); err != nil {
		t.Fatalf("logout with a fresh key: %v", err)
	}
	if ids, err := PendingRevoke(home); err != nil || len(ids) != 0 {
		t.Error("revoking the key the receipt names must clear the receipt")
	}
}

// The receipt names ONE key. Someone whose revoke failed signs in again, which
// gives them a different key, and logs out: that logout revokes the new key and
// settles nothing about the old one, which is still live. The warning has to
// survive it, and the run that revokes the new key must not print a clean
// sign-out either — or the next run reads that success over a live key, the
// exact failure the receipt exists to prevent.
func TestLogoutKeepsTheReceiptWhenTheRevokedKeyIsNotTheOneItNames(t *testing.T) {
	const (
		oldAccess, oldSecret = "OLDACCESSKEY", "oldsecretkey"
		newAccess, newSecret = "NEWACCESSKEY", "newsecretkey"
	)
	home := t.TempDir()
	writeDeviceKey(t, home, oldAccess, oldSecret)

	// The revoke of the old key cannot reach the server.
	if err := Logout("linux", home, false, &APIKeyRevoker{BaseURL: "http://127.0.0.1:1"}); err == nil {
		t.Fatal("the first logout must fail when the key cannot be revoked")
	}
	ids, err := PendingRevoke(home)
	if err != nil || len(ids) != 1 || ids[0] != oldAccess {
		t.Fatalf("receipt after the failed revoke = %v, want the one live id %q (err=%v)", ids, oldAccess, err)
	}

	// The person signs in again: a new key, and a key server that revokes it.
	writeDeviceKey(t, home, newAccess, newSecret)
	ks := newKeyServer(t, home, newAccess, newSecret)
	err = Logout("linux", home, false, ks)
	if got := ks.count(); got != 1 {
		t.Fatalf("revoke attempts = %d, want 1", got)
	}
	// This run did revoke its own key, so the old one is still live and the
	// person must be told so rather than be shown a clean sign-out.
	if err == nil {
		t.Fatal("revoking this device's key does not revoke an older live one: the run must not report success")
	}
	if !strings.Contains(err.Error(), revokePendingWarning) {
		t.Errorf("failure = %q, want the receipt sentence", err)
	}
	ids, err = PendingRevoke(home)
	if err != nil || len(ids) != 1 || ids[0] != oldAccess {
		t.Errorf("the old key is still live, so its receipt must survive a revoke of a different key (ids=%v err=%v)", ids, err)
	}

	// And the run after that must still refuse to call it a clean sign-out.
	if err := Logout("linux", home, false, nil); err == nil {
		t.Fatal("a logout with an older key still live must not succeed")
	} else if !strings.Contains(err.Error(), revokePendingWarning) {
		t.Errorf("failure = %q, want the receipt sentence", err)
	}
}

// Two failures, two live keys. The receipt is a list for this reason: a revoke
// that failed, a sign-in that issued a new key, and a second revoke that failed
// leaves two live, and remembering only the newest would silently forget the
// first.
func TestRevokePendingKeepsEveryKeyThatIsStillLive(t *testing.T) {
	const (
		firstAccess  = "FIRSTACCESSKEY"
		secondAccess = "SECONDACCESSKEY"
	)
	home := t.TempDir()
	unreachable := &APIKeyRevoker{BaseURL: "http://127.0.0.1:1"}

	writeDeviceKey(t, home, firstAccess, "firstsecret")
	if err := Logout("linux", home, false, unreachable); err == nil {
		t.Fatal("the first revoke must fail")
	}
	writeDeviceKey(t, home, secondAccess, "secondsecret")
	if err := Logout("linux", home, false, unreachable); err == nil {
		t.Fatal("the second revoke must fail")
	}

	ids, err := PendingRevoke(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatalf("receipt = %v, want both live keys named", ids)
	}
	if !containsString(ids, firstAccess) || !containsString(ids, secondAccess) {
		t.Errorf("receipt = %v, want it to name %q and %q", ids, firstAccess, secondAccess)
	}
}

// A receipt is 0600 and holds access key ids and nothing else. The secret is
// never in it, and an id alone cannot be replayed against storage.
func TestRevokePendingHoldsOnlyTheAccessKeyID(t *testing.T) {
	home := t.TempDir()
	if ids, err := PendingRevoke(home); err != nil || len(ids) != 0 {
		t.Fatalf("no receipt yet: ids=%v err=%v", ids, err)
	}
	if err := WriteRevokePending(home, "DRIVETESTACCESSKEY"); err != nil {
		t.Fatalf("WriteRevokePending: %v", err)
	}
	ids, err := PendingRevoke(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != "DRIVETESTACCESSKEY" {
		t.Errorf("receipt ids = %v, want just the access key id", ids)
	}
	info, statErr := os.Stat(pendingRevokePath(home))
	if statErr != nil {
		t.Fatal(statErr)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("receipt mode = %o, want 600", perm)
	}
	data, readErr := os.ReadFile(pendingRevokePath(home))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if strings.Contains(string(data), "drivetestsecret") {
		t.Error("the receipt carries key material")
	}
	// The receipt outlives the config dir logout deletes, so it must not live
	// inside it.
	if filepath.Dir(pendingRevokePath(home)) == DefaultConfigDir(home) {
		t.Error("the receipt must not live inside the config dir logout deletes")
	}
}

// A key this device cannot name is still live, and the receipt says so with an
// empty id rather than staying silent. A receipt that cannot be counted must
// never read as a receipt that is empty.
func TestRevokePendingRecordsAKeyThatCouldNotBeNamed(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(DefaultConfigDir(home), 0o700); err != nil {
		t.Fatal(err)
	}
	// A config that is there and unreadable: a key is live, and this device
	// cannot say which.
	if err := os.WriteFile(RcloneConfigPath(home), []byte("not a config at all\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Logout("linux", home, false, testRevoker(t, home)); err == nil {
		t.Fatal("a key that cannot be named must not read as a clean sign-out")
	}
	ids, err := PendingRevoke(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != "" {
		t.Errorf("receipt ids = %q, want one unnamed entry for a key that could not be named", ids)
	}
	// And the next run must still not succeed over it.
	if err := Logout("linux", home, false, nil); err == nil {
		t.Fatal("an unnamed live key must not read as a clean sign-out on the next run either")
	} else if !strings.Contains(err.Error(), revokePendingWarning) {
		t.Errorf("failure = %q, want the receipt sentence", err)
	}
}

// A receipt the run cannot read is a key the run cannot prove is off, so it
// is reported rather than treated as absent.
func TestRevokePendingReportsAnUnreadableReceipt(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads any file, so the unreadable-receipt case cannot be staged")
	}
	home := t.TempDir()
	if err := WriteRevokePending(home, "DRIVETESTACCESSKEY"); err != nil {
		t.Fatal(err)
	}
	// Make the receipt a directory: readable as a path, unreadable as a file.
	if err := os.Remove(pendingRevokePath(home)); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(pendingRevokePath(home), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := PendingRevoke(home); err == nil {
		t.Error("PendingRevoke: err=nil, want the unreadable receipt reported")
	}
}

// The failed-revoke record must have a way out for the realistic case: the
// person revokes the key from the devices page, and the CLI cannot re-check a
// key it no longer holds the secret for. Without this, every later logout fails
// forever with no escape but deleting the file by hand.
func TestLogoutForgetPendingClearsTheRecordAndSaysSo(t *testing.T) {
	home := t.TempDir()
	writeDeviceKey(t, home, "OLDACCESSKEY", "oldsecretkey")
	if err := Logout("linux", home, false, &APIKeyRevoker{BaseURL: "http://127.0.0.1:1"}); err == nil {
		t.Fatal("the revoke must fail against a server that is not there")
	}
	if ids, err := PendingRevoke(home); err != nil || len(ids) != 1 {
		t.Fatalf("receipt after the failed revoke = %v (err=%v), want one live key", ids, err)
	}

	// The CLI must name the escape hatch in the failure it reports.
	err := Logout("linux", home, false, nil)
	if err == nil {
		t.Fatal("a live key must still fail before the record is cleared")
	}
	if !strings.Contains(err.Error(), "--forget-pending") {
		t.Errorf("failure %q does not name the way out", err)
	}

	// The escape hatch itself: it clears the record, prints the ids it cleared,
	// and does not touch the mount or anything else.
	out := captureStdout(t, func() {
		if err := runLogout([]string{"--home", home, "--forget-pending"}); err != nil {
			t.Errorf("logout --forget-pending: %v", err)
		}
	})
	if !strings.Contains(out, "OLDACCESSKEY") {
		t.Errorf("output %q does not name the id it cleared", out)
	}
	if ids, err := PendingRevoke(home); err != nil || len(ids) != 0 {
		t.Errorf("receipt after --forget-pending = %v (err=%v), want it cleared", ids, err)
	}
	// And with the record cleared, a logout with no key at all is a clean
	// sign-out again.
	if err := Logout("linux", home, false, nil); err != nil {
		t.Errorf("logout after the record is cleared: %v", err)
	}

	// Running it with nothing recorded is not an error.
	if err := runLogout([]string{"--home", home, "--forget-pending"}); err != nil {
		t.Errorf("logout --forget-pending with no record: %v", err)
	}
}

// With no key at all, the success line must not be mistakable for a
// revocation: there was nothing to turn off.
func TestLogoutWithoutAKeyDoesNotClaimARevocation(t *testing.T) {
	home := t.TempDir()
	out := captureStdout(t, func() {
		if err := Logout("linux", home, false, nil); err != nil {
			t.Errorf("logout with nothing at all: %v", err)
		}
	})
	if strings.Contains(out, "revoked") {
		t.Errorf("output %q claims a revocation there was no key for", out)
	}
	if !strings.Contains(out, "no key on this device to revoke") {
		t.Errorf("output %q should say there was nothing to revoke", out)
	}
}
