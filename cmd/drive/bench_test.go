package main

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

type benchSizes struct {
	video   int64
	big     int64
	save    int64
	listN   int
	read100 int64
}

func benchScale() benchSizes {
	if os.Getenv("DRIVE_BENCH_SCALE") == "quick" {
		return benchSizes{video: 64 << 20, big: 32 << 20, save: 16 << 20, listN: 50, read100: 8 << 20}
	}
	return benchSizes{video: 5 << 30, big: 2 << 30, save: 1 << 30, listN: 10000, read100: 100 << 20}
}

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

type benchStandin struct {
	root     string
	home     string
	dataDir  string
	mountDir string
	cfg      StorageConfig
	serve    *exec.Cmd
	mount    *exec.Cmd
	real     bool
	sizes    benchSizes
	env      []string
}

var (
	benchOnce sync.Once
	benchH    *benchStandin
)

func benchTeardown() {
	if benchH != nil {
		benchH.close()
	}
}

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
	if err := WriteFileAtomic(RcloneConfigPath(h.home), []byte(RcloneConfig(h.cfg)), 0o600); err != nil {
		h.close()
		tb.Fatal(err)
	}
	h.env = append(os.Environ(), "RCLONE_CONFIG="+RcloneConfigPath(h.home), rcloneSecretEnv+"="+h.cfg.SecretKey)

	h.mount = exec.Command(driveBin(tb), "mount",
		"--home", h.home, "--endpoint", h.cfg.Endpoint, "--bucket", h.cfg.Bucket,
		"--prefix", h.cfg.Prefix, "--foreground")
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

func (h *benchStandin) rclone(args ...string) (string, error) {
	cmd := exec.Command("rclone", args...)
	cmd.Env = h.env
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("rclone %s: %w\n%s", strings.Join(args, " "), err, out)
	}
	return string(out), nil
}

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

func (h *benchStandin) storageName() string {
	if h.real {
		return "real"
	}
	return "stand-in"
}

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

func BenchmarkSaveReachesStorage(b *testing.B) {
	h := benchSetup(b)
	const name = "bench-save.bin"
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

func BenchmarkListFolder(b *testing.B) {
	h := benchSetup(b)
	const folder = "bench-list"
	if err := h.seedFolder(folder, h.sizes.listN); err != nil {
		b.Fatal(err)
	}
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

func BenchmarkBigFolderRename(b *testing.B) {
	h := benchSetup(b)
	const src = "bench-rename-src"
	if err := h.seedFolder(src, h.sizes.listN); err != nil {
		b.Fatal(err)
	}
	time.Sleep(6 * time.Second)
	start := time.Now()
	if err := os.Rename(filepath.Join(h.mountDir, src), filepath.Join(h.mountDir, "bench-rename-dst")); err != nil {
		b.Fatalf("rename the folder through the mount: %v", err)
	}
	h.report(b, "big-folder-rename", "rename", time.Since(start), int64(h.sizes.listN))
}

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
