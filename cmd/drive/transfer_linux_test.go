//go:build linux

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// TestStandinDiskFull is drive issue #107 bullet 2, Linux-only because it
// fills a tmpfs mounted on the VFS cache directory (the cache disk). rclone's
// own VFS cache returns ENOSPC to the save; `drive status` prints the
// disk-cache-full words from core/messages.js. Nothing already saved is
// truncated, and a save works again once the filler is removed.
//
// The tmpfs needs a user+mount namespace (`unshare -Urm`); without it this
// skips rather than filling the host disk.
func TestStandinDiskFull(t *testing.T) {
	env := newTransferEnv(t)
	cacheParent := filepath.Join(env.home, ".cache", "drive")
	if err := os.MkdirAll(cacheParent, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mount("tmpfs", cacheParent, "tmpfs", 0, "size=16m"); err != nil {
		t.Skipf("cannot mount a 16 MiB tmpfs on the cache disk (%v); run inside unshare -Urm", err)
	}
	t.Cleanup(func() { _ = syscall.Unmount(cacheParent, 0) })

	env.startMount()
	keep := filepath.Join(env.mountDir, "keep-me.txt")
	if err := os.WriteFile(keep, []byte("already saved\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	keepSum, err := md5File(keep)
	if err != nil {
		t.Fatal(err)
	}

	filler := filepath.Join(cacheParent, "filler")
	fillUntil(t, filler, cacheParent, 0)

	big := filepath.Join(env.mountDir, "too-big.bin")
	err = writePatternFile(big, 8<<20)
	if err == nil {
		t.Fatal("the save succeeded on a full cache disk, want a loud failure")
	}
	msg := strings.ToLower(err.Error())
	if !errors.Is(err, syscall.ENOSPC) && !errors.Is(err, syscall.EIO) &&
		!strings.Contains(msg, "no space") && !strings.Contains(msg, "input/output error") {
		t.Fatalf("save error %q, want the cache disk refusing the write", err)
	}

	gotKeep, err := os.ReadFile(keep)
	if err != nil {
		t.Fatalf("the already-saved file is gone: %v", err)
	}
	if string(gotKeep) != "already saved\n" {
		t.Errorf("already-saved file was truncated or rewritten: %q", gotKeep)
	}
	if sum, err := md5File(keep); err != nil || sum != keepSum {
		t.Errorf("already-saved checksum changed: %v %s want %s", err, sum, keepSum)
	}

	out := env.status()
	if !strings.Contains(out, diskCacheFullWhat) {
		t.Errorf("drive status on a full cache =\n%s\nwant %q", out, diskCacheFullWhat)
	}

	if err := os.Remove(filler); err != nil {
		t.Fatalf("free the cache disk: %v", err)
	}
	if err := writePatternFile(big, 8<<20); err != nil {
		t.Fatalf("save after space returned: %v", err)
	}
	if _, err := os.Stat(big); err != nil {
		t.Fatalf("the recovered save is missing: %v", err)
	}
}

func fillUntil(t *testing.T, path, dir string, leave int64) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	buf := make([]byte, 1<<20)
	for {
		var st syscall.Statfs_t
		if err := syscall.Statfs(dir, &st); err != nil {
			t.Fatal(err)
		}
		free := int64(st.Bavail) * int64(st.Bsize)
		if free <= leave {
			return
		}
		n := int(free - leave)
		if n > len(buf) {
			n = len(buf)
		}
		if _, err := f.Write(buf[:n]); err != nil {
			if errors.Is(err, syscall.ENOSPC) {
				return
			}
			t.Fatal(err)
		}
	}
}
