package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// `drive cache` (issue #112): one test per thing the issue says the command
// must do, each driving the real code rather than a copy of it. The mount-side
// proofs (a real mount, the storage stand-in, a file read past the cap) live in
// e2e_test.go beside the other stand-in proofs; this file is the command.

// writeCacheMax writes the limit the way `drive cache --max` writes it, so a
// test of the mount and a test of the command share one file shape.
func writeCacheMax(t *testing.T, home, size string) {
	t.Helper()
	if err := os.MkdirAll(DefaultConfigDir(home), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(CacheMaxPath(home), []byte(size+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// writeCached writes one cached file under the cache dir the way rclone writes
// it: bytes under vfs/<remote>/<path>, metadata under vfsMeta/<remote>/<path>.
// The remote part is the mount's own, so a test does not decide the layout.
func writeCached(t *testing.T, home, relative string, size int, dirty bool) {
	t.Helper()
	cache := DefaultCacheDir(home)
	data := filepath.Join(cache, "vfs", "drive", relative)
	if err := os.MkdirAll(filepath.Dir(data), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(data, make([]byte, size), 0o600); err != nil {
		t.Fatal(err)
	}
	meta := VFSMeta{}
	if dirty {
		meta.Dirty = true
	}
	meta.Size = int64(size)
	body, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	metaPath := filepath.Join(cache, "vfsMeta", "drive", relative)
	if err := os.MkdirAll(filepath.Dir(metaPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(metaPath, body, 0o600); err != nil {
		t.Fatal(err)
	}
}

// The limit is a setting, not a constant the mount remembers: the value
// `drive cache --max` wrote is the value the mount runs with, and a machine
// that never chose one gets the shipped default.
func TestResolveCacheMaxReadsWhatThePersonSet(t *testing.T) {
	home := t.TempDir()
	got, err := ResolveCacheMax(home)
	if err != nil {
		t.Fatal(err)
	}
	if got != vfsCacheMaxValue {
		t.Errorf("with no setting the limit is %q, want the shipped default %q", got, vfsCacheMaxValue)
	}
	writeCacheMax(t, home, "5G")
	got, err = ResolveCacheMax(home)
	if err != nil {
		t.Fatal(err)
	}
	if got != "5G" {
		t.Errorf("limit = %q, want 5G", got)
	}
}

// A limit rclone would refuse is a named error, and the mount is never started
// with a limit nobody could state. The default is not silently substituted:
// after `drive cache --max 5G`, a mount that ran with 20G would put the bytes
// somewhere the command's own number says they cannot be.
func TestResolveCacheMaxRefusesWhatRcloneWould(t *testing.T) {
	home := t.TempDir()
	writeCacheMax(t, home, "20Z")
	if _, err := ResolveCacheMax(home); err == nil {
		t.Fatal("a cache limit rclone refuses must be an error, not a quiet default")
	} else if !strings.Contains(err.Error(), CacheMaxPath(home)) {
		t.Errorf("the error names the file: %v", err)
	} else if !strings.Contains(err.Error(), "20Z") {
		t.Errorf("the error names the value it was given: %v", err)
	}
	// A mount against that home refuses to start, so the limit on the mount
	// is always the limit the person typed.
	if err := BuildMountPlan("linux", home, "/usr/bin/rclone", testStorage()).err; err == nil {
		t.Error("a mount plan built on an impossible cache limit must carry the failure")
	}
}

// `drive cache --max` validates the size and writes it, and refuses a limit of
// nothing: rclone reads `--vfs-cache-max-size 0` as no cache at all, which
// would take the cache away from someone who typed a digit by mistake.
func TestSaveCacheMaxValidates(t *testing.T) {
	home := t.TempDir()
	for _, bad := range []string{"five", "5Z", "0", "-1G"} {
		if err := SaveCacheMax(home, bad); err == nil {
			t.Errorf("SaveCacheMax(%q) must refuse a size rclone would not read", bad)
		}
	}
	if _, err := os.Stat(CacheMaxPath(home)); err == nil {
		t.Error("a refused limit must not be written, so the mount keeps the one already there")
	}
	if err := SaveCacheMax(home, "500M"); err != nil {
		t.Fatal(err)
	}
	got, err := ResolveCacheMax(home)
	if err != nil {
		t.Fatal(err)
	}
	if got != "500M" {
		t.Errorf("limit = %q, want 500M", got)
	}
}

// The mount carries the person's limit and the free-space floor, and the
// login item runs the product so the same pair is applied at login: the
// limit a person typed is the one rclone enforces, on whichever platform.
func TestMountCarriesTheCacheCap(t *testing.T) {
	home := t.TempDir()
	writeCacheMax(t, home, "5G")
	for _, tc := range []struct{ goos, needle string }{
		{"darwin", "nfsmount"},
		{"linux", "mount"},
	} {
		p := BuildMountPlan(tc.goos, home, "/usr/bin/rclone", testStorage())
		if p.err != nil {
			t.Fatalf("%s: %v", tc.goos, p.err)
		}
		if p.CacheMax != "5G" {
			t.Errorf("%s: plan cache max = %q, want 5G", tc.goos, p.CacheMax)
		}
		want := []struct{ flag, value string }{
			{"--vfs-cache-max-size", "5G"},
			{"--vfs-cache-min-free-space", vfsCacheMinFreeSpaceValue},
			{"--vfs-cache-mode", vfsCacheModeValue},
			{"--vfs-write-back", vfsWriteBackValue},
			{"--dir-cache-time", vfsDirCacheTimeValue},
		}
		for _, pair := range want {
			if !hasArgPair(p.Args(), pair.flag, pair.value) {
				t.Errorf("%s: %s %s is not an adjacent pair on the command line:\n%v",
					tc.goos, pair.flag, pair.value, p.Args())
			}
		}
		// The login item runs the product, which reads the same cache-max
		// file this plan used, so the cap cannot drift between a foreground
		// mount and the mount at login (drive#515).
		item := LoginItem(tc.goos, withProductBin(p))
		if !strings.Contains(item, "mount") || !strings.Contains(item, "--foreground") {
			t.Errorf("%s: the login item does not run the product:\n%s", tc.goos, item)
		}
	}
}

// The default is unchanged: a machine that never touched `drive cache --max`
// still mounts with the number main always shipped. The hill-climb guardrails
// (#224) still pin the four safety values, so a cache change cannot trade one
// away.
func TestCacheDefaultIsTheShippedCap(t *testing.T) {
	p := BuildMountPlan("linux", t.TempDir(), "/usr/bin/rclone", testStorage())
	if p.CacheMax != vfsCacheMaxValue {
		t.Errorf("default cache max = %q, want the shipped %q", p.CacheMax, vfsCacheMaxValue)
	}
	args := VFSArgs(vfsCacheMaxValue)
	for _, pair := range [][2]string{
		{"--vfs-cache-max-size", vfsCacheMaxValue},
		{"--vfs-cache-min-free-space", vfsCacheMinFreeSpaceValue},
	} {
		if !hasArgPair(args, pair[0], pair[1]) {
			t.Errorf("the shipped mount args carry %s %s:\n%v", pair[0], pair[1], args)
		}
	}
}

// `drive cache` answers the question with the two numbers, measured where
// rclone keeps the bytes rather than counted by a second index.
func TestPrintCacheReportsDiskUseAndLimit(t *testing.T) {
	home := t.TempDir()
	writeCacheMax(t, home, "5G")
	writeCached(t, home, "bucket/u/me/movie.mp4", 3<<20, false)
	writeCached(t, home, "bucket/u/me/doc.txt", 1<<20, false)

	used, files, err := CacheUse(DefaultCacheDir(home))
	if err != nil {
		t.Fatal(err)
	}
	if used != 4<<20 {
		t.Errorf("cache on disk = %d bytes, want 4 MiB", used)
	}
	if files != 2 {
		t.Errorf("files = %d, want 2", files)
	}
	// The mount's live limit is the same number the command prints, and it is
	// the one rclone enforces.
	maxSize, err := ResolveCacheMax(home)
	if err != nil {
		t.Fatal(err)
	}
	if maxSize != "5G" {
		t.Errorf("limit = %q, want 5G", maxSize)
	}
	// A cache that was never used is an answer, not an error: 0 bytes in 0
	// files is what an empty cache is.
	used, files, err = CacheUse(DefaultCacheDir(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	if used != 0 || files != 0 {
		t.Errorf("an unused cache measures %d bytes in %d files, want 0 and 0", used, files)
	}
}

// `drive cache --clear` empties the cache and leaves the files that are still
// waiting to upload, which is the finish line's second half. The queue is read
// from rclone's own metadata, so this is the same rule the mount holds to.
func TestClearCacheKeepsTheUploadsWaiting(t *testing.T) {
	home := t.TempDir()
	writeCached(t, home, "bucket/u/me/done.bin", 2<<20, false)
	writeCached(t, home, "bucket/u/me/queued.bin", 1<<20, true)
	writeCached(t, home, "bucket/u/me/small.txt", 1<<10, false)

	if err := ClearCache(DefaultCacheDir(home), nil); err != nil {
		t.Fatal(err)
	}
	kept, err := PendingUploads(DefaultCacheDir(home))
	if err != nil {
		t.Fatal(err)
	}
	if kept.Files != 1 {
		t.Errorf("queue after clear holds %d files, want the 1 still waiting", kept.Files)
	}
	if kept.Bytes != 1<<20 {
		t.Errorf("queue after clear holds %d bytes, want the queued file's own 1 MiB", kept.Bytes)
	}
	used, files, err := CacheUse(DefaultCacheDir(home))
	if err != nil {
		t.Fatal(err)
	}
	if used != 1<<20 {
		t.Errorf("cache after clear holds %d bytes, want only the file still waiting to upload", used)
	}
	if files != 1 {
		t.Errorf("cache after clear holds %d files, want only the one still waiting", files)
	}
	// The queued file's own bytes are still there: it is the person's work,
	// and `--clear` exists to give disk back, not to take it away. And
	// the metadata that says it is queued is what rclone reads on the
	// next mount, so it stays too.
	if _, err := os.Stat(filepath.Join(DefaultCacheDir(home), "vfsMeta", "drive", "bucket", "u", "me", "queued.bin")); err != nil {
		t.Errorf("the metadata for the file waiting to upload was deleted: %v", err)
	}
	// The metadata for the cleared file is gone as well as its bytes:
	// a record that points at bytes that are not there is a read that
	// errors instead of fetching again, and an emptied cache means the
	// next open is a cold read.
	if _, err := os.Stat(filepath.Join(DefaultCacheDir(home), "vfsMeta", "drive", "bucket", "u", "me", "done.bin")); !os.IsNotExist(err) {
		t.Errorf("the metadata for a cleared file should be gone, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(DefaultCacheDir(home), "vfs", "drive", "bucket", "u", "me", "queued.bin")); err != nil {
		t.Errorf("the file waiting to upload was deleted: %v", err)
	}
	// And the cached file that is uploaded is gone.
	if _, err := os.Stat(filepath.Join(DefaultCacheDir(home), "vfs", "drive", "bucket", "u", "me", "done.bin")); !os.IsNotExist(err) {
		t.Errorf("a cached file that is uploaded should be gone, stat err = %v", err)
	}
	// Clearing an already-empty cache is not an error: it is what an empty
	// cache is.
	if err := ClearCache(DefaultCacheDir(t.TempDir()), nil); err != nil {
		t.Fatalf("clear on an unused cache: %v", err)
	}
}

// `drive cache --clear` must not drop a file `drive offline` promised to keep
// (issue #115). The uploads waiting still survive the same walk.
func TestClearCacheKeepsOfflineFiles(t *testing.T) {
	home := t.TempDir()
	writeCached(t, home, "bucket/u/me/done.bin", 2<<20, false)
	writeCached(t, home, "bucket/u/me/keep.bin", 3<<20, false)
	writeCached(t, home, "bucket/u/me/queued.bin", 1<<20, true)
	if err := SaveOffline(home, OfflineIndex{Paths: []string{"keep.bin"}}); err != nil {
		t.Fatal(err)
	}
	if err := ClearCache(DefaultCacheDir(home), []string{"keep.bin"}); err != nil {
		t.Fatal(err)
	}
	used, files, err := CacheUse(DefaultCacheDir(home))
	if err != nil {
		t.Fatal(err)
	}
	if used != 4<<20 {
		t.Errorf("cache after clear holds %d bytes, want the offline file plus the upload still waiting", used)
	}
	if files != 2 {
		t.Errorf("cache after clear holds %d files, want keep.bin and queued.bin", files)
	}
	if _, err := os.Stat(filepath.Join(DefaultCacheDir(home), "vfs", "drive", "bucket", "u", "me", "keep.bin")); err != nil {
		t.Errorf("the kept-offline file was deleted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(DefaultCacheDir(home), "vfs", "drive", "bucket", "u", "me", "done.bin")); !os.IsNotExist(err) {
		t.Errorf("a cached file that is neither queued nor kept offline should be gone, stat err = %v", err)
	}
}

// The three commands the issue names, each through the real entry point.
func TestDriveCacheCommands(t *testing.T) {
	home := t.TempDir()
	writeCached(t, home, "bucket/u/me/keep.bin", 2<<20, false)
	writeCached(t, home, "bucket/u/me/other.bin", 1<<20, false)
	if err := SaveOffline(home, OfflineIndex{Paths: []string{"keep.bin"}}); err != nil {
		t.Fatal(err)
	}

	var err error
	out := captureStdout(t, func() {
		err = runCache([]string{"--home", home, "--max", "5G"})
	})
	if err != nil {
		t.Fatalf("drive cache --max: %v\n%s", err, out)
	}
	if !strings.Contains(out, "cache limit set to 5G") {
		t.Errorf("drive cache --max: %q", out)
	}
	got, err := ResolveCacheMax(home)
	if err != nil {
		t.Fatal(err)
	}
	if got != "5G" {
		t.Errorf("limit after --max = %q, want 5G", got)
	}

	out = captureStdout(t, func() {
		err = runCache([]string{"--home", home})
	})
	if err != nil {
		t.Fatalf("drive cache: %v\n%s", err, out)
	}
	if !strings.Contains(out, "cache on disk:") || !strings.Contains(out, "cache limit: 5G") {
		t.Errorf("drive cache: %q", out)
	}
	if !strings.Contains(out, "kept offline:") || !strings.Contains(out, "counting toward the limit") {
		t.Errorf("drive cache should name the kept-offline files against the limit: %q", out)
	}

	out = captureStdout(t, func() {
		err = runCache([]string{"--home", home, "--clear"})
	})
	if err != nil {
		t.Fatalf("drive cache --clear: %v\n%s", err, out)
	}
	if !strings.Contains(out, "files kept offline stay") {
		t.Errorf("drive cache --clear: %q", out)
	}
	if _, err := os.Stat(filepath.Join(DefaultCacheDir(home), "vfs", "drive", "bucket", "u", "me", "keep.bin")); err != nil {
		t.Errorf("drive cache --clear dropped the kept-offline file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(DefaultCacheDir(home), "vfs", "drive", "bucket", "u", "me", "other.bin")); !os.IsNotExist(err) {
		t.Errorf("drive cache --clear left a file it should have dropped, stat err = %v", err)
	}
}

// The command's own guard: `drive cache --max 5G --clear` is refused rather
// than half-run, so a person cannot end up not knowing which of the two ran.
func TestCacheRefusesTwoOperationsAtOnce(t *testing.T) {
	err := runCache([]string{"--max", "5G", "--clear", "--home", t.TempDir()})
	if err == nil {
		t.Fatal("two operations at once must be refused, not half-run")
	}
	if !strings.Contains(err.Error(), "one thing at a time") {
		t.Errorf("the refusal says what to do instead: %v", err)
	}
}

// `drive status` carries the cache line, so a person who already has the drive
// open does not need a second command to see what it uses. It is the same
// numbers `drive cache` prints.
func TestStatusCarriesTheCacheLine(t *testing.T) {
	home := t.TempDir()
	writeCacheMax(t, home, "5G")
	writeCached(t, home, "bucket/u/me/movie.mp4", 3<<20, false)
	var reason string
	out := captureStdout(t, func() {
		reason = cacheStatusLine(home)
	})
	if reason != "" {
		t.Fatalf("cacheStatusLine: %s", reason)
	}
	if !strings.Contains(out, "cache:") || !strings.Contains(out, "5G") {
		t.Fatalf("drive status cache line = %q", out)
	}
	if !strings.Contains(out, FormatBytes(3<<20)) {
		t.Errorf("cache line missing the measured size: %q", out)
	}
}

func TestClearCacheRefusesWhileMounted(t *testing.T) {
	home := t.TempDir()
	writeCached(t, home, "bucket/u/me/other.bin", 1<<20, false)
	orig := mountOn
	mountOn = func(string, string) (bool, error) { return true, nil }
	t.Cleanup(func() { mountOn = orig })
	err := runCache([]string{"--home", home, "--clear"})
	if err == nil {
		t.Fatal("clearing the cache under a live mount must be refused")
	}
	if !strings.Contains(err.Error(), "mounted") {
		t.Errorf("got %v, want a mounted refusal", err)
	}
	if _, statErr := os.Stat(filepath.Join(DefaultCacheDir(home), "vfs", "drive", "bucket", "u", "me", "other.bin")); statErr != nil {
		t.Errorf("the refusal deleted a cache file: %v", statErr)
	}
}
