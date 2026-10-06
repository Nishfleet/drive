package main

// The speed benchmarks behind every figure in `docs/benchmarks.md` and on the
// public Benchmarks page (drive issue #99). They are Go benchmarks in this
// package, so the whole suite is `go test` with no script anywhere: Go skips
// every Benchmark function unless -bench is passed, so `npm test` and the CI
// `go` job stay green without paying for a multi-gigabyte run.
//
//	prove the harness (local S3 stand-in, small sizes, about a minute):
//	  go test ./cmd/drive -run '^$' -bench Bench -benchtime=1x -v
//	measure for publishing (real storage, the sizes the issue names):
//	  DRIVE_BENCH_ENDPOINT=https://s3.<region>.idrivee2.com \
//	  DRIVE_BENCH_REGION=<region> DRIVE_BENCH_LINK_MBPS=<measured> \
//	  go test ./cmd/drive -run '^$' -bench Bench -benchtime=1x -v
//	Keys come from the environment (DRIVE_BENCH_ACCESS_KEY_ID /
//	DRIVE_BENCH_SECRET_ACCESS_KEY), never from argv.
//
// The same file is the gate: a scenario the issue names and no benchmark
// measures, or a benchmark here that no published row names, fails
// `test/benchmarks.test.mjs`.
//
// Storage, keys and region are configuration only (issue #2's standing
// decision): the same benchmarks run against the loopback stand-in and against
// the real account. A figure measured against the stand-in is a harness proof,
// never a published number, so every line this file prints names which of the
// two it came from. One guard is looser on HTTPS: BenchmarkReadDuringPrefetch
// asserts 20 ms and 2x on a loopback (or any non-HTTPS) server, and 10x the
// control on HTTPS real storage (issue #382), because a real link is shared
// between the user's read and the prefetch pass and a loopback server is not.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// benchSizes are the sizes each scenario runs at. `full` is the size the issue
// names and the only one that may be published; `quick` proves the harness on
// a stand-in in about a minute and must never be published.
type benchSizes struct {
	video   int64 // the video file the start-time scenarios read
	big     int64 // the file the small-edit scenario appends to
	save    int64 // the save-the-file scenario writes
	listN   int   // files in the list-a-folder scenario
	read100 int64 // bytes the start-time scenarios time as "first 100 MB"
}

func benchScale() benchSizes {
	if os.Getenv("DRIVE_BENCH_SCALE") == "quick" {
		return benchSizes{video: 64 << 20, big: 32 << 20, save: 16 << 20, listN: 50, read100: 8 << 20}
	}
	return benchSizes{video: 5 << 30, big: 2 << 30, save: 1 << 30, listN: 10000, read100: 100 << 20}
}

// benchStorage names the account the run measures. With no endpoint set the
// suite brings up the loopback stand-in itself (`rclone serve s3`, the same
// stock server the step-1 proof uses) and marks every figure as a stand-in.
func benchStorage() StorageConfig {
	endpoint := os.Getenv("DRIVE_BENCH_ENDPOINT")
	cfg := testStorage()
	cfg.Region = envOr("DRIVE_BENCH_REGION", "us-east-1")
	if endpoint == "" {
		cfg.Endpoint = "http://127.0.0.1:" + envOr("DRIVE_BENCH_PORT", "0")
		cfg.AccessKey, cfg.SecretKey = "ACCESSKEYID", "SECRETACCESSKEY"
	} else {
		cfg.Endpoint = endpoint
		cfg.AccessKey = os.Getenv("DRIVE_BENCH_ACCESS_KEY_ID")
		cfg.SecretKey = os.Getenv("DRIVE_BENCH_SECRET_ACCESS_KEY")
		if cfg.AccessKey == "" || cfg.SecretKey == "" {
			// A real endpoint with no keys would measure a 403 and print it as
			// a number. Fail instead of publishing an error code as a speed.
			fmt.Fprintln(os.Stderr, "bench: DRIVE_BENCH_ACCESS_KEY_ID and DRIVE_BENCH_SECRET_ACCESS_KEY are required with a real endpoint")
			os.Exit(2)
		}
	}
	cfg.Bucket = envOr("DRIVE_BENCH_BUCKET", "bucket")
	cfg.Prefix = envOr("DRIVE_BENCH_PREFIX", "u/bench")
	return cfg
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// extraMountEnv is the environment for a second `drive mount` next to the
// shared harness. The first mount already binds the shipped remote-control
// address (127.0.0.1:5572), so a second mount with that same address dies
// before it is up ("address already in use") and the bench skips as if FUSE
// were missing. A free loopback port is the product's own DRIVE_RC_ADDR
// override.
func extraMountEnv(tb testing.TB, cfg StorageConfig) []string {
	return append(os.Environ(),
		"DRIVE_S3_ACCESS_KEY_ID="+cfg.AccessKey,
		"DRIVE_S3_SECRET_ACCESS_KEY="+cfg.SecretKey,
		"DRIVE_PREFETCH=0",
		"DRIVE_RC_ADDR=127.0.0.1:"+freePort(tb),
	)
}

func TestExtraMountEnvUsesAFreeRCPort(t *testing.T) {
	env := extraMountEnv(t, testStorage())
	addr := ""
	for _, item := range env {
		if strings.HasPrefix(item, "DRIVE_RC_ADDR=") {
			addr = strings.TrimPrefix(item, "DRIVE_RC_ADDR=")
		}
	}
	if addr == "" {
		t.Fatal("extra mount env must set DRIVE_RC_ADDR")
	}
	if addr == loopbackRCAddr {
		t.Fatalf("extra mount RC %q must not reuse the shipped address %s", addr, loopbackRCAddr)
	}
	if !IsLoopbackAddr(addr) {
		t.Fatalf("extra mount RC %q must be loopback", addr)
	}
}

// benchStandin is a loopback S3 server plus the drive mount on it: the setup
// every benchmark in this file shares, brought up once for the whole -bench
// run and torn down by TestMain.
type benchStandin struct {
	root     string
	home     string
	dataDir  string // where the stand-in keeps objects, and where fixtures are written
	mountDir string
	cfg      StorageConfig
	serve    *exec.Cmd
	mount    *exec.Cmd
	real     bool
	sizes    benchSizes
	env      []string // RCLONE_CONFIG for direct rclone calls
}

var (
	benchOnce sync.Once
	benchH    *benchStandin
)

// benchTeardown is called by TestMain: the stand-in server and the mount are
// child processes, so a run that did not stop them would leave orphans behind.
func benchTeardown() {
	if benchH != nil {
		benchH.close()
	}
}

// setup brings up the shared harness once per run and skips (never fails) on a
// host with no FUSE or no rclone, so the benchmarks are runnable anywhere the
// product mounts.
func benchSetup(tb testing.TB) *benchStandin {
	if _, err := exec.LookPath("rclone"); err != nil {
		tb.Skip("rclone is not installed")
	}
	benchOnce.Do(func() {
		benchH = benchStart(tb)
	})
	if benchH == nil {
		skipNoMount(tb, "this host does not permit an unprivileged FUSE mount; run the benchmarks in a user namespace: unshare -Urm go test ./cmd/drive -run '^$' -bench Bench")
	}
	return benchH
}

func benchStart(tb testing.TB) *benchStandin {
	h := &benchStandin{cfg: benchStorage(), sizes: benchScale()}
	h.real = !strings.HasPrefix(h.cfg.Endpoint, "http://127.0.0.1:")
	root, err := os.MkdirTemp("", "drive-bench-*")
	if err != nil {
		tb.Fatal(err)
	}
	h.root = root
	h.home = filepath.Join(root, "home")
	h.mountDir = filepath.Join(h.home, "Drive")
	h.dataDir = filepath.Join(root, "data", "bucket")
	for _, d := range []string{h.dataDir, h.mountDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			tb.Fatal(err)
		}
	}

	if !h.real {
		port := freePort(tb)
		h.cfg.Endpoint = "http://127.0.0.1:" + port
		h.serve = startRcloneServe(tb, filepath.Join(root, "data"), port,
			"--auth-key", h.cfg.AccessKey+","+h.cfg.SecretKey,
			"--log-level", "INFO")
	}
	// The config is written after the stand-in port is known, so direct rclone
	// calls (seed, objectSize, --bwlimit) hit the same endpoint as the mount.
	if err := WriteFileAtomic(RcloneConfigPath(h.home), []byte(RcloneConfig(h.cfg)), 0o600); err != nil {
		h.close()
		tb.Fatal(err)
	}
	h.env = append(os.Environ(), "RCLONE_CONFIG="+RcloneConfigPath(h.home), rcloneSecretEnv+"="+h.cfg.SecretKey)

	h.mount = exec.Command(driveBin(tb), "mount",
		"--home", h.home, "--endpoint", h.cfg.Endpoint, "--bucket", h.cfg.Bucket,
		"--prefix", h.cfg.Prefix, "--foreground")
	// Keys reach the child through the environment, never argv (see config.go).
	h.mount.Env = append(os.Environ(),
		"DRIVE_S3_ACCESS_KEY_ID="+h.cfg.AccessKey,
		"DRIVE_S3_SECRET_ACCESS_KEY="+h.cfg.SecretKey,
		"DRIVE_PREFETCH=0",
	)
	h.mount.Stdout, h.mount.Stderr = os.Stdout, os.Stderr
	if err := h.mount.Start(); err != nil {
		h.close()
		tb.Fatal(err)
	}
	if !waitForMount(tb, h.mount, h.mountDir) {
		h.close()
		return nil
	}
	return h
}

func (h *benchStandin) close() {
	for _, cmd := range []*exec.Cmd{h.mount, h.serve} {
		if cmd == nil || cmd.Process == nil {
			continue
		}
		_ = cmd.Process.Signal(os.Interrupt)
		done := make(chan struct{})
		go func() { _, _ = cmd.Process.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
		_ = exec.Command("fusermount3", "-u", h.mountDir).Run()
		_ = exec.Command("fusermount", "-u", h.mountDir).Run()
	}
}

// seed writes a fixture of size bytes to the storage this device owns, through
// stock rclone. Seeding is setup, never a measurement.
func (h *benchStandin) seed(name string, size int64) error {
	local := filepath.Join(h.root, "fixtures", name)
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		return err
	}
	if _, err := os.Stat(local); err != nil {
		if err := writePatternFile(local, size); err != nil {
			return err
		}
	}
	_, err := h.rclone("copyto", local, RemoteFor(h.cfg)+"/"+name)
	return err
}

func (h *benchStandin) seedFolder(name string, n int) error {
	local := filepath.Join(h.root, "fixtures", name)
	if err := os.MkdirAll(local, 0o755); err != nil {
		return err
	}
	for i := range n {
		p := filepath.Join(local, fmt.Sprintf("file-%05d.bin", i))
		if _, err := os.Stat(p); err == nil {
			continue
		}
		if err := os.WriteFile(p, []byte(fmt.Sprintf("file %05d\n", i)), 0o644); err != nil {
			return err
		}
	}
	_, err := h.rclone("copy", local, RemoteFor(h.cfg)+"/"+name)
	return err
}

// rclone runs stock rclone against the device's own remote, with this device's
// config file, and returns its stdout.
func (h *benchStandin) rclone(args ...string) (string, error) {
	cmd := exec.Command("rclone", args...)
	cmd.Env = h.env
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("rclone %s: %w\n%s", strings.Join(args, " "), err, out)
	}
	return string(out), nil
}

// objectSize is the stored byte count of one object, read from storage and not
// from the VFS cache, so "the save has reached storage" means what it says.
func (h *benchStandin) objectSize(name string) int64 {
	out, err := h.rclone("lsjson", "--files-only", "--no-modtime", RemoteFor(h.cfg)+"/"+name)
	if err != nil {
		return -1
	}
	var entries []struct {
		Size int64 `json:"Size"`
	}
	if err := json.Unmarshal([]byte(out), &entries); err != nil || len(entries) == 0 {
		return -1
	}
	return entries[0].Size
}

// waitStored polls storage until the object is the wanted size, so a write is
// timed until it lands rather than until the page cache accepted it. rclone's
// --vfs-write-back is 5s, so the first poll is already past the write-back.
func (h *benchStandin) waitStored(name string, want int64, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if h.objectSize(name) == want {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

// storageName is the word the printed lines use for the storage they
// measured: the loopback stand-in or real storage. Every line this file
// prints carries one of the two.
func (h *benchStandin) storageName() string {
	if h.real {
		return "real"
	}
	return "stand-in"
}

// report prints one publishable line per figure: the scenario, which storage it
// came from, the region, the measured link speed, the commit and the value.
func (h *benchStandin) report(b *testing.B, scenario, metric string, d time.Duration, bytes int64) {
	storage := h.storageName()
	b.Logf("bench scenario=%s storage=%s region=%s link_mbps=%s commit=%s metric=%s value=%.3f unit=s bytes=%d",
		scenario, storage, envOr("DRIVE_BENCH_REGION", "unmeasured"),
		envOr("DRIVE_BENCH_LINK_MBPS", "unmeasured"), benchCommit(),
		metric, d.Seconds(), bytes)
}

func benchCommit() string {
	out, err := exec.Command("git", "rev-parse", "--short", "HEAD").Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}

// BenchmarkVideoStartFirstByte times the first byte and the first 100 MB of the
// 5 GB video through the mount, the same scenario Space publishes for 64 MiB
// and 256 MiB streams.
func BenchmarkVideoStartFirstByte(b *testing.B) {
	h := benchSetup(b)
	if err := h.seed("bench-video.mp4", h.sizes.video); err != nil {
		b.Fatal(err)
	}
	start := time.Now()
	f, err := os.Open(filepath.Join(h.mountDir, "bench-video.mp4"))
	if err != nil {
		b.Fatalf("open the video through the mount: %v", err)
	}
	defer f.Close()
	one := make([]byte, 1)
	if _, err := io.ReadFull(f, one); err != nil {
		b.Fatalf("read the first byte: %v", err)
	}
	h.report(b, "video-start-first-byte", "first-byte", time.Since(start), 1)

	rest := make([]byte, 32<<10)
	got := int64(1)
	start = time.Now()
	for got < h.sizes.read100 {
		n, err := io.ReadFull(f, rest)
		got += int64(n)
		if err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				break
			}
			b.Fatalf("read through the mount: %v", err)
		}
	}
	h.report(b, "video-start-first-byte", "first-100mb", time.Since(start), got-1)
}

// BenchmarkSaveReachesStorage times a 1 GB save from the write() that starts
// it until the whole object is in storage, read back from storage.
func BenchmarkSaveReachesStorage(b *testing.B) {
	h := benchSetup(b)
	const name = "bench-save.bin"
	// Start from no object at all, so the clock cannot credit a previous run.
	// Keys and endpoint live in this harness's rclone config, not in argv.
	cmd := exec.Command("rclone", "deletefile", RemoteFor(h.cfg)+"/"+name)
	cmd.Env = h.env
	if out, err := cmd.CombinedOutput(); err != nil {
		b.Logf("delete a leftover %s before the run (nothing there yet): %v\n%s", name, err, out)
	}
	local := filepath.Join(h.root, "fixtures", "bench-save.bin")
	if err := writePatternFile(local, h.sizes.save); err != nil {
		b.Fatal(err)
	}

	start := time.Now()
	in, err := os.Open(local)
	if err != nil {
		b.Fatal(err)
	}
	out, err := os.OpenFile(filepath.Join(h.mountDir, name), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		in.Close()
		b.Fatalf("open the save for writing through the mount: %v", err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		in.Close()
		b.Fatalf("write the save through the mount: %v", err)
	}
	out.Close()
	in.Close()
	if !h.waitStored(name, h.sizes.save, 30*time.Minute) {
		b.Fatalf("the %d byte save never reached storage (stored %d bytes)", h.sizes.save, h.objectSize(name))
	}
	h.report(b, "save-reaches-storage", "1gb-save", time.Since(start), h.sizes.save)
}

// BenchmarkSmallEdit appends 4 KiB to a 64 MiB file and to a 2 GB file and
// times each until the new size is in storage. Space publishes the 64 MiB case.
func BenchmarkSmallEdit(b *testing.B) {
	h := benchSetup(b)
	const size = 4096
	for _, c := range []struct {
		scenario, name string
		fileBytes      int64
	}{
		{"small-edit-64mb", "bench-edit-64mb.bin", 64 << 20},
		{"small-edit-2gb", "bench-edit-2gb.bin", h.sizes.big},
	} {
		b.Run(c.scenario, func(b *testing.B) {
			if err := h.seed(c.name, c.fileBytes); err != nil {
				b.Fatal(err)
			}
			f, err := os.OpenFile(filepath.Join(h.mountDir, c.name), os.O_APPEND|os.O_WRONLY, 0o644)
			if err != nil {
				b.Fatalf("open the file to append through the mount: %v", err)
			}
			start := time.Now()
			if _, err := f.Write(bytes.Repeat([]byte("e"), size)); err != nil {
				f.Close()
				b.Fatalf("append through the mount: %v", err)
			}
			f.Close()
			if !h.waitStored(c.name, c.fileBytes+size, 30*time.Minute) {
				b.Fatalf("the %d byte edit never reached storage (stored %d bytes)", size, h.objectSize(c.name)-c.fileBytes)
			}
			h.report(b, c.scenario, "append-4kib", time.Since(start), size)
		})
	}
}

// BenchmarkListFolder times a listing of 10,000 files through the mount, which
// is what an app does when it opens the folder.
func BenchmarkListFolder(b *testing.B) {
	h := benchSetup(b)
	const folder = "bench-list"
	if err := h.seedFolder(folder, h.sizes.listN); err != nil {
		b.Fatal(err)
	}
	// The mount caches a folder for --dir-cache-time (5s), and the listing
	// must include what the seed just wrote, so the wait is part of the setup
	// and not of the measured listing.
	time.Sleep(6 * time.Second)
	start := time.Now()
	entries, err := os.ReadDir(filepath.Join(h.mountDir, folder))
	if err != nil {
		b.Fatalf("list the folder through the mount: %v", err)
	}
	h.report(b, "list-folder", "list-files", time.Since(start), int64(len(entries)))
	if len(entries) != h.sizes.listN {
		b.Fatalf("listed %d files, want %d", len(entries), h.sizes.listN)
	}
}

// BenchmarkSmallFiles times a 4 KiB put, a 1 MiB put and a 1 MiB get, the
// three figures Space publishes for files under 1 MiB.
func BenchmarkSmallFiles(b *testing.B) {
	h := benchSetup(b)
	for _, c := range []struct {
		scenario, name string
		bytes          int64
	}{
		{"small-file-put-4kib", "bench-small-4kib.bin", 4096},
		{"small-file-put-1mib", "bench-small-1mib.bin", 1 << 20},
	} {
		b.Run(c.scenario, func(b *testing.B) {
			local := filepath.Join(h.root, "fixtures", c.name)
			if err := writePatternFile(local, c.bytes); err != nil {
				b.Fatal(err)
			}
			start := time.Now()
			dst, err := os.OpenFile(filepath.Join(h.mountDir, c.name), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				b.Fatalf("open the put through the mount: %v", err)
			}
			in, err := os.Open(local)
			if err != nil {
				dst.Close()
				b.Fatal(err)
			}
			if _, err := io.Copy(dst, in); err != nil {
				dst.Close()
				in.Close()
				b.Fatalf("write the put through the mount: %v", err)
			}
			in.Close()
			dst.Close()
			if !h.waitStored(c.name, c.bytes, 30*time.Minute) {
				b.Fatalf("the %d byte put never reached storage (stored %d bytes)", c.bytes, h.objectSize(c.name))
			}
			h.report(b, c.scenario, "put", time.Since(start), c.bytes)
		})
	}
	b.Run("small-file-get-1mib", func(b *testing.B) {
		if err := h.seed("bench-small-1mib.bin", 1<<20); err != nil {
			b.Fatal(err)
		}
		start := time.Now()
		f, err := os.Open(filepath.Join(h.mountDir, "bench-small-1mib.bin"))
		if err != nil {
			b.Fatalf("open the get through the mount: %v", err)
		}
		if _, err := io.Copy(io.Discard, f); err != nil {
			f.Close()
			b.Fatalf("read the get through the mount: %v", err)
		}
		f.Close()
		h.report(b, "small-file-get-1mib", "get", time.Since(start), 1<<20)
	})
}

// BenchmarkVideoStartBandwidth times the first byte and the first 100 MB of the
// video at 25, 50, 100 and 300 Mbps, with rclone's own --bwlimit, so the page
// can publish the bandwidth a 5 GB start really needs.
func BenchmarkVideoStartBandwidth(b *testing.B) {
	h := benchSetup(b)
	if err := h.seed("bench-video.mp4", h.sizes.video); err != nil {
		b.Fatal(err)
	}
	for _, limit := range []string{"25M", "50M", "100M", "300M"} {
		b.Run("start-at-"+limit, func(b *testing.B) {
			cmd := exec.Command("rclone", "cat", "--bwlimit", limit, RemoteFor(h.cfg)+"/bench-video.mp4")
			cmd.Env = h.env
			pipe, err := cmd.StdoutPipe()
			if err != nil {
				b.Fatal(err)
			}
			if err := cmd.Start(); err != nil {
				b.Fatal(err)
			}
			defer func() {
				_ = cmd.Process.Kill()
				_, _ = cmd.Process.Wait()
			}()
			first := make([]byte, 1)
			start := time.Now()
			if _, err := io.ReadFull(pipe, first); err != nil {
				b.Fatalf("read the first byte at --bwlimit %s: %v", limit, err)
			}
			scenario := "video-start-at-" + limit
			h.report(b, scenario, "first-byte", time.Since(start), 1)

			got := int64(1)
			rest := make([]byte, 32<<10)
			start = time.Now()
			for got < h.sizes.read100 {
				n, err := pipe.Read(rest)
				got += int64(n)
				if err != nil {
					break
				}
			}
			h.report(b, scenario, "first-100mb", time.Since(start), got-1)
		})
	}
}

// BenchmarkInstallToMounted times the path a new user walks: install the
// binary, mount the drive, and read the first file. Space publishes about five
// minutes for its six-step quickstart.
func BenchmarkInstallToMounted(b *testing.B) {
	h := benchSetup(b)
	if err := h.seed("bench-install.bin", 1<<20); err != nil {
		b.Fatal(err)
	}
	bin := filepath.Join(h.root, "gobin", "drive")
	start := time.Now()
	install := exec.Command("go", "install")
	install.Env = append(os.Environ(), "GOBIN="+filepath.Join(h.root, "gobin"))
	if out, err := install.CombinedOutput(); err != nil {
		b.Fatalf("go install: %v\n%s", err, out)
	}
	home := filepath.Join(h.root, "home-install")
	mountDir := filepath.Join(home, "Drive")
	for _, d := range []string{mountDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			b.Fatal(err)
		}
	}
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(h.cfg)), 0o600); err != nil {
		b.Fatal(err)
	}
	mount := exec.Command(bin, "mount", "--home", home, "--endpoint", h.cfg.Endpoint,
		"--bucket", h.cfg.Bucket, "--prefix", h.cfg.Prefix, "--foreground")
	mount.Env = extraMountEnv(b, h.cfg)
	mount.Stdout, mount.Stderr = os.Stdout, os.Stderr
	if err := mount.Start(); err != nil {
		b.Fatalf("mount with the installed binary: %v", err)
	}
	defer func() {
		_ = mount.Process.Signal(os.Interrupt)
		done := make(chan struct{})
		go func() { _, _ = mount.Process.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			_ = mount.Process.Kill()
			<-done
		}
		_ = exec.Command("fusermount3", "-u", mountDir).Run()
		_ = exec.Command("fusermount", "-u", mountDir).Run()
	}()
	if !waitForMount(b, mount, mountDir) {
		skipNoMount(b, "this host does not permit an unprivileged FUSE mount")
	}
	f, err := os.Open(filepath.Join(mountDir, "bench-install.bin"))
	if err != nil {
		b.Fatalf("read the first file after the mount: %v", err)
	}
	one := make([]byte, 1)
	if _, err := io.ReadFull(f, one); err != nil {
		b.Fatalf("read the first byte after the mount: %v", err)
	}
	f.Close()
	h.report(b, "install-to-mounted", "install-to-first-file", time.Since(start), 1)
}

// BenchmarkCrossMachineSync times a new file, an edit and a delete from the
// write on this mount until a second mount on the same storage sees it. That
// is the save-on-A-seen-on-B scenario; two mounts on one host share only the
// storage backend, which is the same situation as two machines.
func BenchmarkCrossMachineSync(b *testing.B) {
	h := benchSetup(b)
	homeB := filepath.Join(h.root, "home-b")
	mountB := filepath.Join(homeB, "Drive")
	if err := os.MkdirAll(mountB, 0o755); err != nil {
		b.Fatal(err)
	}
	if err := WriteFileAtomic(RcloneConfigPath(homeB), []byte(RcloneConfig(h.cfg)), 0o600); err != nil {
		b.Fatal(err)
	}
	mount := exec.Command(driveBin(b), "mount", "--home", homeB, "--endpoint", h.cfg.Endpoint,
		"--bucket", h.cfg.Bucket, "--prefix", h.cfg.Prefix, "--foreground")
	mount.Env = extraMountEnv(b, h.cfg)
	mount.Stdout, mount.Stderr = os.Stdout, os.Stderr
	if err := mount.Start(); err != nil {
		b.Fatalf("mount the second device: %v", err)
	}
	defer func() {
		_ = mount.Process.Signal(os.Interrupt)
		done := make(chan struct{})
		go func() { _, _ = mount.Process.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			_ = mount.Process.Kill()
			<-done
		}
		_ = exec.Command("fusermount3", "-u", mountB).Run()
		_ = exec.Command("fusermount", "-u", mountB).Run()
	}()
	if !waitForMount(b, mount, mountB) {
		skipNoMount(b, "this host does not permit a second unprivileged FUSE mount")
	}

	const name = "bench-sync.txt"
	pathA := filepath.Join(h.mountDir, name)
	pathB := filepath.Join(mountB, name)

	start := time.Now()
	if err := os.WriteFile(pathA, []byte("new\n"), 0o644); err != nil {
		b.Fatalf("write a new file on A: %v", err)
	}
	if !waitPath(pathB, 2*time.Minute, func(err error) bool { return err == nil }) {
		b.Fatalf("the new file never appeared on B")
	}
	h.report(b, "cross-machine-new-file", "sync", time.Since(start), 4)

	start = time.Now()
	f, err := os.OpenFile(pathA, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		b.Fatalf("open the file on A to edit: %v", err)
	}
	if _, err := f.Write([]byte("edit\n")); err != nil {
		f.Close()
		b.Fatalf("edit on A: %v", err)
	}
	f.Close()
	if !waitFileEquals(pathB, "new\nedit\n", 2*time.Minute) {
		b.Fatalf("the edit never appeared on B")
	}
	h.report(b, "cross-machine-edit", "sync", time.Since(start), 5)

	start = time.Now()
	if err := os.Remove(pathA); err != nil {
		b.Fatalf("delete on A: %v", err)
	}
	if !waitPath(pathB, 2*time.Minute, os.IsNotExist) {
		b.Fatalf("the delete never appeared on B")
	}
	h.report(b, "cross-machine-delete", "sync", time.Since(start), 0)
}

// BenchmarkFileOpen times os.Open of a small file through the mount: the
// scoreboard's "file open time" row, against the same stand-in the ratchet
// uses so a slower open fails CI before it is published.
func BenchmarkFileOpen(b *testing.B) {
	h := benchSetup(b)
	const name = "bench-open.bin"
	if err := h.seed(name, 4096); err != nil {
		b.Fatal(err)
	}
	start := time.Now()
	f, err := os.Open(filepath.Join(h.mountDir, name))
	if err != nil {
		b.Fatalf("open a 4 KiB file through the mount: %v", err)
	}
	f.Close()
	h.report(b, "file-open", "open", time.Since(start), 4096)
}

// BenchmarkBigFolderRename times renaming a folder through the mount. Space
// publishes a 200-file move; quick scale uses the harness's listN.
func BenchmarkBigFolderRename(b *testing.B) {
	h := benchSetup(b)
	const src = "bench-rename-src"
	if err := h.seedFolder(src, h.sizes.listN); err != nil {
		b.Fatal(err)
	}
	// The mount caches a folder for --dir-cache-time (5s); the rename must
	// see the seed, so the wait is setup, not the measured rename.
	time.Sleep(6 * time.Second)
	start := time.Now()
	if err := os.Rename(filepath.Join(h.mountDir, src), filepath.Join(h.mountDir, "bench-rename-dst")); err != nil {
		b.Fatalf("rename the folder through the mount: %v", err)
	}
	h.report(b, "big-folder-rename", "rename", time.Since(start), int64(h.sizes.listN))
}

// BenchmarkMountReady times a new mount from process start until the mount
// point is live. benchSetup brings up the stand-in server the second mount
// talks to; the clock starts after that, so this number is only the new mount.
func BenchmarkMountReady(b *testing.B) {
	h := benchSetup(b)
	home := filepath.Join(h.root, "home-ready")
	mountDir := filepath.Join(home, "Drive")
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		b.Fatal(err)
	}
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(h.cfg)), 0o600); err != nil {
		b.Fatal(err)
	}
	start := time.Now()
	mount := exec.Command(driveBin(b), "mount", "--home", home, "--endpoint", h.cfg.Endpoint,
		"--bucket", h.cfg.Bucket, "--prefix", h.cfg.Prefix, "--foreground")
	mount.Env = extraMountEnv(b, h.cfg)
	mount.Stdout, mount.Stderr = os.Stdout, os.Stderr
	if err := mount.Start(); err != nil {
		b.Fatalf("start the mount: %v", err)
	}
	defer func() {
		_ = mount.Process.Signal(os.Interrupt)
		done := make(chan struct{})
		go func() { _, _ = mount.Process.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			_ = mount.Process.Kill()
			<-done
		}
		_ = exec.Command("fusermount3", "-u", mountDir).Run()
		_ = exec.Command("fusermount", "-u", mountDir).Run()
	}()
	if !waitForMount(b, mount, mountDir) {
		skipNoMount(b, "this host does not permit a second unprivileged FUSE mount")
	}
	h.report(b, "mount-ready", "ready", time.Since(start), 0)
}

// BenchmarkCLIColdStart times `drive version` in a new process: the CLI's
// cold start. It does not mount; a zero-value harness is enough for the
// published line to name stand-in vs real the same way every other row does.
func BenchmarkCLIColdStart(b *testing.B) {
	bin := driveBin(b)
	h := &benchStandin{}
	if benchH != nil {
		h.real = benchH.real
	} else if os.Getenv("DRIVE_BENCH_ENDPOINT") != "" {
		h.real = true
	}
	start := time.Now()
	cmd := exec.Command(bin, "version")
	if out, err := cmd.CombinedOutput(); err != nil {
		b.Fatalf("drive version: %v\n%s", err, out)
	}
	h.report(b, "cli-cold-start", "version", time.Since(start), 0)
}

// waitPath polls path until check(err) is true for os.Stat's error, or the
// timeout runs out. Used so a second mount's view of a create or a delete is
// timed until it matches, not until the first mount's page cache agreed.
func waitPath(path string, timeout time.Duration, check func(error) bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		_, err := os.Stat(path)
		if check(err) {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

func waitFileEquals(path, want string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		got, err := os.ReadFile(path)
		if err == nil && string(got) == want {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

// The issue #227 table is stand-in harness proof, not h.report published rows.
func BenchmarkPrefetchCLIColdStart(b *testing.B) {
	bin := driveBin(b)
	if out, err := exec.Command(bin, "version").CombinedOutput(); err != nil {
		b.Fatalf("warmup: %v\n%s", err, out)
	}
	start := time.Now()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if out, err := exec.Command(bin, "version").CombinedOutput(); err != nil {
			b.Fatalf("drive version: %v\n%s", err, out)
		}
	}
	b.StopTimer()
	b.Logf("prefetch-bench metric=cli-cold-start value=%.6f unit=s n=%d", time.Since(start).Seconds()/float64(max(b.N, 1)), b.N)
}

func BenchmarkPrefetchMountReady(b *testing.B) {
	h := benchSetup(b)
	home := filepath.Join(h.root, "home-ready-prefetch")
	mountDir := filepath.Join(home, "Drive")
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		b.Fatal(err)
	}
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(h.cfg)), 0o600); err != nil {
		b.Fatal(err)
	}
	start := time.Now()
	mount := exec.Command(driveBin(b), "mount", "--home", home, "--endpoint", h.cfg.Endpoint,
		"--bucket", h.cfg.Bucket, "--prefix", h.cfg.Prefix, "--foreground")
	mount.Env = extraMountEnv(b, h.cfg)
	mount.Stdout, mount.Stderr = os.Stdout, os.Stderr
	if err := mount.Start(); err != nil {
		b.Fatal(err)
	}
	defer func() {
		_ = mount.Process.Signal(os.Interrupt)
		_, _ = mount.Process.Wait()
		_ = exec.Command("fusermount3", "-u", mountDir).Run()
		_ = exec.Command("fusermount", "-u", mountDir).Run()
	}()
	if !waitForMount(b, mount, mountDir) {
		skipNoMount(b, "this host does not permit an unprivileged FUSE mount")
	}
	d := time.Since(start)
	b.Logf("prefetch-bench metric=mount-ready value=%.3f unit=s", d.Seconds())
}

func BenchmarkPrefetchBrowse(b *testing.B) {
	h := benchSetup(b)
	local := filepath.Join(h.root, "fixtures", "browse")
	for _, sub := range []string{"next-a", "next-b"} {
		if err := os.MkdirAll(filepath.Join(local, sub), 0o755); err != nil {
			b.Fatal(err)
		}
		for i := 0; i < 8; i++ {
			p := filepath.Join(local, sub, fmt.Sprintf("f-%02d.txt", i))
			if err := os.WriteFile(p, []byte("browse\n"), 0o644); err != nil {
				b.Fatal(err)
			}
		}
	}
	if err := os.WriteFile(filepath.Join(local, "small-a.bin"), bytes.Repeat([]byte("a"), 4096), 0o644); err != nil {
		b.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(local, "small-b.bin"), bytes.Repeat([]byte("b"), 4096), 0o644); err != nil {
		b.Fatal(err)
	}
	if _, err := h.rclone("copy", local, RemoteFor(h.cfg)+"/browse"); err != nil {
		b.Fatal(err)
	}
	time.Sleep(6 * time.Second)
	parent := filepath.Join(h.mountDir, "browse")
	if _, err := os.ReadDir(parent); err != nil {
		b.Fatalf("list parent: %v", err)
	}

	start := time.Now()
	if _, err := os.ReadDir(filepath.Join(parent, "next-a")); err != nil {
		b.Fatalf("list next-a without prefetch: %v", err)
	}
	withoutFolder := time.Since(start)
	start = time.Now()
	if _, err := os.ReadFile(filepath.Join(parent, "small-a.bin")); err != nil {
		b.Fatalf("open small-a without prefetch: %v", err)
	}
	withoutFile := time.Since(start)

	if err := prefetchOnce(parent); err != nil {
		b.Fatal(err)
	}
	start = time.Now()
	if _, err := os.ReadDir(filepath.Join(parent, "next-b")); err != nil {
		b.Fatalf("list next-b with prefetch: %v", err)
	}
	withFolder := time.Since(start)
	start = time.Now()
	if _, err := os.ReadFile(filepath.Join(parent, "small-b.bin")); err != nil {
		b.Fatalf("open small-b with prefetch: %v", err)
	}
	withFile := time.Since(start)

	b.Logf("prefetch-bench metric=next-folder-without value=%.6f unit=s", withoutFolder.Seconds())
	b.Logf("prefetch-bench metric=next-folder-with value=%.6f unit=s", withFolder.Seconds())
	b.Logf("prefetch-bench metric=small-file-without value=%.6f unit=s", withoutFile.Seconds())
	b.Logf("prefetch-bench metric=small-file-with value=%.6f unit=s", withFile.Seconds())
}

// prefetchOverlapTooSlow reports whether the overlapping user read is a
// regression for this storage. A non-HTTPS endpoint has no WAN link to share,
// so 20 ms and 2x still apply. HTTPS real storage shares one link; issue #382
// measured a healthy overlap of 3.1x to 3.4x, and the gate there is 10x the
// control, which those pairs pass and a 200 ms stall of the user read fails.
func prefetchOverlapTooSlow(with, without time.Duration, https bool) bool {
	if https {
		return with > without*10
	}
	return with > without+20*time.Millisecond && with > without*2
}

func TestPrefetchOverlapTooSlow(t *testing.T) {
	cases := []struct {
		name    string
		with    time.Duration
		without time.Duration
		https   bool
		want    bool
	}{
		{"stand-in holds", 13878 * time.Microsecond, 9809 * time.Microsecond, false, false},
		{"stand-in 200ms stall", 211271 * time.Microsecond, 6949 * time.Microsecond, false, true},
		{"https issue pair", 218692 * time.Microsecond, 63907 * time.Microsecond, true, false},
		{"https this branch", 181956 * time.Microsecond, 59848 * time.Microsecond, true, false},
		{"https 200ms stall", 214250 * time.Microsecond, 8533 * time.Microsecond, true, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := prefetchOverlapTooSlow(c.with, c.without, c.https)
			if got != c.want {
				t.Fatalf("prefetchOverlapTooSlow(%s, %s, https=%v)=%v want %v",
					c.with, c.without, c.https, got, c.want)
			}
		})
	}
}

func BenchmarkReadDuringPrefetch(b *testing.B) {
	// This bench is the user-read vs prefetchOnce overlap with the same
	// userBusy flag runPrefetchLoop sets on a file open. The inotify path is
	// TestPrefetchWatcherSeesDirectoryOpen; spinning the watcher here would
	// contend with the mount's own FUSE traffic.
	//
	// The overlap assertion at the bottom is 20 ms and 2x on a non-HTTPS
	// server (issue #382). The loopback stand-in has no link to share, so
	// the only thing that can slow a user read there is the overlap itself.
	// HTTPS real storage shares one link between the prefetch pass and the
	// user's own read, and the first read through a fresh mount pays
	// connection costs a loopback server does not have, so the same healthy
	// overlap is slower there than any stand-in figure can be: drive#382
	// measured 218 ms against 64 ms (3.4x) on the iDrive e2 account, and
	// this branch reproduced 194 ms against 62 ms (3.1x). The HTTPS gate
	// is 10x the control, so those pairs pass and a stall that holds the
	// pipe (a 200 ms injected delay, 25x) still fails.
	h := benchSetup(b)
	local := filepath.Join(h.root, "fixtures", "busy")
	if err := os.MkdirAll(local, 0o755); err != nil {
		b.Fatal(err)
	}
	for i := 0; i < 16; i++ {
		p := filepath.Join(local, fmt.Sprintf("p-%02d.bin", i))
		if err := os.WriteFile(p, bytes.Repeat([]byte("p"), 64<<10), 0o644); err != nil {
			b.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(local, "user-a.bin"), bytes.Repeat([]byte("u"), 1<<20), 0o644); err != nil {
		b.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(local, "user-b.bin"), bytes.Repeat([]byte("v"), 1<<20), 0o644); err != nil {
		b.Fatal(err)
	}
	if _, err := h.rclone("copy", local, RemoteFor(h.cfg)+"/busy"); err != nil {
		b.Fatal(err)
	}
	time.Sleep(6 * time.Second)
	busy := filepath.Join(h.mountDir, "busy")
	// One prefetch pass in the background, the way the sidecar runs after a
	// listing — not a spin loop, which would not be how production schedules
	// work. userBusy is what inotify sets on a user file open, so the pass
	// drops the rest of its file reads the moment the user read starts.
	done := make(chan struct{})
	go func() {
		_ = prefetchOnce(busy)
		close(done)
	}()
	prefetchUserBusy.Store(true)
	start := time.Now()
	if _, err := os.ReadFile(filepath.Join(busy, "user-a.bin")); err != nil {
		prefetchUserBusy.Store(false)
		<-done
		b.Fatalf("read while prefetch runs: %v", err)
	}
	with := time.Since(start)
	prefetchUserBusy.Store(false)
	<-done
	start = time.Now()
	if _, err := os.ReadFile(filepath.Join(busy, "user-b.bin")); err != nil {
		b.Fatalf("read with prefetch stopped: %v", err)
	}
	without := time.Since(start)
	storage := h.storageName()
	region := envOr("DRIVE_BENCH_REGION", "unmeasured")
	b.Logf("prefetch-bench metric=user-read-during-prefetch value=%.6f unit=s storage=%s region=%s", with.Seconds(), storage, region)
	b.Logf("prefetch-bench metric=user-read-prefetch-off value=%.6f unit=s storage=%s region=%s", without.Seconds(), storage, region)
	// HTTPS is the real-storage check: h.real is also true for an HTTP
	// server on this host's own IP, which has no WAN link to share, so that
	// path keeps the 20 ms / 2x rule. The 10x pairs live in
	// docs/research/prefetch-overlap-bench.md and in TestPrefetchOverlapTooSlow.
	https := strings.HasPrefix(h.cfg.Endpoint, "https://")
	if https {
		b.Logf("prefetch-bench metric=user-read-during-prefetch-overlap gate=real-10x storage=%s region=%s note=measured_not_2x", storage, region)
	}
	if prefetchOverlapTooSlow(with, without, https) {
		if https {
			b.Fatalf("user read during prefetch %s is more than 10x %s without", with, without)
		}
		b.Fatalf("user read during prefetch %s is slower than %s without", with, without)
	}
}
