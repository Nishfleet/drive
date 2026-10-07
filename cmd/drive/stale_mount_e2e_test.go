//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
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
	const queuedBody = "queued save\n"
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
		if !waitForMount(t, cmd, mountDir) {
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

	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		t.Fatalf("kill -9: %v", err)
	}
	_, _ = cmd.Process.Wait()
	cmd = nil

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
	t.Fatalf("queued save did not upload after remount: storage %q (%v); through mount %q",
		uploaded, err, through)
}
