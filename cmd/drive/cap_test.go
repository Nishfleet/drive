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
	var gotAmount string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Amount string `json:"amount"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotAmount = body.Amount
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error": `A spending cap is a dollar amount like 20 or 12.50, got "abc". Type a number like that again.`,
		})
	}))
	defer srv.Close()

	err := runCap([]string{"--api", srv.URL, "--home", t.TempDir(), "abc"})
	if err == nil {
		t.Fatal("got no error for a bad amount, want parseCapUsd's reason")
	}
	if gotAmount != "abc" {
		t.Errorf("posted amount = %q, want the typed string so parseCapUsd sees it", gotAmount)
	}
	if !strings.Contains(err.Error(), "A spending cap is a dollar amount like 20 or 12.50") {
		t.Errorf("got %q, want parseCapUsd's reason", err)
	}
	if !strings.Contains(err.Error(), "Type a number like that again") {
		t.Errorf("got %q, want the next-step line parseCapUsd prints", err)
	}
	if strings.Contains(err.Error(), "drive cap") {
		t.Errorf("got %q, want no surface-specific next step", err)
	}
}

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

	_ = runCap([]string{"--api", srv.URL, "--home", home, "--rclone", "/bin/true", "$20"})

	conf, err := os.ReadFile(RcloneConfigPath(home))
	if err != nil {
		t.Fatalf("the restart never wrote the mount config: %v", err)
	}
	if strings.Contains(string(conf), secret) || strings.Contains(string(conf), "secret_access_key") {
		t.Errorf("rclone.conf still carries the storage secret:\n%s", conf)
	}
	got, err := os.ReadFile(RcloneEnvPath(home))
	if err != nil {
		t.Fatalf("the restart never wrote rclone.env: %v", err)
	}
	if !strings.Contains(string(got), secret) {
		t.Errorf("rclone.env does not carry the resolved secret:\n%s", got)
	}
}

func TestRestartMountLeavesTheVFSCache(t *testing.T) {
	home := t.TempDir()
	writeMeta(t, DefaultCacheDir(home), "queued.bin", queuedMeta)

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

func TestRunCapRestartWritesTheWorkersSwappedCredential(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		answer := CapAnswer{CapLine: "Cap $0.00 reached: read-only."}
		reason := "cap-reached"
		answer.Mount.Restart, answer.Mount.Reason = true, &reason
		answer.Credential = &SwapCredential{
			AccessKeyID:  "ro-access-key-id",
			Secret:       "ro-secret",
			SessionToken: "ro-session-token",
		}
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

	t.Setenv("DRIVE_S3_ENDPOINT", "http://127.0.0.1:39181")
	t.Setenv("DRIVE_S3_BUCKET", "drive-standin")
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "stale-write-access-key")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "stale-write-secret")
	t.Setenv("DRIVE_S3_SESSION_TOKEN", "stale-write-session-token")
	t.Setenv("DRIVE_DOWNLOAD_URL", "")

	_ = runCap([]string{"--api", srv.URL, "--home", home, "--rclone", "/bin/true", "0"})

	got, err := os.ReadFile(RcloneConfigPath(home))
	if err != nil {
		t.Fatalf("the restart never wrote the mount config: %v", err)
	}
	config := string(got)
	for _, want := range []string{
		"access_key_id = ro-access-key-id",
		"session_token = ro-session-token",
		"no_check_bucket = true",
	} {
		if !strings.Contains(config, want) {
			t.Errorf("mount config missing %q:\n%s", want, config)
		}
	}
	if strings.Contains(config, "secret_access_key") || strings.Contains(config, "ro-secret") {
		t.Errorf("rclone.conf still carries the storage secret:\n%s", config)
	}
	env, err := os.ReadFile(RcloneEnvPath(home))
	if err != nil {
		t.Fatalf("the restart never wrote rclone.env: %v", err)
	}
	if !strings.Contains(string(env), "ro-secret") {
		t.Errorf("rclone.env missing the swapped secret:\n%s", env)
	}
	if strings.Contains(config, "stale-write-secret") ||
		strings.Contains(config, "stale-write-access-key") ||
		strings.Contains(config, "stale-write-session-token") {
		t.Errorf("mount config still carries the pre-cap key:\n%s", config)
	}
}

func TestRunCapRestartWritesNoSessionTokenWhenTheSwappedKeyHasNone(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		answer := CapAnswer{CapLine: "Cap $20.00: $0.00 counted this month, $20.00 left."}
		reason := "cap-raised"
		answer.Mount.Restart, answer.Mount.Reason = true, &reason
		answer.Credential = &SwapCredential{AccessKeyID: "write-access-key", Secret: "write-secret"}
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
	t.Setenv("DRIVE_S3_ENDPOINT", "http://127.0.0.1:39181")
	t.Setenv("DRIVE_S3_BUCKET", "drive-standin")
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "read-only-access-key")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "read-only-secret")
	t.Setenv("DRIVE_S3_SESSION_TOKEN", "read-only-session-token")
	t.Setenv("DRIVE_DOWNLOAD_URL", "")

	_ = runCap([]string{"--api", srv.URL, "--home", home, "--rclone", "/bin/true", "20"})

	got, err := os.ReadFile(RcloneConfigPath(home))
	if err != nil {
		t.Fatalf("the restart never wrote the mount config: %v", err)
	}
	config := string(got)
	if strings.Contains(config, "secret_access_key") || strings.Contains(config, "write-secret") {
		t.Errorf("rclone.conf still carries the storage secret:\n%s", config)
	}
	env, err := os.ReadFile(RcloneEnvPath(home))
	if err != nil {
		t.Fatalf("the restart never wrote rclone.env: %v", err)
	}
	if !strings.Contains(string(env), "write-secret") {
		t.Errorf("rclone.env does not carry the raised key:\n%s", env)
	}
	if strings.Contains(config, "session_token") {
		t.Errorf("a key with no session token must add no session_token line:\n%s", config)
	}
	if strings.Contains(config, "no_check_bucket") {
		t.Errorf("a permanent key can HeadBucket, so no_check_bucket must stay off:\n%s", config)
	}
}

func TestRunCapRestartRejectsASwappedCredentialThatWouldInjectAnOption(t *testing.T) {
	for _, tc := range []struct {
		name string
		cred SwapCredential
		want string
	}{
		{
			name: "newline in access key",
			cred: SwapCredential{
				AccessKeyID:  "ak\nno_check_certificate = true",
				Secret:       "ro-secret",
				SessionToken: "ro-session-token",
			},
			want: "access key",
		},
		{
			name: "newline in session token",
			cred: SwapCredential{
				AccessKeyID:  "ro-access-key-id",
				Secret:       "ro-secret",
				SessionToken: "tok\nno_check_certificate = true",
			},
			want: "session token",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				answer := CapAnswer{CapLine: "Cap $0.00 reached: read-only."}
				reason := "cap-reached"
				answer.Mount.Restart, answer.Mount.Reason = true, &reason
				cred := tc.cred
				answer.Credential = &cred
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
			t.Setenv("DRIVE_S3_ENDPOINT", "http://127.0.0.1:39181")
			t.Setenv("DRIVE_S3_BUCKET", "drive-standin")
			t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "stale-write-access-key")
			t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "stale-write-secret")
			t.Setenv("DRIVE_S3_SESSION_TOKEN", "stale-write-session-token")
			t.Setenv("DRIVE_DOWNLOAD_URL", "")

			err := runCap([]string{"--api", srv.URL, "--home", home, "--rclone", "/bin/true", "0"})
			if err == nil {
				t.Fatal("got nil error, want the swapped credential refused")
			}
			if !strings.HasPrefix(err.Error(), "restart the mount:") {
				t.Errorf("got %q, want the restart's own prefix", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("got %q, want it to name the %s", err, tc.want)
			}
			if !strings.Contains(err.Error(), "newline or NUL") {
				t.Errorf("got %q, want invalid-config's reason", err)
			}
			if raw, readErr := os.ReadFile(RcloneConfigPath(home)); readErr == nil &&
				strings.Contains(string(raw), "no_check_certificate") {
				t.Errorf("the restart wrote the injected rclone option:\n%s", raw)
			}
		})
	}
}

func TestRunCapReadsTheAPIBaseDriveLoginSaved(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(CapAnswer{CapLine: "Cap $20.00: $0.00 counted this month, $20.00 left."})
	}))
	defer srv.Close()

	home := t.TempDir()
	if err := SaveCredentials(home, Credentials{APIBase: srv.URL, DeviceToken: "dtok_test"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DRIVE_API_URL", "")
	line := captureStdout(t, func() {
		if err := runCap([]string{"--home", home, "20"}); err != nil {
			t.Fatal(err)
		}
	})
	if gotPath != CAP_PATH || !strings.Contains(line, "Cap $20.00") {
		t.Errorf("cap did not reach the saved apiBase: path %q, output %q", gotPath, line)
	}
}
