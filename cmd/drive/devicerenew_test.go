package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNeedsDeviceRenewAtEightyPercent(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	const ttl int64 = 900
	expires := now.Unix() + ttl
	if needsDeviceRenew(expires, ttl, now) {
		t.Fatal("a session just minted must not renew yet")
	}
	at80 := now.Add(time.Duration(float64(ttl)*deviceKeyRenewFraction) * time.Second)
	if !needsDeviceRenew(expires, ttl, at80) {
		t.Fatal("at 80 percent of the session the key must renew")
	}
	before := now.Add(time.Duration(float64(ttl)*deviceKeyRenewFraction)*time.Second - time.Second)
	if needsDeviceRenew(expires, ttl, before) {
		t.Fatal("one second before 80 percent must still wait")
	}
	if needsDeviceRenew(0, ttl, now) {
		t.Fatal("a key with no expiry never needs a renew")
	}
	if !needsDeviceRenew(now.Unix()-1, ttl, now) {
		t.Fatal("a session that already ended must renew")
	}
}

func TestLoginAcceptsAnExpiringDeviceKey(t *testing.T) {
	api := newFakeAPI()
	api.deviceExpiresIn = 900
	server := httptest.NewServer(api)
	t.Cleanup(server.Close)
	home := t.TempDir()
	origOpen := openURL
	openURL = func(string) error { return nil }
	t.Cleanup(func() { openURL = origOpen })
	api.approved["dev_secret"] = true

	if err := Login(home, server.URL, "", io.Discard); err != nil {
		t.Fatal(err)
	}
	creds, err := LoadCredentials(home)
	if err != nil {
		t.Fatal(err)
	}
	if creds.KeyExpiresAt == 0 {
		t.Fatal("login refused to store the mint's expiry")
	}
	if creds.KeyTTLSeconds != 900 {
		t.Fatalf("key TTL = %d, want 900 from expiresIn", creds.KeyTTLSeconds)
	}
	cfg, err := ParseRcloneConfig(RcloneConfigPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SessionToken == "" {
		t.Fatal("login did not write the session token into rclone.conf")
	}
}

func TestApplyDeviceCredentialRewritesRcloneConfAndLeavesTheCache(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(DefaultConfigDir(home), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(DefaultCacheDir(home), 0o700); err != nil {
		t.Fatal(err)
	}
	queued := filepath.Join(DefaultCacheDir(home), "queued.bin")
	if err := os.WriteFile(queued, []byte("waiting"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := testStorage()
	cfg.SessionToken = "tok_old"
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteRcloneEnv(home, cfg, "rcuser", "rcpass", ""); err != nil {
		t.Fatal(err)
	}
	creds := Credentials{KeyID: "key_laptop", AccessKeyID: cfg.AccessKey, KeyExpiresAt: time.Now().Unix() + 100, KeyTTLSeconds: 900}
	if err := SaveCredentials(home, creds); err != nil {
		t.Fatal(err)
	}
	fresh := cfg
	fresh.AccessKey = "ak_fresh"
	fresh.SecretKey = "sk_fresh"
	fresh.SessionToken = "tok_fresh"
	creds.KeyExpiresAt = time.Now().Unix() + 900
	if err := applyDeviceCredential(home, creds, fresh); err != nil {
		t.Fatal(err)
	}
	got, err := ParseRcloneConfig(RcloneConfigPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if got.AccessKey != "ak_fresh" || got.SessionToken != "tok_fresh" {
		t.Fatalf("rclone.conf = %+v, want the fresh credential", got)
	}
	env, err := os.ReadFile(RcloneEnvPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(env), "sk_fresh") {
		t.Fatalf("rclone.env missing the fresh secret:\n%s", env)
	}
	if !strings.Contains(string(env), "rcuser") {
		t.Fatalf("rclone.env dropped the rc user:\n%s", env)
	}
	if _, err := os.Stat(queued); err != nil {
		t.Fatalf("queued upload was dropped: %v", err)
	}
	saved, err := LoadCredentials(home)
	if err != nil {
		t.Fatal(err)
	}
	if saved.AccessKeyID != "ak_fresh" {
		t.Fatalf("credentials access key = %q", saved.AccessKeyID)
	}
}

func TestFailedRenewShowsANamedStatusLine(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(DefaultConfigDir(home), 0o700); err != nil {
		t.Fatal(err)
	}
	if line := deviceRenewStatusLine(home); line != "" {
		t.Fatalf("no failure file, got %q", line)
	}
	if rec := recordDeviceRenewFailure(home, fail("device-key-renew-failed")); rec != nil {
		t.Fatal(rec)
	}
	line := deviceRenewStatusLine(home)
	if line == "" {
		t.Fatal("a failed renew must name itself in drive status")
	}
	if strings.Contains(line, waitingToUploadWhy) {
		t.Fatalf("failed renew read as waiting to upload:\n%s", line)
	}
	if !strings.Contains(line, "could not be renewed") {
		t.Fatalf("status line missing the named failure:\n%s", line)
	}
	if err := clearDeviceRenewFailure(home); err != nil {
		t.Fatal(err)
	}
	if line := deviceRenewStatusLine(home); line != "" {
		t.Fatalf("cleared failure still prints: %q", line)
	}
}

func TestRenewDeviceKeyOnceRewritesBeforeExpiry(t *testing.T) {
	api := newFakeAPI()
	api.deviceExpiresIn = 900
	server := httptest.NewServer(api)
	t.Cleanup(server.Close)
	home := t.TempDir()
	origOpen := openURL
	openURL = func(string) error { return nil }
	t.Cleanup(func() { openURL = origOpen })
	api.approved["dev_secret"] = true
	if err := Login(home, server.URL, "", io.Discard); err != nil {
		t.Fatal(err)
	}
	creds, err := LoadCredentials(home)
	if err != nil {
		t.Fatal(err)
	}
	creds.KeyExpiresAt = time.Now().Add(-time.Second).Unix()
	if err := SaveCredentials(home, creds); err != nil {
		t.Fatal(err)
	}
	if err := renewDeviceKeyOnce(home, server.URL, creds); err != nil {
		t.Fatal(err)
	}
	if len(api.renewedIDs) != 1 || api.renewedIDs[0] != creds.KeyID {
		t.Fatalf("renewed %v, want %s", api.renewedIDs, creds.KeyID)
	}
	got, err := ParseRcloneConfig(RcloneConfigPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(got.AccessKey, "_renewed") {
		t.Fatalf("access key = %q, want the renewed credential", got.AccessKey)
	}
	if got.Endpoint != "http://127.0.0.1:39181" || got.Region != "us-east-1" {
		t.Fatalf("endpoint/region = %+v, want the values login stored, not the secret", got)
	}
	if strings.Contains(got.Endpoint, "sk_") || strings.Contains(got.Region, "sk_") {
		t.Fatalf("the secret landed in endpoint or region: %+v", got)
	}
	after, err := LoadCredentials(home)
	if err != nil {
		t.Fatal(err)
	}
	if after.KeyExpiresAt <= time.Now().Unix() {
		t.Fatalf("stored expiry %d is not in the future", after.KeyExpiresAt)
	}
	if after.Bucket != "drive-standin" {
		t.Fatalf("credentials bucket = %q, want drive-standin", after.Bucket)
	}
}

func TestRenewDeviceKeyOnceRecordsANamedFailure(t *testing.T) {
	api := newFakeAPI()
	api.deviceExpiresIn = 900
	api.rejectRenews = true
	server := httptest.NewServer(api)
	t.Cleanup(server.Close)
	home := t.TempDir()
	origOpen := openURL
	openURL = func(string) error { return nil }
	t.Cleanup(func() { openURL = origOpen })
	api.approved["dev_secret"] = true
	if err := Login(home, server.URL, "", io.Discard); err != nil {
		t.Fatal(err)
	}
	creds, loadErr := LoadCredentials(home)
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	err := renewDeviceKeyOnce(home, server.URL, creds)
	if err == nil {
		t.Fatal("a refused renew must fail")
	}
	var f *failure
	if !errors.As(err, &f) || f.Kind != "device-key-renew-failed" {
		t.Fatalf("got %v, want device-key-renew-failed", err)
	}
}

func TestDeviceRenewSidecarIsNotPartOfTheMount(t *testing.T) {
	unit := deviceRenewSystemdUnit("/usr/local/bin/drive", "/home/test")
	if strings.Contains(unit, "BindsTo=") || strings.Contains(unit, "PartOf=") {
		t.Fatalf("the renew sidecar must stay up while it restarts the mount:\n%s", unit)
	}
	if !strings.Contains(unit, "drive renew --home /home/test") {
		t.Fatalf("ExecStart missing drive renew:\n%s", unit)
	}
}

func TestForegroundMountDoesNotStartTheRenewSidecar(t *testing.T) {
	if err := startDeviceRenewSidecar("linux", t.TempDir(), "/no/such/unit", true); err != nil {
		t.Fatalf("foreground must skip the sidecar, got %v", err)
	}
}

func TestRecordDeviceRenewFailureDoesNotPersistRawErrorText(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(DefaultConfigDir(home), 0o700); err != nil {
		t.Fatal(err)
	}
	raw := errors.New("Get https://s3.example/bucket: secret=sk-live leaked")
	if err := recordDeviceRenewFailure(home, raw); err != nil {
		t.Fatal(err)
	}
	line := deviceRenewStatusLine(home)
	if strings.Contains(line, "sk-live") || strings.Contains(line, "s3.example") {
		t.Fatalf("raw error reached drive status:\n%s", line)
	}
	if !strings.Contains(line, "could not be renewed") {
		t.Fatalf("status line missing the named failure:\n%s", line)
	}
}

func TestRunDeviceRenewLoopTicksOnUnreadableCredentials(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(DefaultConfigDir(home), 0o700); err != nil {
		t.Fatal(err)
	}
	path := CredentialsPath(home)
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	err := runDeviceRenewLoop(ctx, home, "")
	if err == nil {
		t.Fatal("the loop must stop when the context ends")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v, want a wait until cancel, not an immediate credentials error", err)
	}
}

func TestApplyDeviceCredentialAllowsAnEmptySessionToken(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(DefaultConfigDir(home), 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := testStorage()
	cfg.SessionToken = ""
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteRcloneEnv(home, cfg, "rcuser", "rcpass", ""); err != nil {
		t.Fatal(err)
	}
	creds := Credentials{KeyID: "key_laptop", AccessKeyID: cfg.AccessKey}
	fresh := cfg
	fresh.AccessKey = "ak_fresh"
	fresh.SecretKey = "sk_fresh"
	fresh.SessionToken = ""
	if err := applyDeviceCredential(home, creds, fresh); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateRemoteConfigPostsJSONAndKeepsSecretsOffArgv(t *testing.T) {
	var gotPath, gotBody, gotAuth, gotCT string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotCT = r.Header.Get("Content-Type")
		user, pass, ok := r.BasicAuth()
		if ok {
			gotAuth = user + ":" + pass
		}
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(srv.Close)
	c := newRCClient("/this-binary-must-not-run", strings.TrimPrefix(srv.URL, "http://"), "")
	c.SetAuth("rcuser", "rcpass")
	cfg := testStorage()
	cfg.SecretKey = "sk_must_not_be_argv"
	cfg.SessionToken = "tok_must_not_be_argv"
	if err := c.updateRemoteConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/config/update" {
		t.Fatalf("path = %q, want /config/update", gotPath)
	}
	if gotCT != "application/json" {
		t.Fatalf("content-type = %q", gotCT)
	}
	if gotAuth != "rcuser:rcpass" {
		t.Fatalf("auth = %q", gotAuth)
	}
	if !strings.Contains(gotBody, "sk_must_not_be_argv") || !strings.Contains(gotBody, `"name":"drive"`) {
		t.Fatalf("body = %s", gotBody)
	}
}
