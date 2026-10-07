package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestUnmountClearsAStaleFindmntEntry is the issue's stubbed-findmnt proof:
// findmnt still lists the drive folder after rclone has died, and
// `drive unmount` with no login item must lazy-unmount that entry instead of
// reporting success and leaving it in the mount table.
func TestUnmountClearsAStaleFindmntEntry(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("findmnt and fusermount are the Linux unmount path")
	}
	home := t.TempDir()
	mountDir := DefaultMountDir(home)
	bin := t.TempDir()
	marker := filepath.Join(bin, "unmounted")
	logPath := filepath.Join(bin, "fusermount.log")
	t.Setenv("STALE_UNMOUNTED", marker)
	t.Setenv("STALE_FUSERMOUNT_LOG", logPath)
	writeStubCommand(t, bin, "findmnt", `
dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    -M) dir="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -f "$STALE_UNMOUNTED" ]; then
  exit 1
fi
echo "$dir fuse.rclone rw"
exit 0
`)
	writeStubCommand(t, bin, "fusermount3", `
printf '%s\n' "$@" > "$STALE_FUSERMOUNT_LOG"
for a in "$@"; do
  if [ "$a" = "-uz" ]; then
    touch "$STALE_UNMOUNTED"
    exit 0
  fi
done
exit 1
`)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	if err := Unmount("linux", home); err != nil {
		t.Fatalf("Unmount: %v", err)
	}
	body, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("fusermount3 was not called: %v", err)
	}
	got := strings.TrimSpace(string(body))
	if !strings.Contains(got, "-uz") || !strings.Contains(got, mountDir) {
		t.Errorf("fusermount3 args = %q, want -uz %s", got, mountDir)
	}
	on, err := Mounted("linux", home)
	if err != nil {
		t.Fatal(err)
	}
	if on {
		t.Error("findmnt still lists the stale entry after Unmount")
	}
}

// TestClearStaleMountDirLeavesALiveFindmntEntry is coordinator review (2):
// a listed mount that still answers must not be lazy-unmounted. `drive mount`
// over a working drive would otherwise detach writes still in rclone's cache.
func TestClearStaleMountDirLeavesALiveFindmntEntry(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("findmnt and fusermount are the Linux unmount path")
	}
	home := t.TempDir()
	mountDir := DefaultMountDir(home)
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	logPath := filepath.Join(bin, "fusermount.log")
	t.Setenv("STALE_FUSERMOUNT_LOG", logPath)
	writeStubCommand(t, bin, "findmnt", `
dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    -M) dir="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "$dir fuse.rclone rw"
exit 0
`)
	writeStubCommand(t, bin, "fusermount3", `
printf '%s\n' "$@" > "$STALE_FUSERMOUNT_LOG"
exit 0
`)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	if err := clearStaleMountDir("linux", mountDir); err != nil {
		t.Fatalf("clearStaleMountDir: %v", err)
	}
	if _, err := os.Stat(logPath); err == nil {
		t.Fatal("fusermount3 ran on a live answering mount")
	}
}

// TestClearStaleMountDirTreatsAHungListingAsStale is coordinator review (3):
// a findmnt that never returns is stale without os.Lstat, so a hard NFS hang
// is not the first probe.
func TestClearStaleMountDirTreatsAHungListingAsStale(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("findmnt and fusermount are the Linux unmount path")
	}
	home := t.TempDir()
	mountDir := DefaultMountDir(home)
	bin := t.TempDir()
	logPath := filepath.Join(bin, "fusermount.log")
	t.Setenv("STALE_FUSERMOUNT_LOG", logPath)
	writeStubCommand(t, bin, "findmnt", `exec sleep 10`)
	writeStubCommand(t, bin, "fusermount3", `
printf '%s\n' "$@" > "$STALE_FUSERMOUNT_LOG"
exit 0
`)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	start := time.Now()
	if err := clearStaleMountDir("linux", mountDir); err != nil {
		t.Fatalf("clearStaleMountDir: %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("clearStaleMountDir took %s, want the 2s listing timeout", time.Since(start))
	}
	body, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("fusermount3 was not called after a hung listing: %v", err)
	}
	if !strings.Contains(string(body), mountDir) {
		t.Errorf("fusermount3 args = %q, want %s", body, mountDir)
	}
	if !strings.Contains(string(body), "-uz") {
		t.Errorf("fusermount3 args = %q, want lazy -uz, not a blocking -u", body)
	}
}

func writeStubCommand(t *testing.T, dir, name, body string) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}
