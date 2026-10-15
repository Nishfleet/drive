package main

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

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
	_ = startRcloneServe(t, filepath.Join(root, "data"), port,
		"--auth-key", accessKey+","+secretKey,
		"--log-level", "INFO")

	seedEnv := append(os.Environ(),
		"RCLONE_CONFIG="+filepath.Join(home, ".config", "drive", "rclone.conf"),
		rcloneSecretEnv+"="+secretKey,
	)
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

	var current *exec.Cmd
	mount := func() *exec.Cmd {
		cmd, _, _ := startStandinMount(t, home, mountDir, cfg)
		current = cmd
		return cmd
	}
	defer func() {
		if current != nil {
			stopStandinProcess(current, mountDir)
		}
	}()

	cmd := mount()
	firstStart := time.Now()
	t.Logf("mounting through rclone %s on %s", BuildMountPlan(CurrentGOOS(), home, "rclone", cfg).Subcommand, CurrentGOOS())
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

	before, err := md5File(filepath.Join(mountDir, "small.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mountDir, "written-through.txt"), []byte("saved through the mount\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(8 * time.Second)
	stopStandinProcess(cmd, mountDir)

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

func TestStandinMountProofStrayFile(t *testing.T) {
	if CurrentGOOS() == "windows" {
		t.Skip("stray-file park is the unix mount-folder path")
	}
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
	const strayBody = "keep me"
	if err := os.WriteFile(filepath.Join(mountDir, "notes.txt"), []byte(strayBody), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, _ := standinOn(t, root, "u/stray")
	rcAddr := "127.0.0.1:" + freePort(t)
	var note lockedBuffer
	cmd := exec.Command(driveBin(t), "mount",
		"--home", home, "--endpoint", cfg.Endpoint, "--bucket", cfg.Bucket,
		"--prefix", cfg.Prefix, "--foreground")
	cmd.Env = append(os.Environ(),
		"DRIVE_S3_ACCESS_KEY_ID="+cfg.AccessKey,
		"DRIVE_S3_SECRET_ACCESS_KEY="+cfg.SecretKey,
		"DRIVE_PREFETCH=0",
		"DRIVE_DEVICE=stray-proof",
		"DRIVE_RC_ADDR="+rcAddr,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = io.MultiWriter(os.Stderr, &note)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var stopOnce sync.Once
	stop := func() { stopOnce.Do(func() { stopStandinProcess(cmd, mountDir) }) }
	t.Cleanup(stop)
	if !waitForMount(t, cmd, mountDir) {
		log, _ := os.ReadFile(filepath.Join(DefaultConfigDir(home), "mount.log"))
		t.Logf("stderr:\n%s\nmount.log:\n%s", note.Bytes(), log)
		stop()
		if bytes.Contains(log, []byte("CRITICAL")) || bytes.Contains(log, []byte("Failed to start")) {
			t.Fatalf("rclone failed to start the mount, not a FUSE skip")
		}
		skipNoMount(t, "this host will not bring up the mount on %s (%s): the stray-file proof needs "+
			"an unprivileged FUSE mount on Linux and passwordless sudo for macOS's "+
			"NFS mount", mountDir, mountSkipReason())
	}

	copiedDeadline := testUntil(t, 15*time.Second)
	var got []byte
	var err error
	for time.Now().Before(copiedDeadline) {
		got, err = os.ReadFile(filepath.Join(mountDir, "notes.txt"))
		if err == nil && string(got) == strayBody {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if string(got) != strayBody {
		log, _ := os.ReadFile(filepath.Join(DefaultConfigDir(home), "mount.log"))
		t.Fatalf("drive notes.txt = %q, %v, want the parked bytes copied into the mount\nstderr:\n%s\nmount.log:\n%s",
			got, err, note.Bytes(), log)
	}

	logged := note.String()
	if !strings.Contains(logged, "already had local files") {
		t.Errorf("stderr is missing the stray-file note:\n%s", logged)
	}
	if !strings.Contains(logged, "moved to") || !strings.Contains(logged, strayHoldingDir(mountDir)) {
		t.Errorf("stderr does not name the holding folder the files were parked in:\n%s", logged)
	}

	holdingDeadline := testUntil(t, 5*time.Second)
	var leftover []string
	for time.Now().Before(holdingDeadline) {
		leftover = nil
		matches, globErr := filepath.Glob(strayHoldingDir(mountDir) + "*")
		if globErr != nil {
			t.Fatal(globErr)
		}
		for _, holding := range matches {
			entries, readErr := os.ReadDir(holding)
			if readErr == nil && len(entries) > 0 {
				leftover = append(leftover, holding+":"+strings.Join(namesOf(entries), ","))
			}
		}
		if leftover == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if leftover != nil {
		t.Errorf("holding folders still have files after the copy into the drive: %v", leftover)
	}

	seedEnv := append(os.Environ(),
		"RCLONE_CONFIG="+RcloneConfigPath(home),
		rcloneSecretEnv+"="+cfg.SecretKey,
	)
	storageDeadline := testUntil(t, 20*time.Second)
	var stored []byte
	var storeErr error
	for time.Now().Before(storageDeadline) {
		cat := exec.Command("rclone", "cat", RemoteFor(cfg)+"/notes.txt")
		cat.Env = seedEnv
		stored, storeErr = cat.Output()
		if storeErr == nil && string(stored) == strayBody {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if string(stored) != strayBody {
		t.Fatalf("storage notes.txt = %q, %v, want the stray file to have uploaded", stored, storeErr)
	}
}

func namesOf(entries []os.DirEntry) []string {
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.Name()
	}
	return names
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func (l *lockedBuffer) Bytes() []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]byte, l.b.Len())
	copy(out, l.b.Bytes())
	return out
}

func testUntil(t *testing.T, d time.Duration) time.Time {
	t.Helper()
	at := time.Now().Add(d)
	if dl, ok := t.Deadline(); ok {
		leave := dl.Add(-2 * time.Second)
		if leave.Before(at) {
			return leave
		}
	}
	return at
}

func TestStandinPauseProof(t *testing.T) {
	if _, err := exec.LookPath("rclone"); err != nil {
		t.Skip("rclone is not installed")
	}
	if testing.Short() {
		t.Skip("stand-in pause proof skipped in -short mode")
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
	mb := 200
	if v := os.Getenv("DRIVE_STANDIN_PAUSE_MB"); v != "" {
		if _, err := fmt.Sscanf(v, "%d", &mb); err != nil {
			t.Fatalf("DRIVE_STANDIN_PAUSE_MB: %v", err)
		}
	}
	size := int64(mb) << 20

	port := freePort(t)
	rcAddr := "127.0.0.1:" + freePort(t)
	const accessKey, secretKey = "ACCESSKEYID", "SECRETACCESSKEY"
	_ = startRcloneServe(t, filepath.Join(root, "data"), port,
		"--auth-key", accessKey+","+secretKey)

	cfg := testStorage()
	cfg.AccessKey, cfg.SecretKey = accessKey, secretKey
	cfg.Endpoint = "http://127.0.0.1:" + port
	cfg.Bucket, cfg.Prefix = "bucket", "u/standin"
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		t.Fatal(err)
	}

	mount := func() *exec.Cmd {
		cmd := exec.Command(driveBin(t), "mount",
			"--home", home, "--endpoint", cfg.Endpoint, "--bucket", cfg.Bucket,
			"--prefix", cfg.Prefix, "--foreground")
		cmd.Env = append(os.Environ(),
			"DRIVE_S3_ACCESS_KEY_ID="+accessKey,
			"DRIVE_S3_SECRET_ACCESS_KEY="+secretKey,
			"DRIVE_RC_ADDR="+rcAddr,
			"DRIVE_PREFETCH=0",
		)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		if !waitForMount(t, cmd, mountDir) {
			_ = cmd.Process.Signal(os.Interrupt)
			_ = cmd.Wait()
			skipNoMount(t, "this host does not permit an unprivileged FUSE mount on %s; "+
				"run the proof in a user namespace: unshare -Urm go test ./cmd/drive -run StandinPause", mountDir)
		}
		return cmd
	}
	unmount := func(cmd *exec.Cmd) {
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
		_ = exec.Command("fusermount3", "-u", mountDir).Run()
		_ = exec.Command("fusermount", "-u", mountDir).Run()
	}

	rc := func() *rcClient { return rcClientForTestHome(t, home, rcAddr, "") }
	readBytes := func(t *testing.T) int64 {
		t.Helper()
		stats, err := rc().ReadStats(context.Background())
		if err != nil {
			t.Fatalf("rc core/stats: %v", err)
		}
		return stats.Bytes
	}
	run := func(t *testing.T, args ...string) string {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, driveBin(t), args...)
		cmd.Env = append(os.Environ(), "HOME="+home, "DRIVE_RC_ADDR="+rcAddr)
		cmd.SysProcAttr = ownProcessGroup()
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("drive %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return string(out)
	}

	current := mount()
	defer func() {
		if current != nil {
			unmount(current)
		}
	}()

	if err := rc().SetBwLimit(context.Background(), "10M:off"); err != nil {
		t.Fatalf("set a measurable rate: %v", err)
	}

	if err := writePatternFile(filepath.Join(mountDir, "pause-proof.bin"), size); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		stats, err := rc().ReadStats(context.Background())
		if err != nil {
			t.Fatalf("rc core/stats: %v", err)
		}
		if stats.Bytes > 0 && len(stats.Transferring) > 0 {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if b := readBytes(t); b == 0 {
		t.Fatalf("the upload never started, so there is nothing to pause")
	}

	if out := run(t, "pause", "--home", home); !strings.Contains(out, pausedLabel) {
		t.Errorf("drive pause said %q, want the Paused word", out)
	}
	if on, err := Mounted(CurrentGOOS(), home); err != nil || !on {
		t.Fatalf("mount disappeared: on=%v err=%v", on, err)
	}
	time.Sleep(5 * time.Second)
	b1 := readBytes(t)
	time.Sleep(6 * time.Second)
	b2 := readBytes(t)
	if b2 != b1 {
		t.Errorf("pause did not stop the bytes: %d then %d after six seconds", b1, b2)
	}
	if b2 >= size {
		t.Fatalf("the upload finished at %d bytes despite the pause, so the pause never applied", b2)
	}
	if got := transfersLine(home, true); got != "transfers: "+pausedLabel {
		t.Errorf("transfersLine after pause = %q, want the Paused word (drive status prints this line)", got)
	}

	if out := run(t, "resume", "--home", home); !strings.Contains(out, resumedLabel) {
		t.Errorf("drive resume said %q, want the Resumed word", out)
	}
	deadline = time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		if readBytes(t) == size {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	stats, err := rc().ReadStats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if stats.Bytes != size {
		t.Errorf("after resume the transfer is %d of %d bytes, want the whole file", stats.Bytes, size)
	}
	if stats.TotalTransfers != 1 {
		t.Errorf("transfers = %d, want exactly 1: a resumed file must not be sent twice", stats.TotalTransfers)
	}
	queueDeadline := time.Now().Add(15 * time.Second)
	var queue Queue
	for {
		queue, err = rc().ReadQueue(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if len(queue.Queue) == 0 || time.Now().After(queueDeadline) {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if len(queue.Queue) != 0 {
		t.Errorf("queue = %+v, want empty once the upload finished", queue.Queue)
	}
	listing := exec.Command("rclone", "lsl", "drive:"+cfg.Bucket+"/"+cfg.Prefix+"/pause-proof.bin")
	listing.Env = append(os.Environ(), "RCLONE_CONFIG="+RcloneConfigPath(home), rcloneSecretEnv+"="+cfg.SecretKey)
	out, err := listing.Output()
	if err != nil {
		t.Fatalf("independent rclone lsl: %v", err)
	}
	if !strings.Contains(string(out), fmt.Sprint(size)) {
		t.Errorf("the stand-in lists %q, want the %d-byte object", strings.TrimSpace(string(out)), size)
	}

	run(t, "pause", "--home", home)
	unmount(current)
	current = mount()
	if got := transfersLine(home, true); got != "transfers: "+pausedLabel {
		t.Errorf("transfersLine after a restart = %q, want the Paused word", got)
	}
	if got, err := rc().BwLimit(context.Background()); err != nil {
		t.Fatalf("rc core/bwlimit after a restart: %v", err)
	} else if got.Rate != "1Ki:off" {
		t.Errorf("after a restart rclone reports rate %q, want 1Ki:off (the paused rate)", got.Rate)
	}
	if err := writePatternFile(filepath.Join(mountDir, "after-restart.bin"), 32<<20); err != nil {
		t.Fatal(err)
	}
	time.Sleep(9 * time.Second)
	if b := readBytes(t); b > 64*1024 {
		t.Errorf("a paused mount sent %d bytes after a restart, want at most 64 KiB at 1 KiB/s", b)
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

func freePort(t testing.TB) string {
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

func waitForPort(t testing.TB, port string) {
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

var testProcesses sync.Map

var processStops sync.Map

type processStop struct {
	once sync.Once
	err  error
}

func stopProcess(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	testProcesses.Delete(cmd.Process.Pid)
	value, _ := processStops.LoadOrStore(cmd, &processStop{})
	stop := value.(*processStop)
	stop.once.Do(func() {
		stop.err = signalProcessGroup(cmd, 5*time.Second)
	})
	return stop.err
}

func trackTestProcess(tb testing.TB, cmd *exec.Cmd) {
	tb.Helper()
	testProcesses.Store(cmd.Process.Pid, cmd)
	tb.Cleanup(func() { stopProcess(cmd) })
}

func stopTestProcesses() {
	testProcesses.Range(func(_, value any) bool {
		stopProcess(value.(*exec.Cmd))
		return true
	})
}

func startRcloneServe(tb testing.TB, dir, port string, args ...string) *exec.Cmd {
	tb.Helper()
	if _, err := exec.LookPath("rclone"); err != nil {
		tb.Skip("rclone is not installed")
	}
	full := append([]string{"serve", "s3", dir}, args...)
	full = append(full, "--addr", "127.0.0.1:"+port)
	serve := exec.Command("rclone", full...)
	serve.SysProcAttr = ownProcessGroup()
	serve.Stdout, serve.Stderr = os.Stdout, os.Stderr
	if err := serve.Start(); err != nil {
		tb.Fatal(err)
	}
	trackTestProcess(tb, serve)
	waitForPort(tb, port)
	return serve
}

func waitForMount(t testing.TB, cmd *exec.Cmd, dir string) bool {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if err := cmd.Process.Signal(syscall.Signal(0)); err != nil {
			t.Fatalf("rclone exited before mounting %s: %v (see its log above)", dir, err)
		}
		if mountIsLive(dir) {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

func mountIsLive(dir string) bool {
	on, err := MountedDir(CurrentGOOS(), dir)
	if err != nil {
		return false
	}
	return on
}

func rcClientForTestHome(t *testing.T, home, addr, fs string) *rcClient {
	t.Helper()
	c := newRCClient("rclone", addr, fs)
	auth, err := ReadRCAuth(home)
	if err != nil {
		t.Fatal(err)
	}
	if auth.User == "" || auth.Pass == "" {
		t.Fatal("rclone.env has no rc user/pass after mount")
	}
	c.SetAuth(auth.User, auth.Pass)
	return c
}

func storedRCAddr(t *testing.T, home string) string {
	t.Helper()
	auth, err := ReadRCAuth(home)
	if err != nil {
		t.Fatal(err)
	}
	if auth.Addr == "" {
		t.Fatal("rclone.env has no rc address after mount")
	}
	if auth.Addr == loopbackRCAddr {
		t.Fatalf("stored rc address is the shipped %s; two mounts would collide", loopbackRCAddr)
	}
	return auth.Addr
}

func startStandinMount(t *testing.T, home, mountDir string, cfg StorageConfig) (*exec.Cmd, func(), string) {
	t.Helper()
	rcAddr := os.Getenv("DRIVE_RC_ADDR")
	if rcAddr == "" {
		rcAddr = "127.0.0.1:" + freePort(t)
	}
	cmd := exec.Command(driveBin(t), "mount",
		"--home", home, "--endpoint", cfg.Endpoint, "--bucket", cfg.Bucket,
		"--prefix", cfg.Prefix, "--foreground")
	cmd.Env = append(os.Environ(),
		"DRIVE_S3_ACCESS_KEY_ID="+cfg.AccessKey,
		"DRIVE_S3_SECRET_ACCESS_KEY="+cfg.SecretKey,
		"DRIVE_RC_ADDR="+rcAddr,
	)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	stop := func() { stopStandinProcess(cmd, mountDir) }
	if !waitForMount(t, cmd, mountDir) {
		stop()
		// The mount's own log is the real reason, not a guess: a reader of
		// this skip needs to know whether the host refused FUSE or the mount
		// had a bad argument (the same tail the conflict proof logs).
		if log, err := os.ReadFile(filepath.Join(home, ".config", "drive", "mount.log")); err == nil {
			t.Logf("mount log:\n%s", tailLines(string(log), 6))
		}
		skipNoMount(t, "this host will not bring up the mount on %s (%s): the proof needs "+
			"an unprivileged FUSE mount on Linux and passwordless sudo for macOS's "+
			"NFS mount", mountDir, mountSkipReason())
	}
	return cmd, stop, rcAddr
}

func mountSkipReason() string {
	if CurrentGOOS() == "darwin" {
		return "macOS runs the mount through the built-in NFS server (passwordless " +
			"sudo), which this host does not give"
	}
	return "the host does not permit an unprivileged FUSE mount (run it inside a " +
		"user namespace: unshare -Urm go test ./cmd/drive -run Standin)"
}

func skipNoMount(t testing.TB, format string, args ...any) {
	t.Helper()
	msg := fmt.Sprintf(format, args...)
	if os.Getenv("CI") == "true" {
		t.Fatalf("%s: a FUSE skip is a failure under CI=true (drive#501)", msg)
	}
	t.Skip(msg)
}

func stopStandinProcess(cmd *exec.Cmd, mountDir string) {
	_ = cmd.Process.Signal(os.Interrupt)
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		<-done
	}
	if err := unmountForCleanup(mountDir); err != nil {
		if on, _ := MountedDir(CurrentGOOS(), mountDir); on {
			fmt.Fprintf(os.Stderr, "drive: unmount %s after the proof: %v\n", mountDir, err)
		}
	}
}

func unmountForCleanup(mountDir string) error {
	if CurrentGOOS() == "darwin" {
		if out, err := exec.Command("umount", mountDir).CombinedOutput(); err != nil {
			return fmt.Errorf("umount %s: %v: %s", mountDir, err, strings.TrimSpace(string(out)))
		}
		return nil
	}
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- literal binary "fusermount3"; the only argument is the mount dir; exec.Command takes an argument vector, not a shell.
	if _, err := exec.Command("fusermount3", "-u", mountDir).CombinedOutput(); err != nil {
		// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- literal binary "fusermount"; the only argument is the mount dir; exec.Command takes an argument vector, not a shell.
		if out, err := exec.Command("fusermount", "-u", mountDir).CombinedOutput(); err != nil {
			return fmt.Errorf("fusermount3/fusermount %s: %v: %s", mountDir, err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

func standinOn(t *testing.T, root, prefix string) (StorageConfig, *exec.Cmd) {
	t.Helper()
	cfg := testStorage()
	const accessKey, secretKey = "ACCESSKEYID", "SECRETACCESSKEY"
	port := freePort(t)
	serve := startRcloneServe(t, filepath.Join(root, "data"), port,
		"--auth-key", accessKey+","+secretKey, "--log-level", "ERROR")
	cfg.Endpoint = "http://127.0.0.1:" + port
	cfg.AccessKey, cfg.SecretKey = accessKey, secretKey
	cfg.Bucket = "bucket"
	cfg.Prefix = prefix
	return cfg, serve
}

func seedStandin(t *testing.T, root string, cfg StorageConfig, env []string, name string, size int64) {
	t.Helper()
	local := filepath.Join(root, "fixtures", name)
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writePatternFile(local, size); err != nil {
		t.Fatal(err)
	}
	seed := exec.Command("rclone", "copyto", local, RemoteFor(cfg)+"/"+name)
	seed.Env = env
	if out, err := seed.CombinedOutput(); err != nil {
		t.Fatalf("seed %s: %v\n%s", name, err, out)
	}
}

func standinEnv(t *testing.T, home string, cfg StorageConfig) []string {
	t.Helper()
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		t.Fatal(err)
	}
	return append(os.Environ(),
		"RCLONE_CONFIG="+RcloneConfigPath(home),
		rcloneSecretEnv+"="+cfg.SecretKey,
	)
}

type openSize struct {
	name string
	size int64
	page int64
}

func openSizes() []openSize {
	if os.Getenv("DRIVE_OPEN_SCALE") == "quick" {
		return []openSize{
			{"doc.bin", 1 << 20, 64 << 10},
			{"video.mp4", 16 << 20, 2 << 20},
			{"big.bin", 32 << 20, 64 << 10},
		}
	}
	return []openSize{
		{"doc.bin", 1 << 20, 64 << 10},
		{"video.mp4", 500 << 20, 2 << 20},
		{"big.bin", 10 << 30, 64 << 10},
	}
}

func timeOpen(path string, page int64) (firstByte, open time.Duration, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	start := time.Now()
	one := make([]byte, 1)
	if _, err := io.ReadFull(f, one); err != nil {
		return 0, 0, err
	}
	firstByte = time.Since(start)
	buf := make([]byte, 32<<10)
	got := int64(1)
	for got < page {
		n, err := io.ReadFull(f, buf)
		got += int64(n)
		if err != nil {
			break
		}
	}
	return firstByte, time.Since(start), nil
}

func median(d []time.Duration) time.Duration {
	if len(d) == 0 {
		return 0
	}
	sorted := append([]time.Duration(nil), d...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	return sorted[len(sorted)/2]
}

func TestOpenTimeColdAndWarm(t *testing.T) {
	if testing.Short() {
		t.Skip("open-time measurement skipped in -short mode")
	}
	root := t.TempDir()
	cfg, _ := standinOn(t, root, "u/open")
	seedHome := filepath.Join(root, "seed-home")
	seedEnv := standinEnv(t, seedHome, cfg)
	sizes := openSizes()
	for _, f := range sizes {
		seedStandin(t, root, cfg, seedEnv, f.name, f.size)
	}

	const runs = 5
	for _, f := range sizes {
		var coldFirst, coldOpen, warmFirst, warmOpen []time.Duration
		for run := range runs {
			home := filepath.Join(root, fmt.Sprintf("home-%d-%d", run, f.size))
			mountDir := filepath.Join(home, "Drive")
			if err := os.MkdirAll(mountDir, 0o755); err != nil {
				t.Fatal(err)
			}
			_ = standinEnv(t, home, cfg)
			_, stop, _ := startStandinMount(t, home, mountDir, cfg)
			fb, open, err := timeOpen(filepath.Join(mountDir, f.name), f.page)
			if err != nil {
				stop()
				t.Fatalf("%s cold run %d: %v", f.name, run, err)
			}
			wfb, wopen, err := timeOpen(filepath.Join(mountDir, f.name), f.page)
			stop()
			if err != nil {
				t.Fatalf("%s warm run %d: %v", f.name, run, err)
			}
			coldFirst = append(coldFirst, fb)
			coldOpen = append(coldOpen, open)
			warmFirst = append(warmFirst, wfb)
			warmOpen = append(warmOpen, wopen)
		}
		coldFB, coldOP := median(coldFirst), median(coldOpen)
		warmFB, warmOP := median(warmFirst), median(warmOpen)
		t.Logf("open-time %s (%s, page %s) storage=stand-in: cold first-byte %s open %s; warm first-byte %s open %s (median of %d runs)",
			f.name, FormatBytes(f.size), FormatBytes(f.page), coldFB, coldOP, warmFB, warmOP, runs)
		if coldOP > 2*time.Second {
			t.Errorf("%s: cold open %s is over the 2 s ceiling", f.name, coldOP)
		}
		if warmOP > 200*time.Millisecond {
			t.Errorf("%s: warm open %s is over the 200 ms ceiling", f.name, warmOP)
		}
	}
}

func TestBackgroundFillFillsThroughTheCappedCache(t *testing.T) {
	if testing.Short() {
		t.Skip("stand-in proof skipped in -short mode")
	}
	root := t.TempDir()
	cfg, _ := standinOn(t, root, "u/fillcap")
	seedHome := filepath.Join(root, "seed-home")
	seedEnv := standinEnv(t, seedHome, cfg)
	const name = "fill.bin"
	seedStandin(t, root, cfg, seedEnv, name, 64<<20)

	home := filepath.Join(root, "home")
	mountDir := filepath.Join(home, "Drive")
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = standinEnv(t, home, cfg)
	_, stop, rcAddr := startStandinMount(t, home, mountDir, cfg)
	defer stop()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	c := rcClientForTestHome(t, home, rcAddr, RemoteFor(cfg))
	before, err := c.stats(ctx)
	if err != nil {
		t.Fatalf("read the running mount's cache stats: %v", err)
	}
	if before.Opt.CacheMaxSize != 20<<30 {
		t.Errorf("the mount's cap is %d bytes, want the 20 GiB the plan sets", before.Opt.CacheMaxSize)
	}
	policy := DefaultFillPolicy()
	wantReadAhead, err := parseSizeSuffix(policy.ReadAhead)
	if err != nil {
		t.Fatal(err)
	}
	if before.Opt.ReadAhead != wantReadAhead {
		t.Errorf("the mount's read-ahead is %d bytes, want the fill's %d", before.Opt.ReadAhead, wantReadAhead)
	}
	wantLimit, err := parseSizeSuffix(policy.ChunkSizeLimit)
	if err != nil {
		t.Fatal(err)
	}
	if before.Opt.ChunkSizeLimit != wantLimit {
		t.Errorf("the mount's chunk-size limit is %d bytes, want the fill's %d", before.Opt.ChunkSizeLimit, wantLimit)
	}

	res, err := fillPass(ctx, c, fillTargets{root: mountDir, recent: []string{name}}, 0, 0)
	if err != nil {
		t.Fatalf("fill pass through the mount: %v", err)
	}
	if !res.Ran() {
		t.Fatal("the fill did not run on an idle machine under the cap")
	}
	if res.BytesAfter <= res.BytesBefore {
		t.Errorf("the fill left the cache at %s, no more than the %s it started at: the fill's bytes did not land in rclone's cache",
			FormatBytes(res.BytesAfter), FormatBytes(res.BytesBefore))
	}
	if res.CapBytes > 0 && res.BytesAfter > res.CapBytes {
		t.Errorf("the fill left the cache at %s, over the %s cap", FormatBytes(res.BytesAfter), FormatBytes(res.CapBytes))
	}
	t.Logf("fill through the mount: cache %s -> %s, cap %s, storage=stand-in",
		FormatBytes(res.BytesBefore), FormatBytes(res.BytesAfter), FormatBytes(res.CapBytes))
}

func TestBackgroundFillDoesNotSlowAForegroundOpen(t *testing.T) {
	if testing.Short() {
		t.Skip("stand-in proof skipped in -short mode")
	}
	root := t.TempDir()
	cfg, _ := standinOn(t, root, "u/fillslow")
	seedHome := filepath.Join(root, "seed-home")
	seedEnv := standinEnv(t, seedHome, cfg)
	const fillName, openName = "fill.bin", "open.bin"
	seedStandin(t, root, cfg, seedEnv, fillName, 128<<20)
	seedStandin(t, root, cfg, seedEnv, openName, 8<<20)

	home := filepath.Join(root, "home")
	mountDir := filepath.Join(home, "Drive")
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = standinEnv(t, home, cfg)
	_, stop, rcAddr := startStandinMount(t, home, mountDir, cfg)
	defer stop()

	openPath := filepath.Join(mountDir, openName)
	if _, _, err := timeOpen(openPath, 64<<10); err != nil {
		t.Fatalf("warm the foreground file: %v", err)
	}
	const runs = 5
	var idle []time.Duration
	for range runs {
		_, open, err := timeOpen(openPath, 64<<10)
		if err != nil {
			t.Fatalf("foreground open with no fill running: %v", err)
		}
		idle = append(idle, open)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	c := rcClientForTestHome(t, home, rcAddr, RemoteFor(cfg))
	filled := make(chan error, 1)
	go func() {
		_, err := fillPass(ctx, c, fillTargets{root: mountDir, recent: []string{fillName}}, 0, 0)
		filled <- err
	}()
	var withFill []time.Duration
	for range runs {
		_, open, err := timeOpen(openPath, 64<<10)
		if err != nil {
			<-filled
			t.Fatalf("foreground open while the fill runs: %v", err)
		}
		withFill = append(withFill, open)
	}
	if err := <-filled; err != nil {
		t.Fatalf("fill pass while a foreground open ran: %v", err)
	}

	idleMedian, fillMedian := median(idle), median(withFill)
	capBytes, err := parseSizeSuffix(vfsCacheMaxValue)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("foreground open of %s while the fill reads %s: %s idle, %s with the fill running; cache cap %s, storage=stand-in",
		openName, fillName, idleMedian, fillMedian, FormatBytes(capBytes))
	if fillMedian > 200*time.Millisecond {
		t.Errorf("foreground open with the fill running was %s, over the 200 ms warm ceiling", fillMedian)
	}
}

var (
	builtBinary string
	builtBinDir string
)

func driveBin(t testing.TB) string {
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

func TestMain(m *testing.M) {
	stopping := make(chan os.Signal, 1)
	notifyShutdown(stopping)
	go func() {
		<-stopping
		signal.Stop(stopping)
		stopTestProcesses()
		benchTeardown()
		if builtBinDir != "" {
			_ = os.RemoveAll(builtBinDir)
		}
		os.Exit(1)
	}()
	code := m.Run()
	stopTestProcesses()
	benchTeardown()
	if builtBinDir != "" {
		_ = os.RemoveAll(builtBinDir)
	}
	os.Exit(code)
}

func TestCacheCapHoldsThroughAReadPastIt(t *testing.T) {
	if testing.Short() {
		t.Skip("stand-in proof skipped in -short mode")
	}
	root := t.TempDir()
	cfg, _ := standinOn(t, root, "u/cachecap")
	seedHome := filepath.Join(root, "seed-home")
	seedEnv := standinEnv(t, seedHome, cfg)
	const capSize = "24M"
	seedStandin(t, root, cfg, seedEnv, "one.bin", 6<<20)
	seedStandin(t, root, cfg, seedEnv, "two.bin", 6<<20)
	seedStandin(t, root, cfg, seedEnv, "three.bin", 6<<20)
	seedStandin(t, root, cfg, seedEnv, "four.bin", 6<<20)
	seedStandin(t, root, cfg, seedEnv, "five.bin", 6<<20)
	seedStandin(t, root, cfg, seedEnv, "six.bin", 6<<20)

	home := filepath.Join(root, "home")
	mountDir := filepath.Join(home, "Drive")
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeCacheMax(t, home, capSize)
	_ = standinEnv(t, home, cfg)
	t.Setenv("DRIVE_RC_ADDR", "127.0.0.1:"+freePort(t))
	_, stop, _ := startStandinMount(t, home, mountDir, cfg)
	defer stop()

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	c := rcClientForTestHome(t, home, RCAddr(), RemoteFor(cfg))
	stats, err := c.stats(ctx)
	if err != nil {
		t.Fatalf("read the running mount's cache stats: %v", err)
	}
	wantCap, err := parseSizeSuffix(capSize)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Opt.CacheMaxSize != wantCap {
		t.Fatalf("the mount's --vfs-cache-max-size is %d bytes, want the %d the person set", stats.Opt.CacheMaxSize, wantCap)
	}
	wantFloor, err := parseSizeSuffix(vfsCacheMinFreeSpaceValue)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Opt.CacheMinFreeSpace != wantFloor {
		t.Errorf("the mount's --vfs-cache-min-free-space is %d bytes, want %d", stats.Opt.CacheMinFreeSpace, wantFloor)
	}

	for _, name := range []string{"one.bin", "two.bin", "three.bin", "four.bin", "five.bin", "six.bin"} {
		if _, err := fillReadFile(context.Background(), filepath.Join(mountDir, name)); err != nil {
			t.Fatalf("read %s through the mount: %v", name, err)
		}
	}
	deadline := time.Now().Add(2 * time.Minute)
	var used, capBytes int64
	var files int
	for {
		used, files, err = CacheUse(DefaultCacheDir(home))
		if err != nil {
			t.Fatal(err)
		}
		capBytes, err = liveCacheBytes(stats.DiskCache.Path, stats.DiskCache.BytesUsed)
		if err != nil {
			t.Fatal(err)
		}
		if used <= wantCap {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the cache is %s, still over the %s cap, two minutes after the read", FormatBytes(used), capSize)
		}
		time.Sleep(2 * time.Second)
	}
	t.Logf("read 6 x 6 MiB through the mount with a %s cap: cache on disk %s in %d files (rclone's own count %s), storage=stand-in, repeat: go test ./cmd/drive -run TestCacheCapHoldsThroughAReadPastIt -v",
		capSize, FormatBytes(used), files, FormatBytes(capBytes))
	if used > wantCap {
		t.Errorf("the cache is %s, over the %s cap it was given", FormatBytes(used), capSize)
	}
	if files == 0 {
		t.Error("nothing landed in the cache, so the read never reached the mount's cache")
	}
}
