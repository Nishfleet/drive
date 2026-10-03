package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunCapPostsTheAmountAndPrintsTheCapLine(t *testing.T) {
	var gotPath, gotAmount, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("authorization")
		var body struct {
			Amount string `json:"amount"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotAmount = body.Amount
		_ = json.NewEncoder(w).Encode(CapAnswer{CapLine: "Cap $20.00: $0.00 counted this month, $20.00 left."})
	}))
	defer srv.Close()

	home := t.TempDir()
	if err := SaveCredentials(home, Credentials{
		APIBase:     srv.URL,
		DeviceToken: "dtok_test",
		AccountID:   "acct-1",
	}); err != nil {
		t.Fatal(err)
	}

	line := captureStdout(t, func() {
		if err := runCap([]string{"--api", srv.URL, "--home", home, "$20"}); err != nil {
			t.Fatal(err)
		}
	})
	if gotPath != CAP_PATH {
		t.Errorf("posted %s, want %s", gotPath, CAP_PATH)
	}
	if gotAmount != "$20" {
		t.Errorf("amount = %q, want the typed string so parseCapUsd sees it", gotAmount)
	}
	if gotAuth != "Bearer dtok_test" {
		t.Errorf("authorization = %q, want the device token", gotAuth)
	}
	if !strings.Contains(line, "Cap $20.00") {
		t.Errorf("got %q, want the Worker's capLine", line)
	}
}

func TestRunCapPrintsParseCapUsdReasonOnABadAmount(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error": "A spending cap is a dollar amount like 20 or 12.50, got \"abc\". Run: drive cap 20",
		})
	}))
	defer srv.Close()

	err := runCap([]string{"--api", srv.URL, "--home", t.TempDir(), "abc"})
	if err == nil {
		t.Fatal("got no error for a bad amount, want parseCapUsd's reason")
	}
	if !strings.Contains(err.Error(), "A spending cap is a dollar amount like 20 or 12.50") {
		t.Errorf("got %q, want parseCapUsd's reason", err)
	}
	if !strings.Contains(err.Error(), "Run: drive cap 20") {
		t.Errorf("got %q, want the next-step line parseCapUsd prints", err)
	}
}

// A cap swap that needs the mount back up resolves the storage secret the way
// `drive mount` does, from this CLI's own 0600 config file and then the
// environment (issue #75), and it does it at the start of the restart so an
// absent config stops right here. The mount a key was swapped for is never
// started on an empty secret.
func TestRunCapRestartResolvesTheSecretBeforeItRestartsTheMount(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		answer := CapAnswer{CapLine: "Cap $20.00: $0.00 counted this month, $20.00 left."}
		reason := "the write key became read-only"
		answer.Mount.Restart, answer.Mount.Reason = true, &reason
		_ = json.NewEncoder(w).Encode(answer)
	}))
	defer srv.Close()

	home := t.TempDir()
	if err := SaveCredentials(home, Credentials{
		APIBase:     srv.URL,
		DeviceToken: "dtok_test",
		AccountID:   "acct-1",
	}); err != nil {
		t.Fatal(err)
	}

	// /bin/true stands in for rclone: ResolveRclone must succeed so the run
	// reaches the restart. ReadSecretKey finds no config file and DRIVE_S3_*
	// holds nothing, so the request never builds a config and never unmounts.
	t.Setenv("DRIVE_S3_ENDPOINT", "")
	t.Setenv("DRIVE_S3_BUCKET", "")
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "")
	t.Setenv("DRIVE_DOWNLOAD_URL", "")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "")
	err := runCap([]string{"--api", srv.URL, "--home", home, "--rclone", "/bin/true", "$20"})
	if err == nil {
		t.Fatal("got nil error, want one from the restart's own work")
	}
	if !strings.HasPrefix(err.Error(), "restart the mount:") || !strings.Contains(err.Error(), "missing its storage settings") {
		t.Errorf("got %q, want the restart's own missing-config sentence", err)
	}
}

// The success half: the secret the restart resolves reaches the mount. The
// environment is ReadSecretKey's first source (issue #75), so a run with the
// secret exported must write that secret into the rclone config the mount
// reads. A fake rclone stands in for the binary; the restart stops at the
// systemctl request a unit test cannot satisfy, after the config is written,
// so the file is the proof the resolved value reached the mount.
func TestRunCapRestartWritesTheResolvedSecretIntoTheMountConfig(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		answer := CapAnswer{CapLine: "Cap $20.00: $0.00 counted this month, $20.00 left."}
		reason := "the write key became read-only"
		answer.Mount.Restart, answer.Mount.Reason = true, &reason
		_ = json.NewEncoder(w).Encode(answer)
	}))
	defer srv.Close()

	home := t.TempDir()
	if err := SaveCredentials(home, Credentials{
		APIBase:     srv.URL,
		DeviceToken: "dtok_test",
		AccountID:   "acct-1",
	}); err != nil {
		t.Fatal(err)
	}

	const secret = "cap-restart-secret"
	t.Setenv("DRIVE_S3_ENDPOINT", "http://127.0.0.1:39181")
	t.Setenv("DRIVE_S3_BUCKET", "drive-standin")
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "DRIVETESTACCESSKEY")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", secret)
	t.Setenv("DRIVE_DOWNLOAD_URL", "")

	// The error, if any, is the systemctl request this test environment cannot
	// satisfy. The config file, not the error, is the proof.
	_ = runCap([]string{"--api", srv.URL, "--home", home, "--rclone", "/bin/true", "$20"})

	got, err := os.ReadFile(RcloneConfigPath(home))
	if err != nil {
		t.Fatalf("the restart never wrote the mount config: %v", err)
	}
	if !strings.Contains(string(got), "secret_access_key = "+secret) {
		t.Errorf("mount config does not carry the resolved secret:\n%s", got)
	}
}

func TestRestartMountLeavesTheVFSCache(t *testing.T) {
	home := t.TempDir()
	writeMeta(t, DefaultCacheDir(home), "queued.bin", queuedMeta)

	// The stop half of a restart: Unmount an absent login item is a no-op,
	// and it must not delete the cache a queued upload still lives in.
	if err := Unmount("linux", home); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(DefaultCacheDir(home), "vfsMeta")); err != nil {
		t.Fatalf("restart deleted the VFS cache: %v", err)
	}
	src, err := os.ReadFile("mount.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(src), "func RestartMount(") {
		t.Fatal("RestartMount is missing")
	}
	if strings.Contains(string(src), "os.RemoveAll") && strings.Contains(string(src), "DefaultCacheDir") {
		t.Fatal("RestartMount must not delete the VFS cache")
	}
}
