package api

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLoadCredentialsRefusesWorldReadableFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("mode bits are not a POSIX secret check on Windows")
	}
	home := t.TempDir()
	path := CredentialsPath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCredentials(home); err == nil {
		t.Fatal("world-readable credentials.json was accepted")
	}
}

func TestLoadCredentialsMissingFileIsEmpty(t *testing.T) {
	creds, err := LoadCredentials(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if creds.DeviceToken != "" {
		t.Fatalf("missing file = %+v, want empty", creds)
	}
}
