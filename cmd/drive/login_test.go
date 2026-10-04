package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoginWritesStorageSettingsFromDeviceFlow(t *testing.T) {
	api := newFakeAPI()
	server := httptest.NewServer(api)
	t.Cleanup(server.Close)

	home := t.TempDir()
	opened := make(chan string, 1)
	origOpen := openURL
	openURL = func(raw string) error {
		opened <- raw
		return nil
	}
	t.Cleanup(func() { openURL = origOpen })

	api.approved["dev_secret"] = true

	var out strings.Builder
	if err := Login(home, server.URL, &out); err != nil {
		t.Fatal(err)
	}

	select {
	case url := <-opened:
		if !strings.Contains(url, "device/approve") {
			t.Errorf("opened %q, want the device-approve page", url)
		}
	default:
		t.Fatal("login did not open the browser to the device-approve page")
	}

	printed := out.String()
	t.Logf("login output:\n%s", printed)
	if !strings.Contains(printed, "BCDF-GHJK") {
		t.Errorf("the code was not shown:\n%s", printed)
	}
	if !strings.Contains(printed, "Signed in as Nish's MacBook") {
		t.Errorf("the account was not shown:\n%s", printed)
	}

	creds, err := LoadCredentials(home)
	if err != nil {
		t.Fatal(err)
	}
	if creds.DeviceToken != testDeviceToken {
		t.Fatalf("credentials token = %q", creds.DeviceToken)
	}
	if creds.Endpoint == "" || creds.Bucket == "" || creds.Prefix == "" {
		t.Fatalf("credentials missing storage location: %+v", creds)
	}

	cfg, err := ParseRcloneConfig(RcloneConfigPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AccessKey == "" || cfg.SecretKey == "" || cfg.Endpoint == "" {
		t.Fatalf("rclone.conf missing keys or endpoint: %+v", cfg)
	}

	t.Setenv("DRIVE_S3_ENDPOINT", "")
	t.Setenv("DRIVE_S3_BUCKET", "")
	t.Setenv("DRIVE_S3_PREFIX", "")
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "")
	loaded, err := LoadStorageConfig("", "", "", "", "", "", storageFromDisk(home))
	if err != nil {
		t.Fatalf("init/mount must work after login with no pasted keys: %v", err)
	}
	if loaded.AccessKey != cfg.AccessKey || loaded.SecretKey != cfg.SecretKey {
		t.Fatalf("loaded %+v, want the key login wrote", loaded)
	}
	if loaded.Endpoint != creds.Endpoint || loaded.Bucket != creds.Bucket {
		t.Fatalf("loaded location %+v, want credentials %+v", loaded, creds)
	}
}

func TestLoginNamesMissingStorageInsteadOfLooping(t *testing.T) {
	api := newFakeAPI()
	api.keys = map[string]MintedKey{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == keysPath && r.Method == http.MethodPost {
			writeTestJSON(w, 201, MintedKey{
				KeyID: "key_bare", AccessKeyID: "ak", Secret: "sk", Prefix: "u/acct_1/",
			})
			return
		}
		api.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	api.approved["dev_secret"] = true
	origOpen := openURL
	openURL = func(string) error { return nil }
	t.Cleanup(func() { openURL = origOpen })

	err := Login(t.TempDir(), server.URL, io.Discard)
	if err == nil {
		t.Fatal("expected login to refuse a mint with no storage location")
	}
	if !strings.Contains(err.Error(), "did not send storage settings") {
		t.Fatalf("got %v, want login-no-storage", err)
	}
	if strings.Contains(err.Error(), "Run `drive login` so this device gets") {
		t.Fatalf("looping missing-config advice: %v", err)
	}
}

func TestDefaultAPIBaseMatchesTheShippedSite(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "src", "seo.js"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(src), defaultAPIBase) {
		t.Fatalf("defaultAPIBase %q is not the origin src/seo.js ships", defaultAPIBase)
	}
}
