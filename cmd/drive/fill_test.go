package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

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
		if !hasArgPair(args, "--vfs-cache-max-size", vfsCacheMaxValue) {
			t.Errorf("%s: mount lost --vfs-cache-max-size %s:\n%v", tc.goos, vfsCacheMaxValue, args)
		}
		rcAddr := argValue(args, "--rc-addr")
		if rcAddr == "" || !IsLoopbackAddr(rcAddr) {
			t.Errorf("%s: mount is not binding the remote control to loopback:\n%v", tc.goos, args)
		}
		if !hasArg(args, "--rc") {
			t.Errorf("%s: mount does not enable the remote control:\n%v", tc.goos, args)
		}
	}
}

func TestBackgroundFillSizesAreRcloneSizes(t *testing.T) {
	p := DefaultFillPolicy()
	readAhead, err := parseSizeSuffix(p.ReadAhead)
	if err != nil {
		t.Fatalf("read-ahead %q: %v", p.ReadAhead, err)
	}
	if readAhead <= 0 {
		t.Errorf("read-ahead %s is not a size rclone can fetch a chunk with", p.ReadAhead)
	}
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

func TestReadLoadAverages(t *testing.T) {
	one, five, err := readLoadAverages()
	if err != nil {
		t.Fatalf("read /proc/loadavg on this host: %v", err)
	}
	if one < 0 || five < 0 {
		t.Errorf("load averages = %v, %v; want two non-negative numbers", one, five)
	}
	if ShouldFill(false, one, five) != (one < idleLoad && five < idleLoad) {
		t.Errorf("ShouldFill disagrees with the thresholds at this host's load %v/%v", one, five)
	}
	if _, _, err := readLoadAveragesFrom("/nonexistent/loadavg"); err == nil {
		t.Error("an unreadable load average returned no error; the fill would read it as idle")
	}
}

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
		readFile: func(_ context.Context, p string) (int64, error) {
			read = append(read, filepath.Base(p))
			return 60, nil
		},
	}
	ctx := context.Background()
	if _, err := targets.read(ctx, true, 60); err != nil {
		t.Fatalf("read under the budget: %v", err)
	}
	if len(read) != 1 || read[0] != "a.bin" {
		t.Errorf("the budgeted read read %v, want only a.bin", read)
	}
	read = nil
	if _, err := targets.read(ctx, false, 1<<20); err != nil {
		t.Fatalf("read with the recent set off: %v", err)
	}
	if len(read) != 0 {
		t.Errorf("the pass read %v although it was not filling recently-opened files", read)
	}
	targets.recent = []string{"gone.bin"}
	targets.readFile = nil
	if _, err := targets.read(ctx, true, 1<<20); err != nil {
		t.Errorf("a removed file failed the fill: %v", err)
	}
	if _, err := fillReadFile(ctx, dir); err == nil {
		t.Error("reading a directory as a file returned no error")
	}
}

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

type countedBackend struct {
	used               int64
	cap                int64
	refreshes          int
	namedDirRefreshes  int
	recursiveRefreshes int
	addPerRead         int64
	unreach            error
	refreshErr         error
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
	return b.refreshErr
}

func (b *countedBackend) reachable(context.Context) error { return b.unreach }

func (b *countedBackend) refreshDirs(_ context.Context, dirs []string) error {
	if len(dirs) == 0 {
		return nil
	}
	b.namedDirRefreshes += len(dirs)
	return nil
}

func (b *countedBackend) remote() string { return "drive:bucket/u/1" }

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
		if b.refreshes != 1 {
			t.Errorf("the fill refreshed the directory %d times at the cap, want 1 (issue #541 freshness)", b.refreshes)
		}
		if b.recursiveRefreshes != 0 {
			t.Errorf("the fill refreshed the directory recursively %d times, want none", b.recursiveRefreshes)
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
		if b.refreshes != 1 {
			t.Errorf("the busy machine still refreshes listings %d times, want 1 (issue #541 freshness)", b.refreshes)
		}
	})

	t.Run("a pass that would leave the cache over the cap is a named failure", func(t *testing.T) {
		capBytes, _ := parseSizeSuffix("20G")
		b := &countedBackend{used: capBytes - (1 << 20), cap: capBytes, addPerRead: 4 << 30}
		targets := fillTargets{
			recent: []string{"big.bin"},
			readFile: func(context.Context, string) (int64, error) {
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
			readFile: func(context.Context, string) (int64, error) {
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
	if _, err := targets.read(context.Background(), false, 0); err != nil {
		t.Fatalf("walking a kept-offline folder: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep", "new.txt"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := targets.read(context.Background(), false, 0); err != nil {
		t.Fatalf("a new file inside a kept-offline folder failed the keep-warm: %v", err)
	}
}

func TestRecentOpensTracksAndDropsOpens(t *testing.T) {
	r := &recentOpens{opened: map[string]time.Time{}, filled: map[string]time.Time{}, sizes: map[string]int64{}}
	now := time.Now()
	r.record("/m/a.bin")
	r.record("/m/sub/b.bin")
	r.record("/elsewhere/c.bin")
	if got := strings.Join(r.since("/m", now.Add(time.Second), 24*time.Hour), ","); got != "a.bin,sub/b.bin" {
		t.Errorf("since = %q, want %q", got, "a.bin,sub/b.bin")
	}
	r.markFilled("/m/a.bin", 10)
	if got := r.windowBytes(); got != 10 {
		t.Errorf("windowBytes = %d after filling one file, want 10", got)
	}
	if got := strings.Join(r.since("/m", now.Add(time.Second), 24*time.Hour), ","); got != "sub/b.bin" {
		t.Errorf("after markFilled, since = %q, want %q", got, "sub/b.bin")
	}
	if got := r.since("/m", now.Add(48*time.Hour), 24*time.Hour); len(got) != 0 {
		t.Errorf("a stale open was still a target: %v", got)
	}
	if got := r.windowBytes(); got != 0 {
		t.Errorf("windowBytes = %d after the window aged out, want 0", got)
	}
}

func TestFillDoesNotReDownloadADriveLargerThanTheCache(t *testing.T) {
	capBytes, err := parseSizeSuffix("1G")
	if err != nil {
		t.Fatal(err)
	}
	const fileSize = int64(64 << 20)
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
		readFile: func(_ context.Context, p string) (int64, error) {
			reads++
			n, err := cache.read(p)
			b.used = cache.used
			return n, err
		},
	}
	for pass := 0; pass < 10; pass++ {
		cache.evictTo(capBytes / 2)
		b.used = cache.used
		targets.recent = opens.since(root, time.Now(), fillRecentAge)
		if _, err := fillPass(context.Background(), b, targets, 0.1, 0.1); err != nil {
			t.Fatalf("idle pass %d: %v", pass+1, err)
		}
	}
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

func TestFillRefreshesRootWhenNothingOpened(t *testing.T) {
	b := &countedBackend{used: 1 << 30, cap: 20 << 30}
	res, err := fillPass(context.Background(), b, fillTargets{}, 0.1, 0.1)
	if err != nil {
		t.Fatalf("fillPass with nothing opened: %v", err)
	}
	if res.Ran() {
		t.Error("the fill ran with nothing opened and nothing kept offline")
	}
	if b.refreshes != 1 {
		t.Errorf("the fill refreshed the directory cache %d times with nothing to fill, want 1 (issue #541 freshness)", b.refreshes)
	}
	if b.recursiveRefreshes != 0 {
		t.Errorf("the fill refreshed the directory recursively %d times, want none", b.recursiveRefreshes)
	}
}

func TestFillSkipsRefreshWhenStorageIsDownAndStillKeepWarms(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "keep.bin"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	b := &countedBackend{used: 1 << 20, cap: 20 << 30, unreach: errors.New("storage is down")}
	res, err := fillPass(context.Background(), b, fillTargets{root: dir, offline: []string{"keep.bin"}}, 0.1, 0.1)
	if err != nil {
		t.Fatalf("fillPass with storage down: %v", err)
	}
	if !res.Ran() {
		t.Error("the keep-warm pass did not run while storage was down")
	}
	if b.refreshes != 0 {
		t.Errorf("the fill refreshed the directory %d times with storage down, want none", b.refreshes)
	}
}

func TestFillSkipsRecentOpensWhenStorageIsDown(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "keep.bin"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	var reads []string
	b := &countedBackend{used: 1 << 20, cap: 20 << 30, unreach: errors.New("storage is down")}
	targets := fillTargets{
		root:    dir,
		offline: []string{"keep.bin"},
		recent:  []string{"opened.txt"},
		readFile: func(_ context.Context, p string) (int64, error) {
			reads = append(reads, p)
			return int64(len(p)), nil
		},
	}
	res, err := fillPass(context.Background(), b, targets, 0.1, 0.1)
	if err != nil {
		t.Fatalf("fillPass with storage down: %v", err)
	}
	if !res.Ran() {
		t.Error("the keep-warm pass did not run while storage was down")
	}
	if len(reads) != 0 {
		t.Errorf("the fill read %v with storage down, want no recently-opened file", reads)
	}
}

func TestFillFillsRecentOpensWhenStorageAnswers(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "opened.txt"), []byte("opened"), 0o644); err != nil {
		t.Fatal(err)
	}
	var reads []string
	b := &countedBackend{used: 1 << 20, cap: 20 << 30}
	targets := fillTargets{
		root:   dir,
		recent: []string{"opened.txt"},
		readFile: func(_ context.Context, p string) (int64, error) {
			reads = append(reads, p)
			return 1, nil
		},
	}
	res, err := fillPass(context.Background(), b, targets, 0.1, 0.1)
	if err != nil {
		t.Fatalf("fillPass with storage up: %v", err)
	}
	if !res.Ran() || !res.Idle {
		t.Errorf("an idle fill with storage up did not run: %+v", res)
	}
	if len(reads) != 1 || reads[0] != filepath.Join(dir, "opened.txt") {
		t.Errorf("the fill read %v with storage up, want the opened file", reads)
	}
}

func TestFillRefreshesAKeptOfflineFolder(t *testing.T) {
	dir := t.TempDir()
	keep := filepath.Join(dir, "photos")
	if err := os.Mkdir(keep, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(keep, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	b := &countedBackend{used: 1 << 20, cap: 20 << 30}
	res, err := fillPass(context.Background(), b, fillTargets{root: dir, offline: []string{"photos"}}, 0.1, 0.1)
	if err != nil {
		t.Fatalf("fillPass for a kept folder: %v", err)
	}
	if !res.Ran() {
		t.Fatal("the keep-warm pass did not run")
	}
	if b.namedDirRefreshes != 1 {
		t.Errorf("named directory refreshes = %d, want 1 (the kept folder)", b.namedDirRefreshes)
	}
}

func TestVfsRefreshReplyError(t *testing.T) {
	if err := vfsRefreshReplyError(map[string]any{"result": map[string]any{"": "OK"}}, false); err != nil {
		t.Errorf("OK: %v", err)
	}
	err := vfsRefreshReplyError(map[string]any{"result": map[string]any{"": "connection refused"}}, false)
	if err == nil || !strings.Contains(err.Error(), "connection refused") {
		t.Errorf("root listing failure: %v", err)
	}
	if err := vfsRefreshReplyError(map[string]any{"result": map[string]any{"photos": "directory not found"}}, true); err != nil {
		t.Errorf("skipFailed must ignore a named-dir not-found: %v", err)
	}
	err = vfsRefreshReplyError(map[string]any{"result": map[string]any{"photos": "connection refused"}}, true)
	if err == nil || !strings.Contains(err.Error(), "connection refused") {
		t.Errorf("skipFailed must not swallow a real named-dir failure: %v", err)
	}
	err = vfsRefreshReplyError(map[string]any{"result": nil}, false)
	if err == nil {
		t.Error("a null result must be a named failure, not a silent OK")
	}
	if err := vfsRefreshReplyError(map[string]any{}, false); err == nil {
		t.Error("an empty reply must be a named failure, not a silent OK")
	}
}

func TestFillRefreshFailureIsNamed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "keep.bin"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	b := &countedBackend{used: 1 << 20, cap: 20 << 30, refreshErr: errors.New("connection reset by peer")}
	res, err := fillPass(context.Background(), b, fillTargets{root: dir, offline: []string{"keep.bin"}}, 0.1, 0.1)
	if err == nil || !strings.Contains(err.Error(), "refresh directory cache") {
		t.Fatalf("fillPass with a failing refresh: %v", err)
	}
	if !strings.Contains(err.Error(), "connection reset by peer") {
		t.Errorf("the error does not carry the backend's own message: %v", err)
	}
	if b.namedDirRefreshes != 0 {
		t.Errorf("the fill refreshed %d named folders after the root refresh failed, want none: a half-refreshed listing is what the caller would read as fresh", b.namedDirRefreshes)
	}
	if res.Refreshed {
		t.Error("the fill reported a refreshed directory cache from a refresh that failed")
	}
}

func TestFillReadStopsWithinOneChunkOfTheDeadline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close(); w.Close() })

	const ticks = 30
	const piece = fillReadChunk / 2
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	var written atomic.Int64
	go func() {
		buf := bytes.Repeat([]byte("x"), piece)
		for i := 0; i < ticks; i++ {
			select {
			case <-stop:
				return
			default:
			}
			n, err := w.Write(buf)
			written.Add(int64(n))
			if err != nil {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
	}()

	type outcome struct {
		n   int64
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		n, err := readCtxChunked(ctx, r)
		done <- outcome{n, err}
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	atDeadline := written.Load()
	if atDeadline == 0 {
		t.Fatal("the writer fed the pipe nothing before the deadline, so the test cannot prove a stop")
	}
	var got outcome
	select {
	case got = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the read was still running 5s after the deadline, so it did not stop at the pass deadline")
	}
	if !errors.Is(got.err, context.Canceled) {
		t.Fatalf("the read returned %v after the deadline, want %v", got.err, context.Canceled)
	}
	if extra := got.n - atDeadline; extra > fillReadChunk {
		t.Errorf("the read continued for %d bytes after the deadline, want at most one %d-byte chunk "+
			"(read %d bytes, %d had been written when the deadline landed)",
			extra, fillReadChunk, got.n, atDeadline)
	}
}

func TestFillReadFileStopsAtTheDeadline(t *testing.T) {
	dir := t.TempDir()
	const size = 3 * fillReadChunk
	path := filepath.Join(dir, "big.bin")
	if err := os.WriteFile(path, bytes.Repeat([]byte("x"), size), 0o644); err != nil {
		t.Fatal(err)
	}
	n, err := fillReadFile(context.Background(), path)
	if err != nil {
		t.Fatalf("read a %d-byte file with the deadline unexpired: %v", size, err)
	}
	if n != size {
		t.Errorf("read %d bytes of a %d-byte file, want all of it", n, size)
	}
	dead, cancel := context.WithCancel(context.Background())
	cancel()
	deadBytes, err := fillReadFile(dead, path)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("read with the deadline already passed returned %v, want %v", err, context.Canceled)
	}
	if deadBytes != 0 {
		t.Errorf("read %d bytes with the deadline already passed, want 0", deadBytes)
	}
}

func TestFillTargetsReadStopsWhenAReadHitsTheDeadline(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"a.bin", "b.bin", "c.bin"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	const gotThrough = 1 << 20
	var read []string
	targets := fillTargets{
		root:   dir,
		recent: []string{"a.bin", "b.bin", "c.bin"},
		readFile: func(_ context.Context, p string) (int64, error) {
			read = append(read, filepath.Base(p))
			if len(read) > 1 {
				return 10, nil
			}
			cancel()
			return gotThrough, context.Canceled
		},
	}
	spent, err := targets.read(ctx, true, 1<<30)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("the read returned %v after the deadline, want %v", err, context.Canceled)
	}
	if len(read) != 1 || read[0] != "a.bin" {
		t.Errorf("the pass read %v after the deadline, want only a.bin", read)
	}
	if spent != 0 {
		t.Errorf("the pass reported %d bytes read, want 0: the pass aborts on the read "+
			"error, so the failed read's bytes are not part of its result", spent)
	}
}

func TestReadCtxChunkedStopsWhenCancelledDuringARead(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := &cancelAfterReader{cancelOn: 3, cancel: cancel}
	done := make(chan struct{})
	var n int64
	var err error
	go func() {
		defer close(done)
		n, err = readCtxChunked(ctx, r)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the read kept going after the context was cancelled")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("read returned %v after cancel, want %v", err, context.Canceled)
	}
	if r.reads > r.cancelOn+1 {
		t.Errorf("read %d chunks, cancelled during chunk %d: it must stop within one chunk", r.reads, r.cancelOn)
	}
	if want := int64(r.reads) * fillReadChunk; n != want {
		t.Errorf("reported %d bytes, want %d (the chunks it read)", n, want)
	}
}

type cancelAfterReader struct {
	cancelOn, reads int
	cancel          context.CancelFunc
}

func (r *cancelAfterReader) Read(p []byte) (int, error) {
	r.reads++
	if r.reads == r.cancelOn {
		r.cancel()
	}
	time.Sleep(time.Millisecond)
	return len(p), nil
}

func TestFillReadChunkMatchesTheMountReadAhead(t *testing.T) {
	want, err := parseSizeSuffix(vfsReadAheadValue)
	if err != nil {
		t.Fatal(err)
	}
	if fillReadChunk != want {
		t.Errorf("fillReadChunk is %d bytes, want the shipped --vfs-read-ahead, %s = %d; "+
			"tune them together or the fill's deadline bound stops matching the mount's default read", fillReadChunk, vfsReadAheadValue, want)
	}
}

func TestFillTargetsHonoursCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reads := 0
	targets := fillTargets{
		offline: []string{"keep.bin"},
		recent:  []string{"a.bin"},
		readFile: func(context.Context, string) (int64, error) {
			reads++
			return 1, nil
		},
	}
	if _, err := targets.read(ctx, true, 1<<20); err == nil {
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
		readFile: func(_ context.Context, p string) (int64, error) {
			read = append(read, filepath.Base(p))
			return 4, nil
		},
	}
	if _, err := targets.read(context.Background(), false, 1<<20); err != nil {
		t.Fatal(err)
	}
	if len(read) != 0 {
		t.Errorf("an unpinned file was filled: %v", read)
	}
}

func hasArg(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}
