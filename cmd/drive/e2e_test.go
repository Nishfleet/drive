package main

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
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

	var current *exec.Cmd
	mount := func() *exec.Cmd {
		cmd, _ := startStandinMount(t, home, mountDir, cfg)
		current = cmd
		return cmd
	}
	// Clean up whatever mount is current even if an assertion below fails,
	// so a failing run does not leave an orphaned rclone mount behind.
	defer func() {
		if current != nil {
			stopStandinProcess(current, mountDir)
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

// waitForMount waits for the mount to appear. A plain directory that never
// becomes a mount point while rclone is still running means the host refuses
// the FUSE mount (a CI runner without /dev/fuse): that is a skip, reported by
// the caller. An rclone that has already exited is a real failure.
func waitForMount(t testing.TB, cmd *exec.Cmd, dir string) bool {
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

// startStandinMount starts `drive mount --foreground` for home against cfg and
// waits until the kernel reports the mount, so a test reads through a real
// mount rather than a directory that never became one. The keys reach the child
// through the environment, never argv: a command line is world-readable in
// `ps` for the life of the process. A host that refuses an unprivileged FUSE
// mount skips the calling test, naming the user-namespace fallback; an rclone
// that exits before mounting is still a real failure.
func startStandinMount(t *testing.T, home, mountDir string, cfg StorageConfig) (*exec.Cmd, func()) {
	t.Helper()
	cmd := exec.Command(driveBin(t), "mount",
		"--home", home, "--endpoint", cfg.Endpoint, "--bucket", cfg.Bucket,
		"--prefix", cfg.Prefix, "--foreground")
	cmd.Env = append(os.Environ(),
		"DRIVE_S3_ACCESS_KEY_ID="+cfg.AccessKey,
		"DRIVE_S3_SECRET_ACCESS_KEY="+cfg.SecretKey,
	)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	stop := func() { stopStandinProcess(cmd, mountDir) }
	if !waitForMount(t, cmd, mountDir) {
		stop()
		t.Skipf("this host does not permit an unprivileged FUSE mount on %s; "+
			"run the proof in a user namespace: unshare -Urm go test ./cmd/drive -run Standin", mountDir)
	}
	return cmd, stop
}

// stopStandinProcess stops a foreground mount the way the test namespace allows: signal
// the CLI, wait for it, then clear a stale mount point. The CLI's own Unmount
// (systemd on Linux) is not available in the test namespace.
func stopStandinProcess(cmd *exec.Cmd, mountDir string) {
	// The signal fails when the child is already gone, which is not an error:
	// the fusermount below still clears the mount point.
	_ = cmd.Process.Signal(os.Interrupt)
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

// standinOn starts a loopback `rclone serve s3` on root/data (the stock stand-in
// step 1 uses) and returns the storage config that reaches it, so a proof on
// this host runs the same mount the product runs against the real account with
// no code change. Credentials are constants: the server is loopback only and
// the config file is written under this test's TempDir.
func standinOn(t *testing.T, root, prefix string) StorageConfig {
	t.Helper()
	if _, err := exec.LookPath("rclone"); err != nil {
		t.Skip("rclone is not installed")
	}
	cfg := testStorage()
	const accessKey, secretKey = "ACCESSKEYID", "SECRETACCESSKEY"
	port := freePort(t)
	serve := exec.Command("rclone", "serve", "s3", filepath.Join(root, "data"),
		"--auth-key", accessKey+","+secretKey,
		"--addr", "127.0.0.1:"+port, "--log-level", "ERROR")
	serve.Stdout, serve.Stderr = os.Stdout, os.Stderr
	if err := serve.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = serve.Process.Kill()
		_, _ = serve.Process.Wait()
	})
	waitForPort(t, port)
	cfg.Endpoint = "http://127.0.0.1:" + port
	cfg.AccessKey, cfg.SecretKey = accessKey, secretKey
	cfg.Bucket = "bucket"
	cfg.Prefix = prefix
	return cfg
}

// seedStandin writes one fixture of size bytes into the stand-in's storage
// through stock rclone, so the fixture is an object, not a local file the
// mount happens to see. Seeding is setup, never a measurement.
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

// standinEnv writes the rclone config for home and returns the environment a
// direct rclone call needs to reach the same remote the mount uses.
func standinEnv(t *testing.T, home string, cfg StorageConfig) []string {
	t.Helper()
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		t.Fatal(err)
	}
	return append(os.Environ(), "RCLONE_CONFIG="+RcloneConfigPath(home))
}

// openSizes are the three files issue #194 names, and the bytes that count as
// opening them: the first page of a document or a large file, and a video's
// play-start buffer. DRIVE_OPEN_SCALE=quick shrinks them so the harness can be
// proved in under a minute without a 10 GB seed.
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

// timeOpen opens path through the mount and returns the time to the first byte
// and the time to read `page` bytes. Both clock from the open call, which is
// where an app starts waiting.
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

// median is the middle sample of an odd, already-collected set: the number the
// issue asks for instead of a mean a single slow run could drag.
func median(d []time.Duration) time.Duration {
	if len(d) == 0 {
		return 0
	}
	sorted := append([]time.Duration(nil), d...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	return sorted[len(sorted)/2]
}

// TestOpenTimeColdAndWarm is the issue #194 measurement: the time to first byte
// and to open (first page, or a video's play start) through the mount, cold and
// warm, for the 1 MB document, the 500 MB video and the 10 GB file. Cold is a
// mount whose VFS cache has never seen the file, so each cold run gets a fresh
// home and cache; warm is the read right after it on the same mount. Five runs
// each, median reported, and the finish line's ceilings asserted: <= 2 s cold
// and <= 200 ms warm. Stand-in figures are a harness proof, never publishable
// (issue #242 owns the real-storage run), which is why every line names it.
func TestOpenTimeColdAndWarm(t *testing.T) {
	if testing.Short() {
		t.Skip("open-time measurement skipped in -short mode")
	}
	root := t.TempDir()
	cfg := standinOn(t, root, "u/open")
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
			_, stop := startStandinMount(t, home, mountDir, cfg)
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

// TestBackgroundFillFillsThroughTheCappedCache proves the cap rule on a real
// mount instead of a comment: the fill's bytes land in rclone's own VFS cache,
// whose cap is read live from the running mount (--vfs-cache-max-size, the
// user's number from the plan), and a fill pass cannot leave that cache over it.
// It also proves the mount really carries the stock read-ahead and chunk-limit
// flags the fill is made of, by reading them back from rclone rather than from
// this process's copy of the plan. Stand-in figures are a harness proof, never
// publishable (issue #242 owns the real-storage run).
func TestBackgroundFillFillsThroughTheCappedCache(t *testing.T) {
	if testing.Short() {
		t.Skip("stand-in proof skipped in -short mode")
	}
	root := t.TempDir()
	cfg := standinOn(t, root, "u/fillcap")
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
	_, stop := startStandinMount(t, home, mountDir, cfg)
	defer stop()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	c := newRCClient("rclone", loopbackRCAddr, RemoteFor(cfg))
	before, err := c.stats(ctx)
	if err != nil {
		t.Fatalf("read the running mount's cache stats: %v", err)
	}
	// The cap is the user's, read live from the mount rather than a second copy
	// in this test; "the fill never crosses it" is only meaningful with it.
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

	res, err := fillPass(ctx, c, false, 0, 0, fillReader(mountDir))
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

// TestBackgroundFillDoesNotSlowAForegroundOpen measures the third rule: while a
// fill pass reads a large file into the cache, a foreground open of another
// file already in the cache still opens inside the warm ceiling. Five runs each,
// median reported. Stand-in figures are a harness proof, never publishable
// (issue #242 owns the real-storage run).
func TestBackgroundFillDoesNotSlowAForegroundOpen(t *testing.T) {
	if testing.Short() {
		t.Skip("stand-in proof skipped in -short mode")
	}
	root := t.TempDir()
	cfg := standinOn(t, root, "u/fillslow")
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
	_, stop := startStandinMount(t, home, mountDir, cfg)
	defer stop()

	openPath := filepath.Join(mountDir, openName)
	// Warm the foreground file once; the rule is about a warm open staying warm
	// while the fill runs, not about a cold read.
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
	c := newRCClient("rclone", loopbackRCAddr, RemoteFor(cfg))
	filled := make(chan error, 1)
	go func() {
		_, err := fillPass(ctx, c, false, 0, 0, func(string, bool) error {
			_, err := fillReadFile(filepath.Join(mountDir, fillName))
			return err
		})
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

// driveBin builds the CLI once and returns its path. The binary outlives the
// test that built it: a per-test TempDir would be deleted with that test, and
// a second caller would then exec a path that no longer exists.
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

// TestMain removes the built binary's directory after the run, since no single
// test owns it (any test may have been the one to build it).
func TestMain(m *testing.M) {
	code := m.Run()
	// The benchmark harness (bench_test.go) is started once for a -bench run
	// and owns two child processes, so it stops them here rather than leaving
	// orphans behind on the host.
	benchTeardown()
	if builtBinDir != "" {
		_ = os.RemoveAll(builtBinDir)
	}
	os.Exit(code)
}
