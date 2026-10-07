package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Transfer reliability proofs (drive issue #107), run against a local
// `rclone serve s3` stand-in, the same way TestStandinMountProof and
// TestStandinPauseProof are. They assert the issue's own bullets:
//
//  1. Interrupted upload: the storage goes away mid-upload of a large file,
//     comes back, and the file arrives whole with a checksum match, with no
//     pause/resume (that is issue #100).
//  2. Crash: the mount process is killed with files waiting; after restart
//     `drive status` names them and they upload.
//
// Disk-full is Linux-only (a tmpfs for the cache disk) in transfer_linux_test.go.
//
// Searched before writing anything: rclone mount VFS cache (rclone.org/commands
// /rclone_mount/, rclone v1.75.1) --vfs-cache-mode full keeps dirty files on
// disk and retries failed uploads with doubling delay; "If rclone is quit or
// dies with files that haven't been uploaded, these will be uploaded next time
// rclone is run with the same flags." rc vfs/stats diskCache.outOfSpace is the
// full-disk flag the fill loop already reads. No second queue or retry loop is
// written here.
//
// They need a mount. Where the host does not give one they skip with the same
// message as the other stand-in proofs (run inside `unshare -Urm` on Linux).
// Set DRIVE_STANDIN_INTERRUPT_MB to change the interrupted file's size
// (default 1024, the issue's 1 GB; CI sets 64 so the job fits).

func TestStandinInterruptUpload(t *testing.T) {
	env := newTransferEnv(t)
	size := interruptSize(t)
	name := "interrupt.bin"

	env.startMount()
	rc := rcClientForTestHome(t, env.home, env.rcAddr, "")
	var limitErr error
	for i := 0; i < 20; i++ {
		limitErr = rc.SetBwLimit(context.Background(), "10M:off")
		if limitErr == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if limitErr != nil {
		t.Fatalf("set a measurable rate so the upload can be cut mid-flight: %v", limitErr)
	}
	if err := writePatternFile(filepath.Join(env.mountDir, name), size); err != nil {
		t.Fatal(err)
	}
	wantSum, err := md5File(filepath.Join(env.mountDir, name))
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(45 * time.Second)
	var started int64
	for time.Now().Before(deadline) {
		stats, err := rc.ReadStats(context.Background())
		if err != nil {
			t.Fatalf("rc core/stats: %v", err)
		}
		if stats.Bytes > 0 {
			started = stats.Bytes
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if started == 0 {
		t.Fatal("the upload never started, so there is nothing to interrupt")
	}
	if started >= size {
		t.Fatalf("the upload finished (%d bytes) before the stand-in could be cut", started)
	}

	if err := env.restart.stop(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Second)
	if err := env.restart.start(t); err != nil {
		t.Fatal(err)
	}
	// Full speed again so the retry is the product (rclone's own writeback),
	// not a leftover test rate. This is rc core/bwlimit, not `drive resume`.
	if err := rc.SetBwLimit(context.Background(), resumeRate); err != nil {
		t.Logf("clear the test rate: %v", err)
	}

	object := env.objectPath(name)
	if err := waitForFile(t, object, size, 2*time.Minute); err != nil {
		t.Fatalf("cut-off upload did not arrive whole after storage came back: %v", err)
	}
	gotSum, err := md5File(object)
	if err != nil {
		t.Fatal(err)
	}
	if gotSum != wantSum {
		t.Errorf("checksum after the cut-off upload: got %s want %s", gotSum, wantSum)
	}
}

func TestStandinCrash(t *testing.T) {
	env := newTransferEnv(t)
	name := "crash.bin"
	size := int64(8 << 20)

	env.startMount()
	if err := writePatternFile(filepath.Join(env.mountDir, name), size); err != nil {
		t.Fatal(err)
	}
	wantSum, err := md5File(filepath.Join(env.mountDir, name))
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	var queued Pending
	for time.Now().Before(deadline) {
		q, err := PendingUploads(DefaultCacheDir(env.home))
		if err == nil && q.Files > 0 {
			queued = q
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if queued.Files == 0 {
		t.Fatal("nothing was waiting in the VFS cache, so a crash would prove nothing")
	}

	env.killMount()

	out := env.status()
	if !strings.Contains(out, UploadLabel(queued)) && !strings.Contains(out, "Uploading") {
		t.Errorf("drive status after the crash =\n%s\nwant the waiting upload named", out)
	}
	if !strings.Contains(out, name) {
		t.Errorf("drive status after the crash =\n%s\nwant %s listed", out, name)
	}
	if !strings.Contains(out, waitingUnmountedWhy) {
		t.Errorf("drive status after the crash =\n%s\nwant %q", out, waitingUnmountedWhy)
	}

	env.startMount()
	object := env.objectPath(name)
	if err := waitForFile(t, object, size, 2*time.Minute); err != nil {
		t.Fatalf("waiting file did not upload after the mount came back: %v", err)
	}
	gotSum, err := md5File(object)
	if err != nil {
		t.Fatal(err)
	}
	if gotSum != wantSum {
		t.Errorf("checksum after the crash: got %s want %s", gotSum, wantSum)
	}
	out = env.status()
	if strings.Contains(out, waitingUnmountedWhy) {
		t.Errorf("drive status after remount still says not mounted:\n%s", out)
	}
}

func interruptSize(t *testing.T) int64 {
	t.Helper()
	mb := 1024
	if v := os.Getenv("DRIVE_STANDIN_INTERRUPT_MB"); v != "" {
		if _, err := fmt.Sscanf(v, "%d", &mb); err != nil {
			t.Fatalf("DRIVE_STANDIN_INTERRUPT_MB: %v", err)
		}
	}
	if mb < 1 {
		t.Fatalf("DRIVE_STANDIN_INTERRUPT_MB=%d, want at least 1", mb)
	}
	return int64(mb) << 20
}

type transferEnv struct {
	t        *testing.T
	root     string
	home     string
	mountDir string
	cfg      StorageConfig
	restart  *standinRestart
	rcAddr   string
	mount    *exec.Cmd
}

func newTransferEnv(t *testing.T) *transferEnv {
	t.Helper()
	if _, err := exec.LookPath("rclone"); err != nil {
		t.Skip("rclone is not installed")
	}
	if testing.Short() {
		t.Skip("stand-in transfer proof skipped in -short mode")
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	mountDir := filepath.Join(home, "Drive")
	for _, d := range []string{filepath.Join(root, "data", "bucket"), home, mountDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	cfg, serve := standinOn(t, root, "u/standin")
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		t.Fatal(err)
	}
	env := &transferEnv{
		t:        t,
		root:     root,
		home:     home,
		mountDir: mountDir,
		cfg:      cfg,
		restart:  &standinRestart{serve: serve, root: root, cfg: cfg},
		rcAddr:   "127.0.0.1:" + freePort(t),
	}
	t.Cleanup(func() {
		if env.mount != nil {
			stopStandinProcess(env.mount, env.mountDir)
		}
	})
	return env
}

func (e *transferEnv) startMount() {
	e.t.Helper()
	cmd := exec.Command(driveBin(e.t), "mount",
		"--home", e.home, "--endpoint", e.cfg.Endpoint, "--bucket", e.cfg.Bucket,
		"--prefix", e.cfg.Prefix, "--foreground")
	cmd.Env = append(os.Environ(),
		"DRIVE_S3_ACCESS_KEY_ID="+e.cfg.AccessKey,
		"DRIVE_S3_SECRET_ACCESS_KEY="+e.cfg.SecretKey,
		"DRIVE_RC_ADDR="+e.rcAddr,
		"DRIVE_PREFETCH=0",
	)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		e.t.Fatal(err)
	}
	e.mount = cmd
	if !waitForMount(e.t, cmd, e.mountDir) {
		stopStandinProcess(cmd, e.mountDir)
		e.mount = nil
		skipNoMount(e.t, "this host will not bring up the mount on %s (%s): the proof needs "+
			"an unprivileged FUSE mount on Linux and passwordless sudo for macOS's "+
			"NFS mount", e.mountDir, mountSkipReason())
	}
}

func (e *transferEnv) killMount() {
	e.t.Helper()
	if e.mount == nil || e.mount.Process == nil {
		e.t.Fatal("killMount with no mount")
	}
	if err := e.mount.Process.Kill(); err != nil {
		e.t.Fatalf("kill the mount: %v", err)
	}
	_, _ = e.mount.Process.Wait()
	e.mount = nil
	_ = unmountForCleanup(e.mountDir)
}

func (e *transferEnv) status() string {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, driveBin(e.t), "status", "--home", e.home)
	cmd.Env = append(os.Environ(), "HOME="+e.home, "DRIVE_RC_ADDR="+e.rcAddr)
	cmd.SysProcAttr = ownProcessGroup()
	out, err := cmd.CombinedOutput()
	if err != nil {
		e.t.Fatalf("drive status: %v\n%s", err, out)
	}
	return string(out)
}

func (e *transferEnv) objectPath(name string) string {
	return standinObjectPath(e.root, e.cfg, name)
}

func waitForFile(t *testing.T, path string, size int64, d time.Duration) error {
	t.Helper()
	deadline := time.Now().Add(d)
	var last error
	for time.Now().Before(deadline) {
		st, err := os.Stat(path)
		if err == nil && st.Size() == size {
			return nil
		}
		if err != nil {
			last = err
		} else {
			last = fmt.Errorf("%s is %d bytes, want %d", path, st.Size(), size)
		}
		time.Sleep(500 * time.Millisecond)
	}
	if last == nil {
		last = errors.New("timed out")
	}
	return last
}
