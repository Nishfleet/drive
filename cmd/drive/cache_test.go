package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeCacheMax(t *testing.T, home, size string) {
	t.Helper()
	if err := os.MkdirAll(DefaultConfigDir(home), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(CacheMaxPath(home), []byte(size+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

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
	if err := BuildMountPlan("linux", home, "/usr/bin/rclone", testStorage()).err; err == nil {
		t.Error("a mount plan built on an impossible cache limit must carry the failure")
	}
}

// rclone reads --vfs-cache-max-size 0 as no cache at all.
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
		item := LoginItem(tc.goos, withProductBin(p))
		if !strings.Contains(item, "mount") || !strings.Contains(item, "--foreground") {
			t.Errorf("%s: the login item does not run the product:\n%s", tc.goos, item)
		}
	}
}

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
	maxSize, err := ResolveCacheMax(home)
	if err != nil {
		t.Fatal(err)
	}
	if maxSize != "5G" {
		t.Errorf("limit = %q, want 5G", maxSize)
	}
	used, files, err = CacheUse(DefaultCacheDir(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	if used != 0 || files != 0 {
		t.Errorf("an unused cache measures %d bytes in %d files, want 0 and 0", used, files)
	}
}

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
	if _, err := os.Stat(filepath.Join(DefaultCacheDir(home), "vfsMeta", "drive", "bucket", "u", "me", "queued.bin")); err != nil {
		t.Errorf("the metadata for the file waiting to upload was deleted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(DefaultCacheDir(home), "vfsMeta", "drive", "bucket", "u", "me", "done.bin")); !os.IsNotExist(err) {
		t.Errorf("the metadata for a cleared file should be gone, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(DefaultCacheDir(home), "vfs", "drive", "bucket", "u", "me", "queued.bin")); err != nil {
		t.Errorf("the file waiting to upload was deleted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(DefaultCacheDir(home), "vfs", "drive", "bucket", "u", "me", "done.bin")); !os.IsNotExist(err) {
		t.Errorf("a cached file that is uploaded should be gone, stat err = %v", err)
	}
	if err := ClearCache(DefaultCacheDir(t.TempDir()), nil); err != nil {
		t.Fatalf("clear on an unused cache: %v", err)
	}
}

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

func TestCacheRefusesTwoOperationsAtOnce(t *testing.T) {
	err := runCache([]string{"--max", "5G", "--clear", "--home", t.TempDir()})
	if err == nil {
		t.Fatal("two operations at once must be refused, not half-run")
	}
	if !strings.Contains(err.Error(), "one thing at a time") {
		t.Errorf("the refusal says what to do instead: %v", err)
	}
}

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
