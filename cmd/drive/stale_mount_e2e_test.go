//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestStandinMountProofKillNineRecoversQueuedSave is #542's kill-9 proof:
// rclone is SIGKILL'd while a save is still in the VFS cache, the FUSE entry
// stays, and `drive mount` clears it, comes back, and uploads the queued file.
// The stand-in mount-proof CI job runs -run TestStandinMountProof, which
// matches this name (drive#744).
func TestStandinMountProofKillNineRecoversQueuedSave(t *testing.T) {
	if _, err := exec.LookPath("rclone"); err != nil {
		t.Skip("rclone is not installed")
	}
	if testing.Short() {
		t.Skip("stand-in proof skipped in -short mode")
	}

	root := t.TempDir()
	home := filepath.Join(root, "home")
	mountDir := filepath.Join(home, "Drive")
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg, _ := standinOn(t, root, "u/kill9")
	const queuedName = "queued-after-kill.txt"
	queuedBody := strings.Repeat("queued save\n", 16*1024)
	storagePath := filepath.Join(root, "data", "bucket", "u", "kill9", queuedName)

	start := func() *exec.Cmd {
		t.Helper()
		cmd := exec.Command(driveBin(t), "mount",
			"--home", home, "--endpoint", cfg.Endpoint, "--bucket", cfg.Bucket,
			"--prefix", cfg.Prefix, "--foreground")
		cmd.Env = append(os.Environ(),
			"DRIVE_S3_ACCESS_KEY_ID="+cfg.AccessKey,
			"DRIVE_S3_SECRET_ACCESS_KEY="+cfg.SecretKey,
			"DRIVE_PREFETCH=0",
			"DRIVE_DEVICE=kill9-proof",
		)
		cmd.SysProcAttr = ownProcessGroup()
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		if !waitForAnsweringMount(t, cmd, mountDir) {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			_, _ = cmd.Process.Wait()
			skipNoMount(t, "this host will not bring up the mount on %s (%s): the kill-9 proof needs "+
				"an unprivileged FUSE mount on Linux and passwordless sudo for macOS's "+
				"NFS mount", mountDir, mountSkipReason())
		}
		return cmd
	}

	cmd := start()
	t.Cleanup(func() {
		if cmd != nil && cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			_, _ = cmd.Process.Wait()
		}
		_ = unmountForCleanup(mountDir)
	})

	queuedPath := filepath.Join(mountDir, queuedName)
	if err := os.WriteFile(queuedPath, []byte(queuedBody), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(queuedPath)
	if err != nil || string(got) != queuedBody {
		t.Fatalf("queued file through the mount: %q, %v", got, err)
	}
	f, err := os.OpenFile(queuedPath, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Sync(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	// Write-back is 5s; this wait is only so rclone flushes the VFS cache
	// file to disk before SIGKILL, not so the object uploads.
	time.Sleep(500 * time.Millisecond)

	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		t.Fatalf("kill -9: %v", err)
	}
	_, _ = cmd.Process.Wait()
	cmd = nil

	if on, _ := MountedDir(CurrentGOOS(), mountDir); !on {
		t.Log("kernel dropped the FUSE entry on SIGKILL; remount still has to recover the queued save")
	}

	cmd = start()
	deadline := time.Now().Add(45 * time.Second)
	var uploaded []byte
	for time.Now().Before(deadline) {
		uploaded, err = os.ReadFile(storagePath)
		if err == nil && string(uploaded) == queuedBody {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	through, _ := os.ReadFile(queuedPath)
	t.Fatalf("queued save did not upload after remount: storage %q (%v); through mount %q\ncache:\n%s\ndata:\n%s",
		uploaded, err, through, dirTree(t, DefaultCacheDir(home)), dirTree(t, filepath.Join(root, "data")))
}

// waitForAnsweringMount waits until findmnt lists the dir AND Lstat does not
// return ENOTCONN. waitForMount treats a stale FUSE entry as live, so a
// remount after kill -9 would return before rclone is back.
func waitForAnsweringMount(t testing.TB, cmd *exec.Cmd, dir string) bool {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if err := cmd.Process.Signal(syscall.Signal(0)); err != nil {
			t.Fatalf("rclone exited before mounting %s: %v (see its log above)", dir, err)
		}
		if mountIsLive(dir) && mountDirAnswers(dir) {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

func dirTree(t *testing.T, root string) string {
	t.Helper()
	var b strings.Builder
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			fmt.Fprintf(&b, "%s: %v\n", path, err)
			return nil
		}
		if info.IsDir() {
			return nil
		}
		fmt.Fprintf(&b, "%s %d\n", path, info.Size())
		return nil
	})
	return b.String()
}
