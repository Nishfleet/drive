package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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

	if err := Logout("linux", home, false, nil); err != nil {
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

	if err := Logout("linux", home, false, nil); err != nil {
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
	if err := Logout("linux", home, false, nil); err != nil {
		t.Fatal(err)
	}
	if err := Logout("linux", home, false, nil); err != nil {
		t.Fatalf("second logout: %v", err)
	}
}

func TestLogoutRefusesToDeleteAQueueThatHasNotGoneUp(t *testing.T) {
	home := configOnlyHome(t)
	writeMeta(t, DefaultCacheDir(home), "queued.bin", queuedMeta)

	err := Logout("linux", home, false, nil)
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

	if err := Logout("linux", home, true, nil); err != nil {
		t.Fatalf("--force: %v", err)
	}
	if _, statErr := os.Stat(DefaultCacheDir(home)); !os.IsNotExist(statErr) {
		t.Errorf("the cache is still there after --force logout")
	}
}

// TestLogoutStopsALiveMount is the end-to-end proof: a real rclone mount, a
// file written and uploaded, then `drive logout` — after which the mount is
// down and the config is gone. It runs in the same namespace trick the mount
// proof uses, so it skips where FUSE is refused rather than failing every PR.
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
	// 5s write-back so a write lands quickly. The keys go to the child through
	// the environment, never argv (a command line is world-readable in `ps`).
	cmd := exec.Command(driveBin(t), "mount",
		"--home", home, "--endpoint", cfg.Endpoint, "--bucket", cfg.Bucket,
		"--prefix", cfg.Prefix, "--foreground")
	cmd.Env = append(os.Environ(),
		"DRIVE_S3_ACCESS_KEY_ID="+accessKey,
		"DRIVE_S3_SECRET_ACCESS_KEY="+secretKey,
	)
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

	// Now run `drive logout` against the same home. The mount is a foreground
	// rclone process with no login item; Unmount will no-op and stopMount
	// will fusermount it down.
	if err := Logout("linux", home, false, nil); err != nil {
		t.Fatalf("logout: %v", err)
	}

	// The mount must be down and the config gone.
	if on, _ := Mounted("linux", home); on {
		t.Fatal("mount still up after logout")
	}
	if _, err := os.Stat(RcloneConfigPath(home)); err == nil {
		t.Fatal("config still present after logout")
	}
	t.Logf("logout stopped the mount and deleted %s", RcloneConfigPath(home))
}

// fakeTokenRevoker records whether RevokeDeviceToken was called, and what
// error it returned. It is the test's stand-in for the api Worker's DELETE
// /v1/device/token route.
type fakeTokenRevoker struct {
	err    error
	called bool
}

func (f *fakeTokenRevoker) RevokeDeviceToken() error {
	f.called = true
	return f.err
}

// orderedRevoker wraps a fakeTokenRevoker and asserts the credentials file is
// still on disk when the revoke is invoked, proving the server-side revoke
// happens before the local credentials are removed.
type orderedRevoker struct {
	fake *fakeTokenRevoker
	home string
	t    *testing.T
}

func (o *orderedRevoker) RevokeDeviceToken() error {
	o.t.Helper()
	if _, err := os.Stat(CredentialsPath(o.home)); err != nil {
		o.t.Errorf("credentials file must still exist when the revoker runs: %v", err)
	}
	return o.fake.RevokeDeviceToken()
}

// TestLogoutRevokesTheDeviceTokenServerSideBeforeTheFileGoes proves the
// three behaviours issue #176 asks for: (1) logout calls the api Worker to
// revoke the device token before it deletes the local credentials file, (2) a
// token that is already dead (401) is a note, not a failure, and (3) a real
// failure leaves the local files intact so the person can retry.
func TestLogoutRevokesTheDeviceTokenServerSideBeforeTheFileGoes(t *testing.T) {
	writeCreds := func(t *testing.T, home string) {
		creds := Credentials{APIBase: "https://api.test", DeviceToken: "test-token"}
		data, _ := json.MarshalIndent(creds, "", "  ")
		if err := WriteFileAtomic(CredentialsPath(home), append(data, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	// 1. Success: revoke runs while the credentials file is still present,
	// then the files are removed.
	home := configOnlyHome(t)
	writeCreds(t, home)
	revoker := &fakeTokenRevoker{}
	revoker.called = false
	ordered := &orderedRevoker{fake: revoker, home: home, t: t}
	if err := Logout("linux", home, false, ordered); err != nil {
		t.Fatalf("logout with successful revoke: %v", err)
	}
	if !revoker.called {
		t.Fatal("revoke was not called")
	}
	for _, gone := range []string{
		RcloneConfigPath(home),
		DefaultConfigDir(home),
		DefaultCacheDir(home),
	} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("%s still exists after logout with successful revoke", gone)
		}
	}

	// 2. A 401 (already dead) is a note, not a failure: build a real client
	// against a tiny server so the client's own 401 handling is exercised.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/v1/device/token" {
			http.Error(w, "not the revoke route", http.StatusBadRequest)
			return
		}
		if got := r.Header.Get("authorization"); got != "Bearer test-token" {
			http.Error(w, "bad bearer: "+got, http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	home2 := configOnlyHome(t)
	creds := Credentials{APIBase: server.URL, DeviceToken: "test-token"}
	data, _ := json.MarshalIndent(creds, "", "  ")
	if err := WriteFileAtomic(CredentialsPath(home2), append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := NewAPIClient(creds.APIBase, creds.DeviceToken)
	if err != nil {
		t.Fatalf("build client: %v", err)
	}
	if err := Logout("linux", home2, false, client); err != nil {
		t.Fatalf("logout with 401 must not fail: %v", err)
	}
	for _, gone := range []string{
		RcloneConfigPath(home2),
		DefaultConfigDir(home2),
		DefaultCacheDir(home2),
	} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("%s still exists after logout with 401", gone)
		}
	}

	// 3. A real error (not 401) stops logout and leaves the local files,
	// so the person can retry.
	home3 := configOnlyHome(t)
	writeCreds(t, home3)
	revoker3 := &fakeTokenRevoker{err: fmt.Errorf("500 Internal Server Error")}
	if err := Logout("linux", home3, false, revoker3); err == nil {
		t.Fatal("logout with 500 must fail")
	} else if !strings.Contains(err.Error(), "revoke the device token") {
		t.Fatalf("want the revoke error wrapped, got %v", err)
	}
	for _, present := range []string{
		RcloneConfigPath(home3),
		DefaultConfigDir(home3),
	} {
		if _, err := os.Stat(present); err != nil {
			t.Errorf("%s was deleted but logout failed: %v", present, err)
		}
	}
}
