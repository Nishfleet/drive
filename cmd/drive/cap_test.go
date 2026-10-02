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
