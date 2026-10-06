package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
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

func writeStubCommand(t *testing.T, dir, name, body string) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}
