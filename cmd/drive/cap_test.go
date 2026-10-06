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
			// The Worker's own parseCapUsd() sentence (src/cap.js
			// `capShapeError`). It is the sentence both surfaces read, so it
			// names no command and no page (drive#421).
			"error": `A spending cap is a dollar amount like 20 or 12.50, got "abc". Type a number like that again.`,
		})
	}))
	defer srv.Close()

	err := runCap([]string{"--api", srv.URL, "--home", t.TempDir(), "abc"})
	if err == nil {
		t.Fatal("got no error for a bad amount, want parseCapUsd's reason")
	}
	// The amount goes to the Worker as typed: this CLI holds no second parser
	// that could refuse one the Worker accepts. "$20" is such an amount — the
	// dollar sign is stripped there — so a local fast-fail would break a write
	// the api answers.
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

// The swapped key is what the mount has to sign with, and the Worker is the
// only thing that knows it: the credential is minted server-side (the api
// holds the storage master credential) and never exists on the device until
// the swap response carries it. So a restart has to prefer the answer's
// credential over the secret this CLI already had, and write the session token
// with it — a scoped key signs with all three or storage answers InvalidTokenId
// (measured against the pinned MinIO, issue #241).
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

	// The pre-cap values the CLI already holds. They must NOT reach the config
	// the mount reads after the swap.
	t.Setenv("DRIVE_S3_ENDPOINT", "http://127.0.0.1:39181")
	t.Setenv("DRIVE_S3_BUCKET", "drive-standin")
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "stale-write-access-key")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "stale-write-secret")
	t.Setenv("DRIVE_S3_SESSION_TOKEN", "stale-write-session-token")
	t.Setenv("DRIVE_DOWNLOAD_URL", "")

	// The error, if any, is the systemctl request this test environment cannot
	// satisfy. The config file, not the error, is the proof.
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

// A raise mints a write credential with no session token when the deployment
// uses permanent keys, and then no session_token line must be written at all:
// an empty value would sign with an empty token.
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

// The swapped access key and session token are server-supplied strings written
// into rclone's INI. LoadStorageConfig already refuses a newline in the env
// copies; the restart must refuse the swapped copies the same way, or a
// newline injects an extra rclone option (issue #241 in-run review).
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

// drive#459: after `drive login` and no DRIVE_API_URL, cap reaches the api
// address login saved instead of failing with "That did not work".
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
