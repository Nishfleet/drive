package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The background fill rules (drive issue #194). The three questions the issue
// asks are each one test here, and each drives the real code rather than a
// copy of it:
//
//   1. which stock rclone flags carry the fill, and are they on the mount the
//      CLI actually builds (TestBackgroundFillFlagsOnTheMount);
//   2. when the fill runs — a kept-offline folder always, everything else only
//      on an idle machine (TestShouldFillRules);
//   3. that the fill never pushes the cache past the user's cap and never
//      slows a foreground open (TestBackgroundFillFillsThroughTheCappedCache,
//      TestBackgroundFillDoesNotSlowAForegroundOpen and TestOpenTimeColdAndWarm
//      in e2e_test.go, which prove them on a real mount).

// The mount must carry every flag the background fill is made of, as adjacent
// flag/value pairs, on both platforms. A flag that is present but has its
// value in the next argument would be read by rclone as a different option, so
// this checks the pairs, not the substrings.
func TestBackgroundFillFlagsOnTheMount(t *testing.T) {
	for _, tc := range []struct{ goos, sub string }{{"darwin", "nfsmount"}, {"linux", "mount"}} {
		p := BuildMountPlan(tc.goos, "/home/test", "/usr/bin/rclone", testStorage())
		args := p.Args()
		for _, want := range []struct{ flag, value string }{
			{"--vfs-read-ahead", DefaultFillPolicy().ReadAhead},
			{"--vfs-read-chunk-size-limit", DefaultFillPolicy().ChunkSizeLimit},
			{"--vfs-cache-max-age", DefaultFillPolicy().MaxAge},
		} {
			if !hasArgPair(args, want.flag, want.value) {
				t.Errorf("%s: mount is missing %s %s as adjacent args:\n%v",
					tc.goos, want.flag, want.value, args)
			}
		}
		// The cap the fill must never cross is on the same mount. It was
		// there for #112; the fill is what makes it load-bearing.
		if !hasArgPair(args, "--vfs-cache-max-size", vfsCacheMaxValue) {
			t.Errorf("%s: mount lost --vfs-cache-max-size %s:\n%v", tc.goos, vfsCacheMaxValue, args)
		}
		// The remote control is how the fill reads the cache and refreshes
		// the directory, and it must be bound to loopback: rclone's rc is
		// unauthenticated here (--rc-no-auth), so a wildcard bind would be an
		// open control port on the network.
		if !hasArgPair(args, "--rc-addr", "127.0.0.1:5572") {
			t.Errorf("%s: mount is not binding the remote control to loopback:\n%v", tc.goos, args)
		}
		if !hasArg(args, "--rc") {
			t.Errorf("%s: mount does not enable the remote control:\n%v", tc.goos, args)
		}
	}
}

// The fill's own read-ahead and chunk backoff must be values rclone accepts:
// rclone parses every one of them, and a size this product invented would be
// refused by the mount at the first launch rather than by a test.
func TestBackgroundFillSizesAreRcloneSizes(t *testing.T) {
	p := DefaultFillPolicy()
	readAhead, err := parseSizeSuffix(p.ReadAhead)
	if err != nil {
		t.Fatalf("read-ahead %q: %v", p.ReadAhead, err)
	}
	if readAhead <= 0 {
		t.Errorf("read-ahead %s is not a size rclone can fetch a chunk with", p.ReadAhead)
	}
	// The chunk limit is a ceiling on rclone's doubling and only works when it
	// is above the chunk size the doubling starts from: rclone reads its
	// default 128M first (--vfs-read-chunk-size) or the mount's first chunk
	// (--vfs-read-ahead), whichever it is using.
	limit, err := parseSizeSuffix(p.ChunkSizeLimit)
	if err != nil {
		t.Fatalf("chunk-size-limit %q: %v", p.ChunkSizeLimit, err)
	}
	firstChunk, err := parseSizeSuffix(vfsReadChunkSizeValue)
	if err != nil {
		t.Fatalf("read-chunk-size %q: %v", vfsReadChunkSizeValue, err)
	}
	if limit <= 128<<20 || limit <= firstChunk {
		t.Errorf("chunk-size-limit %s is not above the %s a chunk read starts from, so the doubling never gets past the first chunk",
			p.ChunkSizeLimit, vfsReadChunkSizeValue)
	}
	// MaxAge is a duration rclone parses, and it is what "recently opened
	// files stay on the disk" means, so it has to be longer than the 1h
	// rclone ships with: a file opened yesterday evening is one a person
	// opens again this morning.
	maxAge, err := time.ParseDuration(p.MaxAge)
	if err != nil {
		t.Errorf("cache-max-age %q is not a duration: %v", p.MaxAge, err)
	} else if maxAge <= time.Hour {
		t.Errorf("cache-max-age %s is not longer than rclone's own 1h, so it keeps nothing this product did not already", p.MaxAge)
	}
	if p.IdleCheck <= 0 {
		t.Errorf("idle check interval = %s, want a positive period", p.IdleCheck)
	}
}

// The fill's own rule, in the issue's words: a folder kept offline is filled
// in full whatever the machine is doing, and everything else is filled only
// when the machine is idle. Both halves are one function, so both are here.
func TestShouldFillRules(t *testing.T) {
	for _, tc := range []struct {
		name         string
		offline      bool
		load1, load5 float64
		want         bool
	}{
		{"offline folder on a busy machine still fills", true, 3.5, 3.0, true},
		{"offline folder on an idle machine fills", true, 0.1, 0.1, true},
		{"idle machine fills the rest", false, 0.05, 0.05, true},
		{"a busy machine does not fill", false, 2.4, 2.1, false},
		{"a machine busy only in the one-minute average does not fill", false, 0.9, 0.1, false},
		{"a machine busy only in the five-minute average does not fill", false, 0.1, 1.4, false},
		{"right at the threshold does not fill", false, idleLoad, idleLoad, false},
		{"just under the threshold fills", false, idleLoad - 0.01, idleLoad - 0.01, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ShouldFill(tc.offline, tc.load1, tc.load5); got != tc.want {
				t.Errorf("ShouldFill(offline=%v, load1=%v, load5=%v) = %v, want %v",
					tc.offline, tc.load1, tc.load5, got, tc.want)
			}
		})
	}
}

// The load averages the fill gates on are the ones `uptime` prints, and an
// unreadable one is a named failure rather than an "idle" the fill would then
// act on.
func TestReadLoadAverages(t *testing.T) {
	one, five, err := readLoadAverages()
	if err != nil {
		t.Fatalf("read /proc/loadavg on this host: %v", err)
	}
	if one < 0 || five < 0 {
		t.Errorf("load averages = %v, %v; want two non-negative numbers", one, five)
	}
	// The gate must accept this host's own load when it is idle enough, so
	// the rule is applied to the same numbers the loop would read.
	if ShouldFill(false, one, five) != (one < idleLoad && five < idleLoad) {
		t.Errorf("ShouldFill disagrees with the thresholds at this host's load %v/%v", one, five)
	}
	if _, _, err := readLoadAveragesFrom("/nonexistent/loadavg"); err == nil {
		t.Error("an unreadable load average returned no error; the fill would read it as idle")
	}
}

// `sysctl -n vm.loadavg` is how a Mac reports load (it has no /proc).
func TestParseDarwinLoadAverages(t *testing.T) {
	one, five, err := parseDarwinLoadAverages("{ 2.06 1.88 1.75 }\n")
	if err != nil || one != 2.06 || five != 1.88 {
		t.Fatalf("parse = %v, %v, %v; want 2.06, 1.88, nil", one, five, err)
	}
	if _, _, err := parseDarwinLoadAverages("{ }"); err == nil {
		t.Error("an empty vm.loadavg returned no error")
	}
	if _, _, err := parseDarwinLoadAverages("{ x y z }"); err == nil {
		t.Error("a non-numeric vm.loadavg returned no error")
	}
}

// A folder kept offline is filled by reading it through the mount, so the read
// a pass does must land every byte in rclone's cache and must not follow a
// symlink out of the drive.
func TestFillReaderReadsThroughTheMount(t *testing.T) {
	dir := t.TempDir()
	want := strings.Repeat("drive", 1000)
	if err := os.WriteFile(filepath.Join(dir, "doc.txt"), []byte(want), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sub", "movie.mp4"), []byte("bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A file the person wrote and rclone has not uploaded yet: the fill must
	// not report an error for a tree it can read, and must not read a file
	// that has been removed under it.
	read := fillReader(dir)
	if err := read("drive:bucket/u/1", true); err != nil {
		t.Fatalf("fill read: %v", err)
	}
	// A file that vanished between the walk and the read is not an error: the
	// next pass sees the new tree.
	if _, err := fillReadFile(filepath.Join(dir, "gone.bin")); err != nil {
		t.Errorf("a removed file failed the fill: %v", err)
	}
	if _, err := fillReadFile(dir); err == nil {
		t.Error("reading a directory as a file returned no error")
	}
}

// FormatBytes is the one format the CLI, the fill report and the docs read a
// cache size in, so a number can never appear in two shapes.
func TestFormatBytes(t *testing.T) {
	for _, tc := range []struct {
		n    int64
		want string
	}{
		{0, "0 B"},
		{512, "512 B"},
		{1024, "1.0 KiB"},
		{1 << 20, "1.0 MiB"},
		{500 << 20, "500.0 MiB"},
		{20 << 30, "20.0 GiB"},
	} {
		if got := FormatBytes(tc.n); got != tc.want {
			t.Errorf("FormatBytes(%d) = %q, want %q", tc.n, got, tc.want)
		}
	}
}

// parseSizeSuffix reads the forms this product sets and reports in, and
// refuses one it cannot read rather than defaulting to zero: a cap read as 0
// would be no cap at all.
func TestParseSizeSuffix(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int64
	}{
		{"0", 0},
		{"1M", 1 << 20},
		{"512M", 512 << 20},
		{"2G", 2 << 30},
		{"20G", 20 << 30},
		{"1.5G", 1610612736},
		{"1k", 1024},
	} {
		got, err := parseSizeSuffix(tc.in)
		if err != nil {
			t.Errorf("parseSizeSuffix(%q): %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("parseSizeSuffix(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
	for _, bad := range []string{"", "G", "twelve"} {
		if _, err := parseSizeSuffix(bad); err == nil {
			t.Errorf("parseSizeSuffix(%q) returned no error", bad)
		}
	}
}

// countedBackend is a fillBackend whose cache the test controls, so the cap
// rule is proved without needing the cap to be reached over a real mount
// first. The real path is covered end to end in e2e_test.go
// (TestBackgroundFillFillsThroughTheCappedCache), and this one is what makes the
// "the fill stops at the cap" branch a failing test rather than a comment.
type countedBackend struct {
	used      int64
	cap       int64
	refreshes int
	// addPerRead is how many bytes the fake read puts in the cache.
	addPerRead int64
}

func (b *countedBackend) stats(context.Context) (vfsStats, error) {
	var s vfsStats
	s.DiskCache.BytesUsed = b.used
	s.Opt.CacheMaxSize = b.cap
	return s, nil
}

func (b *countedBackend) refresh(context.Context, bool) error {
	b.refreshes++
	return nil
}

func (b *countedBackend) remote() string { return "drive:bucket/u/1" }

// The fill must never push the cache past the user's cap. Three cases, each
// one a named rule: an idle machine stops when the cache is at the cap, a
// busy machine does not fill at all, and a pass that would leave the cache
// over the cap is an error rather than a silent success.
func TestBackgroundFillNeverExceedsTheCap(t *testing.T) {
	t.Run("stops at the cap and leaves it to rclone to reclaim", func(t *testing.T) {
		capBytes, err := parseSizeSuffix("20G")
		if err != nil {
			t.Fatal(err)
		}
		b := &countedBackend{used: capBytes, cap: capBytes, addPerRead: 500 << 20}
		res, err := fillPass(context.Background(), b, false, 0.1, 0.1, func(string, bool) error {
			t.Error("the fill read a file although the cache was already at the cap")
			return nil
		})
		if err != nil {
			t.Fatalf("fillPass at the cap: %v", err)
		}
		if res.Ran() {
			t.Errorf("the fill ran with the cache at the %s cap", FormatBytes(capBytes))
		}
		if b.refreshes != 0 {
			t.Errorf("the fill refreshed the directory %d times with the cache at the cap", b.refreshes)
		}
	})

	t.Run("a busy machine does not fill", func(t *testing.T) {
		b := &countedBackend{used: 0, cap: 20 << 30, addPerRead: 1 << 30}
		res, err := fillPass(context.Background(), b, false, 2.5, 2.0, func(string, bool) error {
			t.Error("the fill read a file on a busy machine")
			return nil
		})
		if err != nil {
			t.Fatalf("fillPass on a busy machine: %v", err)
		}
		if res.Ran() || res.Idle {
			t.Errorf("the fill ran on a busy machine: %+v", res)
		}
		if b.used != 0 {
			t.Errorf("the fill put %s in the cache on a busy machine", FormatBytes(b.used))
		}
	})

	t.Run("a pass that would leave the cache over the cap is a named failure", func(t *testing.T) {
		capBytes, _ := parseSizeSuffix("20G")
		// Just under the cap, with a read that would cross it: the loop
		// cannot stop rclone mid-read, so it must say so rather than report
		// success with the cache over the user's cap.
		b := &countedBackend{used: capBytes - (1 << 20), cap: capBytes, addPerRead: 4 << 30}
		_, err := fillPass(context.Background(), b, false, 0.1, 0.1, func(string, bool) error {
			b.used += b.addPerRead
			return nil
		})
		if err == nil {
			t.Fatal("a fill that left the cache over the cap returned no error")
		}
		if !strings.Contains(err.Error(), "cap") {
			t.Errorf("the error does not name the cap: %v", err)
		}
	})

	t.Run("a fill under the cap succeeds and reports rclone's own numbers", func(t *testing.T) {
		capBytes, _ := parseSizeSuffix("20G")
		b := &countedBackend{used: 1 << 30, cap: capBytes, addPerRead: 500 << 20}
		res, err := fillPass(context.Background(), b, false, 0.1, 0.1, func(string, bool) error {
			b.used += b.addPerRead
			return nil
		})
		if err != nil {
			t.Fatalf("fillPass under the cap: %v", err)
		}
		if !res.Ran() || !res.Idle {
			t.Errorf("an idle fill under the cap did not run: %+v", res)
		}
		if res.BytesBefore != 1<<30 || res.BytesAfter != (1<<30)+(500<<20) {
			t.Errorf("the fill reported %d -> %d, want %d -> %d",
				res.BytesBefore, res.BytesAfter, int64(1<<30), int64(1<<30)+(500<<20))
		}
		if res.CapBytes != capBytes {
			t.Errorf("the cap was read as %d, want the mount's own %d", res.CapBytes, capBytes)
		}
		if b.refreshes != 1 {
			t.Errorf("the fill refreshed the directory %d times, want 1", b.refreshes)
		}
	})

	t.Run("a kept-offline set is still read when the cache is at the cap", func(t *testing.T) {
		capBytes, _ := parseSizeSuffix("20G")
		b := &countedBackend{used: capBytes, cap: capBytes}
		var idleArg *bool
		res, err := fillPass(context.Background(), b, true, 3.5, 3.0, func(_ string, idle bool) error {
			idleArg = &idle
			return nil
		})
		if err != nil {
			t.Fatalf("fillPass at the cap with a kept-offline set: %v", err)
		}
		if idleArg == nil {
			t.Fatal("the keep-warm read did not run with the cache at the cap")
		}
		if *idleArg {
			t.Error("the keep-warm pass filled the rest of the drive at the cap")
		}
		if !res.Ran() {
			t.Error("the keep-warm pass did not refresh the directory cache")
		}
	})
}

// A folder kept offline is walked, not opened as a file: rclone's cache is
// filled file by file, and opening the folder itself is an error
// (TestFillReaderReadsThroughTheMount).
func TestFillTargetsWalksAKeptFolder(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "keep", "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep", "a.txt"), []byte("alpha"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep", "nested", "b.txt"), []byte("beta"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "other.txt"), []byte("gamma"), 0o644); err != nil {
		t.Fatal(err)
	}
	targets := fillTargets{root: dir, offline: []string{"keep"}}
	if err := targets.read("", false); err != nil {
		t.Fatalf("walking a kept-offline folder: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep", "new.txt"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := targets.read("", false); err != nil {
		t.Fatalf("a new file inside a kept-offline folder failed the keep-warm: %v", err)
	}
}

func TestFillReadTreeHonoursCancel(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := fillReadTree(ctx, dir); err == nil {
		t.Fatal("a cancelled fill walk returned no error")
	}
}

func TestFillTargetsSkipsUnpinnedAndWholeFiles(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "keep.bin"), []byte("pin"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "other.bin"), []byte("skip"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeCached(t, home, "bucket/u/me/keep.bin", 3, false)
	metaPath := filepath.Join(DefaultCacheDir(home), "vfsMeta", "drive", "bucket", "u", "me", "keep.bin")
	if err := os.WriteFile(metaPath, []byte(`{"Dirty":false,"Size":3,"Fingerprint":"1,done"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	targets := fillTargets{root: dir, offline: []string{"keep.bin"}, cacheDir: DefaultCacheDir(home)}
	if !targets.pinnedFileIsWhole("keep.bin") {
		t.Fatal("a fingerprinted cache copy must count as whole")
	}
	if err := targets.read("", true); err != nil {
		t.Fatal(err)
	}
}

// hasArg reports whether args contains flag at all.
func hasArg(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}
