package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestVFSArgsAddsReadAheadAndKeepsDirCacheAndSkipsRefresh(t *testing.T) {
	args := VFSArgs()
	if !hasArgPair(args, "--vfs-read-ahead", vfsReadAheadValue) {
		t.Errorf("VFSArgs missing adjacent --vfs-read-ahead %s:\n%v", vfsReadAheadValue, args)
	}
	if !hasArgPair(args, "--dir-cache-time", "5s") {
		t.Errorf("VFSArgs missing adjacent --dir-cache-time 5s:\n%v", args)
	}
	for _, a := range args {
		if a == "--vfs-refresh" {
			t.Fatal("VFSArgs must not pass --vfs-refresh: rclone refreshes recursively at start, which is the wrong trigger and delays mount-ready")
		}
	}
}

func TestMountPlanCarriesReadAhead(t *testing.T) {
	p := BuildMountPlan("linux", "/home/test", "/usr/bin/rclone", testStorage())
	if !hasArgPair(p.Args(), "--vfs-read-ahead", "128k") {
		t.Errorf("linux Args missing --vfs-read-ahead 128k:\n%v", p.Args())
	}
	p = BuildMountPlan("darwin", "/Users/test", "/opt/homebrew/bin/rclone", testStorage())
	if !hasArgPair(p.Args(), "--vfs-read-ahead", "128k") {
		t.Errorf("darwin Args missing --vfs-read-ahead 128k:\n%v", p.Args())
	}
}

func TestPlanPrefetchListsChildDirsFirstAndCapsNAndM(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 40; i++ {
		if err := os.Mkdir(filepath.Join(dir, fmtName("d", i)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "small.bin"), make([]byte, 4096), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "big.bin"), make([]byte, 2<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := planPrefetch(dir, entries, 8, 256<<10, 128<<10, 1<<20)
	if len(got) != 8 {
		t.Fatalf("len=%d, want 8 (N cap)", len(got))
	}
	for i, tgot := range got {
		if !tgot.Dir {
			t.Fatalf("item %d is a file; dirs must come first so the next folder listing is warm", i)
		}
	}
	got = planPrefetch(dir, entries, 64, 8000, 128<<10, 1<<20)
	var files int
	for _, tgot := range got {
		if !tgot.Dir {
			files++
			if tgot.Path != filepath.Join(dir, "small.bin") {
				t.Fatalf("file target %s, want only small.bin under M", tgot.Path)
			}
		}
	}
	if files != 1 {
		t.Fatalf("files=%d, want 1 small.bin (big.bin is over the small-file cap and M is tiny)", files)
	}
}

func fmtName(prefix string, i int) string { return prefix + itoa2(i) }

func itoa2(i int) string {
	if i < 10 {
		return "0" + string(rune('0'+i))
	}
	return string(rune('0'+i/10)) + string(rune('0'+i%10))
}

func TestShouldSkipPrefetchOnMeteredOrBusy(t *testing.T) {
	if !shouldSkipPrefetch(true, false) || !shouldSkipPrefetch(false, true) {
		t.Fatal("metered or user-busy must skip")
	}
	if shouldSkipPrefetch(false, false) {
		t.Fatal("idle unmetered must not skip")
	}
}

func TestParseNMMetered(t *testing.T) {
	for _, yes := range []string{"yes", "guess-yes", "GENERAL.METERED:yes", "GENERAL.METERED:guess-yes"} {
		if !parseNMMetered(yes) {
			t.Errorf("%q should be metered", yes)
		}
	}
	for _, no := range []string{"no", "unknown", "guess-no", "GENERAL.METERED:no", ""} {
		if parseNMMetered(no) {
			t.Errorf("%q should not be metered", no)
		}
	}
}

func TestPrefetchOnceWarmsChildListingAndFirstChunk(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "next")
	if err := os.Mkdir(child, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(child, "inside.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	small := filepath.Join(root, "note.bin")
	payload := bytesOf(300)
	if err := os.WriteFile(small, payload, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := prefetchOnce(root); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(child)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("child listing len=%d", len(entries))
	}
}

func bytesOf(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i)
	}
	return b
}

func TestPrefetchSystemdUnitRunsDrivePrefetchNotRclone(t *testing.T) {
	unit := prefetchSystemdUnit("/usr/local/bin/drive", "/home/test")
	for _, want := range []string{
		"ExecStart=/usr/local/bin/drive prefetch --home /home/test",
		"After=" + SystemdUnitName,
		"BindsTo=" + SystemdUnitName,
		"Nice=19",
		"IOSchedulingClass=idle",
		"WantedBy=" + SystemdUnitName,
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("prefetch unit missing %q:\n%s", want, unit)
		}
	}
	if strings.Contains(unit, "rclone") {
		t.Errorf("prefetch unit must not start rclone (the mount unit already does):\n%s", unit)
	}
}

func TestPrefetchLaunchdPlistRunsDrivePrefetch(t *testing.T) {
	plist := prefetchLaunchdPlist("/opt/homebrew/bin/drive", "/Users/test")
	for _, want := range []string{
		"<string>" + PrefetchLaunchdLabel + "</string>",
		"<string>/opt/homebrew/bin/drive</string>",
		"<string>prefetch</string>",
		"<string>--home</string>",
		"<string>/Users/test</string>",
		"<string>Background</string>",
	} {
		if !strings.Contains(plist, want) {
			t.Errorf("prefetch plist missing %q:\n%s", want, plist)
		}
	}
}

func TestPrefetchDisabledByEnv(t *testing.T) {
	t.Setenv("DRIVE_PREFETCH", "0")
	if prefetchEnabled() {
		t.Fatal("DRIVE_PREFETCH=0 must disable prefetch")
	}
}

func TestPrefetchOnceYieldsWhenUserBusy(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "child"), 0o755); err != nil {
		t.Fatal(err)
	}
	prefetchUserBusy.Store(true)
	t.Cleanup(func() { prefetchUserBusy.Store(false) })
	if err := prefetchOnce(dir); err != nil {
		t.Fatal(err)
	}
}

func TestThrottlePrefetchSleepsForShare(t *testing.T) {
	start := time.Now()
	throttlePrefetch(prefetchShareBPS, start)
	if time.Since(start) < 900*time.Millisecond {
		t.Fatalf("throttle of 1s of share returned in %s", time.Since(start))
	}
}
