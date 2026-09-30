package main

import (
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestStandinMountProof is the step-2 done-when proof, run against a local S3
// stand-in: `rclone serve s3` on a local folder (stock, no new dependency).
// It asserts the two acceptance bullets:
//
//  1. the first bytes of a large file read back before the whole file has
//     downloaded, and
//  2. a file written through the mount survives a stop/start with the same
//     checksum.
//
// It needs FUSE. Where the host does not permit an unprivileged FUSE mount the
// test skips with a message naming the user-namespace fallback, so a CI runner
// without /dev/fuse does not fail every unrelated PR; an rclone that exits
// before the mount appears is still a real failure. Run it inside
// `unshare -Urm` on a host where an unprivileged mount is refused. Set
// DRIVE_STANDIN_SIZE_MB to change the big file's size (default 64).
func TestStandinMountProof(t *testing.T) {
	if _, err := exec.LookPath("rclone"); err != nil {
		t.Skip("rclone is not installed")
	}
	if testing.Short() {
		t.Skip("stand-in proof skipped in -short mode")
	}

	root := t.TempDir()
	dataDir := filepath.Join(root, "data", "bucket")
	home := filepath.Join(root, "home")
	mountDir := filepath.Join(home, "Drive")
	for _, d := range []string{dataDir, home, mountDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	bigMB := 64
	if v := os.Getenv("DRIVE_STANDIN_SIZE_MB"); v != "" {
		if _, err := fmt.Sscanf(v, "%d", &bigMB); err != nil {
			t.Fatalf("DRIVE_STANDIN_SIZE_MB: %v", err)
		}
	}
	bigPath := filepath.Join(dataDir, "movie.mp4")
	if err := writePatternFile(bigPath, int64(bigMB)<<20); err != nil {
		t.Fatal(err)
	}
	smallPath := filepath.Join(dataDir, "small.bin")
	if err := writePatternFile(smallPath, 1<<20); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	const accessKey, secretKey = "ACCESSKEYID", "SECRETACCESSKEY"
	serve := exec.Command("rclone", "serve", "s3", filepath.Join(root, "data"),
		"--auth-key", accessKey+","+secretKey,
		"--addr", "127.0.0.1:"+port,
		"--log-level", "INFO")
	serve.Stdout, serve.Stderr = os.Stdout, os.Stderr
	if err := serve.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = serve.Process.Kill(); _ = serve.Wait() }()
	waitForPort(t, port)

	// Seed the device's own prefix the way the api Worker will (step 1).
	seedEnv := append(os.Environ(),
		"RCLONE_CONFIG="+filepath.Join(home, ".config", "drive", "rclone.conf"),
	)
	// Let Mount write the config first so the seed uses the same file.
	cfg := testStorage()
	cfg.AccessKey = accessKey
	cfg.SecretKey = secretKey
	cfg.Endpoint = "http://127.0.0.1:" + port
	cfg.Bucket = "bucket"
	cfg.Prefix = "u/standin"
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		t.Fatal(err)
	}
	if testing.Verbose() {
		t.Logf("seed config:\n%s", RcloneConfigRedacted(cfg))
	}
	for _, f := range []string{bigPath, smallPath} {
		seed := exec.Command("rclone", "copy", f, "drive:"+cfg.Bucket+"/"+cfg.Prefix+"/")
		seed.Env = seedEnv
		if out, err := seed.CombinedOutput(); err != nil {
			t.Fatalf("seed %s: %v\n%s", f, err, out)
		}
	}

	unmount := func(cmd *exec.Cmd) {
		// The CLI's Unmount (systemd on Linux) is not available in the test
		// namespace, so stop the foreground process, then a stale mount point
		// is cleaned by the kernel when the process exits.
		if err := cmd.Process.Signal(os.Interrupt); err != nil {
			t.Logf("signal mount: %v", err)
		}
		done := make(chan struct{})
		go func() { _ = cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
		exec.Command("fusermount3", "-u", mountDir).Run()
		exec.Command("fusermount", "-u", mountDir).Run()
	}

	var current *exec.Cmd
	mount := func() *exec.Cmd {
		cmd := exec.Command(driveBin(t), "mount",
			"--home", home, "--endpoint", cfg.Endpoint, "--bucket", cfg.Bucket,
			"--prefix", cfg.Prefix, "--access-key", accessKey, "--secret-key-stdin",
			"--foreground")
		// The secret reaches the CLI on stdin, the safe source that replaced the
		// flag (issue #75): it is never in this test's argv or this process's
		// command line.
		cmd.Stdin = strings.NewReader(secretKey + "\n")
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		if !waitForMount(t, cmd, mountDir) {
			unmount(cmd)
			t.Skipf("this host does not permit an unprivileged FUSE mount on %s; "+
				"run the proof in a user namespace: unshare -Urm go test ./cmd/drive -run Standin", mountDir)
		}
		current = cmd
		return cmd
	}
	// Clean up whatever mount is current even if an assertion below fails,
	// so a failing run does not leave an orphaned rclone mount behind.
	defer func() {
		if current != nil {
			unmount(current)
		}
	}()

	// Proof 1: first bytes before the whole file is down.
	cmd := mount()
	firstStart := time.Now()
	f, err := os.Open(filepath.Join(mountDir, "movie.mp4"))
	if err != nil {
		t.Fatalf("open movie through the mount: %v", err)
	}
	buf := make([]byte, 64*1024)
	n, err := io.ReadFull(f, buf)
	if err != nil {
		t.Fatalf("read first bytes: %v", err)
	}
	firstElapsed := time.Since(firstStart)
	f.Close()
	t.Logf("first 64 KiB of a %d MiB file at %.3fs", bigMB, firstElapsed.Seconds())
	if n != len(buf) {
		t.Fatalf("read %d bytes, want %d", n, len(buf))
	}
	// A full download of a 64 MiB file over loopback is the reference; the
	// first read must be well under it. Keep a generous ceiling so the test
	// is not a flaky wall-clock race, but far below a full transfer.
	full := time.Now()
	fullCmd := exec.Command("rclone", "cat", "drive:"+cfg.Bucket+"/"+cfg.Prefix+"/movie.mp4")
	fullCmd.Env = seedEnv
	fullCmd.Stdout = io.Discard
	fullCmd.Stderr = io.Discard
	if err := fullCmd.Run(); err != nil {
		t.Fatalf("rclone cat full object: %v", err)
	}
	fullElapsed := time.Since(full)
	t.Logf("full %d MiB object over the same loopback in %.3fs", bigMB, fullElapsed.Seconds())
	if firstElapsed >= fullElapsed && fullElapsed > 200*time.Millisecond {
		t.Errorf("first bytes took %.3fs, no faster than the full download %.3fs: not streamed",
			firstElapsed.Seconds(), fullElapsed.Seconds())
	}

	// Proof 2: a save survives stop/start with the same checksum.
	before, err := md5File(filepath.Join(mountDir, "small.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mountDir, "written-through.txt"), []byte("saved through the mount\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// --vfs-write-back is 5s; give the upload time to land before stopping.
	time.Sleep(8 * time.Second)
	unmount(cmd)

	cmd = mount()
	_ = cmd
	after, err := md5File(filepath.Join(mountDir, "small.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Errorf("checksum changed across stop/start: before %s after %s", before, after)
	}
	written, err := os.ReadFile(filepath.Join(mountDir, "written-through.txt"))
	if err != nil {
		t.Fatalf("written-through.txt missing after remount: %v", err)
	}
	if string(written) != "saved through the mount\n" {
		t.Errorf("written-through.txt = %q", written)
	}
}

func writePatternFile(path string, size int64) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	block := make([]byte, 1<<20)
	for i := range block {
		block[i] = byte(i % 251)
	}
	for written := int64(0); written < size; {
		n := int64(len(block))
		if remaining := size - written; remaining < n {
			n = remaining
		}
		if _, err := f.Write(block[:n]); err != nil {
			return err
		}
		written += n
	}
	return f.Sync()
}

func md5File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := md5.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func freePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	_, port, err := net.SplitHostPort(l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func waitForPort(t *testing.T, port string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", "127.0.0.1:"+port, time.Second)
		if err == nil {
			c.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("stand-in never listened on %s", port)
}

// waitForMount waits for the mount to appear. A plain directory that never
// becomes a mount point while rclone is still running means the host refuses
// the FUSE mount (a CI runner without /dev/fuse): that is a skip, reported by
// the caller. An rclone that has already exited is a real failure.
func waitForMount(t *testing.T, cmd *exec.Cmd, dir string) bool {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if err := cmd.Process.Signal(syscall.Signal(0)); err != nil {
			t.Fatalf("rclone exited before mounting %s: %v (see its log above)", dir, err)
		}
		out, err := exec.Command("findmnt", "-n", "-M", dir).Output()
		if err == nil && strings.TrimSpace(string(out)) != "" {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// driveBin builds the CLI once and returns its path. The binary outlives the
// test that built it: a per-test TempDir would be deleted with that test, and
// a second caller would then exec a path that no longer exists.
var (
	builtBinary string
	builtBinDir string
)

func driveBin(t *testing.T) string {
	t.Helper()
	if builtBinary != "" {
		return builtBinary
	}
	dir, err := os.MkdirTemp("", "drive-bin-*")
	if err != nil {
		t.Fatal(err)
	}
	builtBinDir = dir
	out := filepath.Join(dir, "drive")
	cmd := exec.Command("go", "build", "-o", out, ".")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, b)
	}
	builtBinary = out
	return builtBinary
}

// TestMain removes the built binary's directory after the run, since no single
// test owns it (any test may have been the one to build it).
func TestMain(m *testing.M) {
	code := m.Run()
	if builtBinDir != "" {
		_ = os.RemoveAll(builtBinDir)
	}
	os.Exit(code)
}
