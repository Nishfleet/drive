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
	if !RevokePending(home) {
		t.Fatal("a failed revoke must leave a receipt, or the next run cannot know a key is live")
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
	if !RevokePending(home) {
		t.Error("the receipt must survive the retry so the state is not forgotten")
	}

	// A device that signs in again and logs out for real clears it.
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(testStorage())), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Logout("linux", home, false, testRevoker(t, home)); err != nil {
		t.Fatalf("logout with a fresh key: %v", err)
	}
	if RevokePending(home) {
		t.Error("a successful revoke must clear the receipt")
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
