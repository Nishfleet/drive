package main

import (
	"context"
	"fmt"
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
		// password-protected (drive#498), so a wildcard bind would still be an
		// open control port on the network. A prepared mount picks a free
		// port (drive#807); this check is the unprepared plan.
		rcAddr := argValue(args, "--rc-addr")
		if rcAddr == "" || !IsLoopbackAddr(rcAddr) {
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

// A file somebody opened is filled by reading it through the mount, under the
// per-pass byte budget, and the fill reads nothing when this pass is not
// filling the recently-opened set (drive#568).
func TestFillTargetsReadsOpenedFilesUnderTheBudget(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.bin"), []byte("alpha"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b.bin"), []byte("beta"), 0o644); err != nil {
		t.Fatal(err)
	}
	var read []string
	targets := fillTargets{
		root:   dir,
		recent: []string{"a.bin", "b.bin"},
		readFile: func(p string) (int64, error) {
			read = append(read, filepath.Base(p))
			return 60, nil
		},
	}
	// The budget stops after the first file: one pass reads at most budget
	// bytes, so a drive larger than the cache is filled over several passes.
	if _, err := targets.read(true, 60); err != nil {
		t.Fatalf("read under the budget: %v", err)
	}
	if len(read) != 1 || read[0] != "a.bin" {
		t.Errorf("the budgeted read read %v, want only a.bin", read)
	}
	// A pass that is not filling the recently-opened set reads none of them.
	read = nil
	if _, err := targets.read(false, 1<<20); err != nil {
		t.Fatalf("read with the recent set off: %v", err)
	}
	if len(read) != 0 {
		t.Errorf("the pass read %v although it was not filling recently-opened files", read)
	}
	// A file that vanished between the open and the read is not a failure: the
	// next pass sees the new tree. Reading a directory as a file is an error.
	targets.recent = []string{"gone.bin"}
	targets.readFile = nil
	if _, err := targets.read(true, 1<<20); err != nil {
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
	// recursiveRefreshes counts the refreshes that asked for a whole-tree
	// listing, which the fill must never do on a timer (drive#568).
	recursiveRefreshes int
	// addPerRead is how many bytes the fake read puts in the cache.
	addPerRead int64
}

func (b *countedBackend) stats(context.Context) (vfsStats, error) {
	var s vfsStats
	s.DiskCache.BytesUsed = b.used
	s.Opt.CacheMaxSize = b.cap
	return s, nil
}

func (b *countedBackend) refresh(_ context.Context, recursive bool) error {
	b.refreshes++
	if recursive {
		b.recursiveRefreshes++
	}
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
		res, err := fillPass(context.Background(), b, fillTargets{}, 0.1, 0.1)
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
		res, err := fillPass(context.Background(), b, fillTargets{recent: []string{"x.bin"}}, 2.5, 2.0)
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
		// Just under the cap, with a read larger than the headroom: the loop
		// cannot stop rclone mid-read, so it must say so rather than report
		// success with the cache over the user's cap.
		b := &countedBackend{used: capBytes - (1 << 20), cap: capBytes, addPerRead: 4 << 30}
		targets := fillTargets{
			recent: []string{"big.bin"},
			readFile: func(string) (int64, error) {
				b.used += b.addPerRead
				return b.addPerRead, nil
			},
		}
		_, err := fillPass(context.Background(), b, targets, 0.1, 0.1)
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
		targets := fillTargets{
			recent: []string{"x.bin"},
			readFile: func(string) (int64, error) {
				b.used += b.addPerRead
				return b.addPerRead, nil
			},
		}
		res, err := fillPass(context.Background(), b, targets, 0.1, 0.1)
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
		if b.recursiveRefreshes != 0 {
			t.Errorf("the fill refreshed the directory recursively %d times, want none", b.recursiveRefreshes)
		}
	})

	t.Run("a kept-offline set is still read when the cache is at the cap", func(t *testing.T) {
		capBytes, _ := parseSizeSuffix("20G")
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "keep.bin"), []byte("keep"), 0o644); err != nil {
			t.Fatal(err)
		}
		b := &countedBackend{used: capBytes, cap: capBytes}
		res, err := fillPass(context.Background(), b, fillTargets{root: dir, offline: []string{"keep.bin"}}, 3.5, 3.0)
		if err != nil {
			t.Fatalf("fillPass at the cap with a kept-offline set: %v", err)
		}
		if !res.Ran() {
			t.Error("the keep-warm pass did not run at the cap")
		}
		if b.refreshes != 1 {
			t.Errorf("the keep-warm pass refreshed the directory %d times, want 1", b.refreshes)
		}
		if b.recursiveRefreshes != 0 {
			t.Errorf("the keep-warm pass refreshed the directory recursively %d times, want none", b.recursiveRefreshes)
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
	if _, err := targets.read(false, 0); err != nil {
		t.Fatalf("walking a kept-offline folder: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep", "new.txt"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := targets.read(false, 0); err != nil {
		t.Fatalf("a new file inside a kept-offline folder failed the keep-warm: %v", err)
	}
}

// The open registry is what makes the fill read only recently-opened files,
// and its filled set is the guard that stops the fill's own read from looking
// like a fresh open (drive#568).
func TestRecentOpensTracksAndDropsOpens(t *testing.T) {
	r := &recentOpens{opened: map[string]time.Time{}, filled: map[string]time.Time{}, sizes: map[string]int64{}}
	now := time.Now()
	r.record("/m/a.bin")
	r.record("/m/sub/b.bin")
	r.record("/elsewhere/c.bin") // not under this mount
	if got := strings.Join(r.since("/m", now.Add(time.Second), 24*time.Hour), ","); got != "a.bin,sub/b.bin" {
		t.Errorf("since = %q, want %q", got, "a.bin,sub/b.bin")
	}
	// A file the fill just read is not a target again in the window: this is
	// the guard against the fill re-arming its own read.
	r.markFilled("/m/a.bin", 10)
	if got := r.windowBytes(); got != 10 {
		t.Errorf("windowBytes = %d after filling one file, want 10", got)
	}
	if got := strings.Join(r.since("/m", now.Add(time.Second), 24*time.Hour), ","); got != "sub/b.bin" {
		t.Errorf("after markFilled, since = %q, want %q", got, "sub/b.bin")
	}
	// An open older than the window is dropped.
	if got := r.since("/m", now.Add(48*time.Hour), 24*time.Hour); len(got) != 0 {
		t.Errorf("a stale open was still a target: %v", got)
	}
	if got := r.windowBytes(); got != 0 {
		t.Errorf("windowBytes = %d after the window aged out, want 0", got)
	}
}

// A drive twice the cache size, idle for ten passes, must download the cache
// size at most once. The fill reads the recently-opened set up to the cache
// size in the window, marks each file filled, and every later pass sees either
// no headroom, an already-filled set, or an exhausted window budget, so it
// reads nothing, instead of the old whole-tree fill that re-read the drive from
// the top each minute (drive#568). The fake cache evicts between passes the way
// rclone's own poll does, so the test cannot pass merely because the cache is
// still full.
func TestFillDoesNotReDownloadADriveLargerThanTheCache(t *testing.T) {
	capBytes, err := parseSizeSuffix("1G")
	if err != nil {
		t.Fatal(err)
	}
	const fileSize = int64(64 << 20)
	// 32 x 64 MiB is 2 GiB, twice the 1 GiB cap.
	root := "/drive"
	opens := &recentOpens{opened: map[string]time.Time{}, filled: map[string]time.Time{}, sizes: map[string]int64{}}
	for i := 0; i < 32; i++ {
		n := fmt.Sprintf("f%02d.bin", i)
		opens.record(filepath.Join(root, n))
	}
	b := &countedBackend{used: 0, cap: capBytes}
	cache := &fakeCache{cap: capBytes, fileSize: fileSize}
	reads := 0
	targets := fillTargets{
		root:  root,
		opens: opens,
		readFile: func(p string) (int64, error) {
			reads++
			n, err := cache.read(p)
			b.used = cache.used
			return n, err
		},
	}
	for pass := 0; pass < 10; pass++ {
		// rclone's own cache poll evicts over the cap between passes, which is
		// what made the old whole-tree fill download the drive again.
		cache.evictTo(capBytes / 2)
		b.used = cache.used
		targets.recent = opens.since(root, time.Now(), fillRecentAge)
		if _, err := fillPass(context.Background(), b, targets, 0.1, 0.1); err != nil {
			t.Fatalf("idle pass %d: %v", pass+1, err)
		}
	}
	// A fill that ignored the window budget, the per-pass budget or the filled
	// set would read the drive again on each pass and download far more than
	// the cache once.
	if cache.downloads != capBytes {
		t.Errorf("ten idle passes downloaded %s of a %s drive, want exactly the %s cache once",
			FormatBytes(cache.downloads), FormatBytes(2*capBytes), FormatBytes(capBytes))
	}
	if reads != 16 {
		t.Errorf("ten idle passes read %d files, want exactly the %d files in one cache", reads, capBytes/fileSize)
	}
	if b.recursiveRefreshes != 0 {
		t.Errorf("the fill refreshed the directory recursively %d times, want none", b.recursiveRefreshes)
	}
}

// fakeCache models rclone's own VFS cache for the budget test: it holds at
// most cap bytes, evicts the least-recently-used file when a read needs room,
// and counts a download only for a file that is not already cached. The
// eviction matters: without it a re-read of a cached file downloads nothing,
// and the old whole-tree fill only downloaded continuously because rclone
// evicted between passes (drive#568).
type fakeCache struct {
	cap       int64
	fileSize  int64
	used      int64
	order     []string
	cached    map[string]bool
	downloads int64
}

func (c *fakeCache) read(p string) (int64, error) {
	if c.cached == nil {
		c.cached = map[string]bool{}
	}
	if !c.cached[p] {
		c.downloads += c.fileSize
	}
	for c.used+c.fileSize > c.cap && len(c.order) > 0 {
		c.evictOldest()
	}
	if !c.cached[p] {
		c.cached[p] = true
		c.used += c.fileSize
	}
	c.touch(p)
	return c.fileSize, nil
}

// evictTo drops least-recently-used files until used is at most want, the way
// rclone's own cache poll reclaims space between fill passes.
func (c *fakeCache) evictTo(want int64) {
	for c.used > want && len(c.order) > 0 {
		c.evictOldest()
	}
}

func (c *fakeCache) evictOldest() {
	victim := c.order[0]
	c.order = c.order[1:]
	if c.cached[victim] {
		delete(c.cached, victim)
		c.used -= c.fileSize
	}
}

func (c *fakeCache) touch(p string) {
	for i, q := range c.order {
		if q == p {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
	c.order = append(c.order, p)
}

// A pass with nothing kept offline and nothing opened in the window must not
// refresh the directory cache at all: the whole-tree refresh on a timer is the
// bug (drive#568).
func TestFillIssuesNoRefreshWithNothingOpened(t *testing.T) {
	b := &countedBackend{used: 1 << 30, cap: 20 << 30}
	res, err := fillPass(context.Background(), b, fillTargets{}, 0.1, 0.1)
	if err != nil {
		t.Fatalf("fillPass with nothing opened: %v", err)
	}
	if res.Ran() {
		t.Error("the fill ran with nothing opened and nothing kept offline")
	}
	if b.refreshes != 0 {
		t.Errorf("the fill refreshed the directory cache %d times with nothing to fill, want none", b.refreshes)
	}
	if b.recursiveRefreshes != 0 {
		t.Errorf("the fill refreshed the directory recursively %d times, want none", b.recursiveRefreshes)
	}
}

func TestFillTargetsHonoursCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reads := 0
	targets := fillTargets{
		ctx:     ctx,
		offline: []string{"keep.bin"},
		recent:  []string{"a.bin"},
		readFile: func(string) (int64, error) {
			reads++
			return 1, nil
		},
	}
	if _, err := targets.read(true, 1<<20); err == nil {
		t.Fatal("a cancelled fill read returned no error")
	}
	if reads != 0 {
		t.Errorf("a cancelled fill still read %d files", reads)
	}
}

func TestFillTargetsSkipsUnpinnedFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "keep.bin"), []byte("pin"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "other.bin"), []byte("skip"), 0o644); err != nil {
		t.Fatal(err)
	}
	var read []string
	targets := fillTargets{
		root:    dir,
		offline: []string{"keep.bin"},
		recent:  []string{"other.bin"},
		readFile: func(p string) (int64, error) {
			read = append(read, filepath.Base(p))
			return 4, nil
		},
	}
	if _, err := targets.read(false, 1<<20); err != nil {
		t.Fatal(err)
	}
	if len(read) != 0 {
		t.Errorf("an unpinned file was filled: %v", read)
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
