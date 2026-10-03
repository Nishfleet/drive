package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOfflineRelative(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		in, want, err string
	}{
		{"Photos", "Photos", ""},
		{"/Photos/", "Photos", ""},
		{`Photos\2024`, "Photos/2024", ""},
		{"  Photos  ", "Photos", ""},
		{"", "", "no path given"},
		{"/", "", "names the drive root"},
		{"..", "", "walks out of the drive"},
		{"../elsewhere", "", "walks out of the drive"},
	} {
		got, err := OfflineRelative(tc.in)
		if tc.err != "" {
			if err == nil || !strings.Contains(err.Error(), tc.err) {
				t.Errorf("OfflineRelative(%q) err = %v, want %q", tc.in, err, tc.err)
			}
			continue
		}
		if err != nil {
			t.Errorf("OfflineRelative(%q): %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("OfflineRelative(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestOfflineIndexAddRemove(t *testing.T) {
	t.Parallel()
	var idx OfflineIndex
	if !idx.Empty() {
		t.Fatal("a new index is not empty")
	}
	if !idx.Add("Photos") {
		t.Fatal("first Add reported a duplicate")
	}
	if idx.Add("Photos") {
		t.Fatal("second Add of the same path did not report a duplicate")
	}
	if !idx.Has("Photos") || idx.Empty() {
		t.Fatal("Has/Empty after Add")
	}
	if !idx.Remove("Photos") {
		t.Fatal("Remove missed a path that was there")
	}
	if idx.Remove("Photos") {
		t.Fatal("Remove of a missing path reported a change")
	}
}

func TestLoadSaveOfflineRoundTrip(t *testing.T) {
	home := t.TempDir()
	if idx, err := LoadOffline(home); err != nil || !idx.Empty() {
		t.Fatalf("missing file: idx=%+v err=%v", idx, err)
	}
	want := OfflineIndex{Paths: []string{"Photos", "notes.txt"}}
	if err := SaveOffline(home, want); err != nil {
		t.Fatal(err)
	}
	got, err := LoadOffline(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Paths) != 2 || got.Paths[0] != "Photos" || got.Paths[1] != "notes.txt" {
		t.Fatalf("round trip = %+v, want %+v", got, want)
	}
	if err := os.WriteFile(OfflineIndexPath(home), []byte("not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOffline(home); err == nil {
		t.Fatal("a file this product cannot parse returned no error")
	}
}

func TestUniqueOfflineCountsNestedOnce(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "Photos", "2024")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.jpg"), []byte("aaaa"), 0o644); err != nil {
		t.Fatal(err)
	}
	files, bytes, err := UniqueOffline(root, []string{"Photos", "Photos/2024"})
	if err != nil {
		t.Fatal(err)
	}
	if files != 1 || bytes != 4 {
		t.Fatalf("unique = %d files %d bytes, want 1 file 4 bytes", files, bytes)
	}
	usage, err := MeasureOffline(root, []string{"Photos", "Photos/2024"})
	if err != nil {
		t.Fatal(err)
	}
	_, summed := TotalOffline(usage)
	if summed != 8 {
		t.Fatalf("per-path sum = %d, want 8 (each line still names its own tree)", summed)
	}
}

func TestOverOfflineCap(t *testing.T) {
	t.Parallel()
	if overOfflineCap(1, 0) {
		t.Fatal("a zero cap is rclone's unlimited, not a refusal")
	}
	if !overOfflineCap(21<<30, 20<<30) {
		t.Fatal("21 GiB does not fit in a 20 GiB cache")
	}
	if overOfflineCap(20<<30, 20<<30) {
		t.Fatal("a set that equals the cap fits")
	}
	err := offlineCapError(21<<30, 20<<30)
	if err == nil || !strings.Contains(err.Error(), "cache limit") || strings.Contains(err.Error(), "drive cache --max") {
		t.Fatalf("cap error = %v", err)
	}
}

func TestDriveOfflineAndOnline(t *testing.T) {
	home := t.TempDir()
	mount := DefaultMountDir(home)
	keep := filepath.Join(mount, "keep")
	if err := os.MkdirAll(filepath.Join(keep, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(keep, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(keep, "nested", "more.txt"), []byte("more"), 0o644); err != nil {
		t.Fatal(err)
	}

	var err error
	out := captureStdout(t, func() {
		err = runOffline([]string{"--home", home, "keep"})
	})
	if err != nil {
		t.Fatalf("drive offline: %v\n%s", err, out)
	}
	if !strings.Contains(out, "kept offline: keep") {
		t.Errorf("offline output missing the path: %q", out)
	}
	idx, err := LoadOffline(home)
	if err != nil {
		t.Fatal(err)
	}
	if !idx.Has("keep") {
		t.Fatalf("index = %+v, want keep", idx)
	}

	out = captureStdout(t, func() {
		err = runOffline([]string{"--home", home, "--list"})
	})
	if err != nil {
		t.Fatalf("drive offline --list: %v\n%s", err, out)
	}
	if !strings.Contains(out, "keep") || !strings.Contains(out, "cache limit") {
		t.Errorf("--list = %q", out)
	}

	out = captureStdout(t, func() {
		err = runOnline([]string{"--home", home, "keep"})
	})
	if err != nil {
		t.Fatalf("drive online: %v\n%s", err, out)
	}
	if !strings.Contains(out, "online again: keep") {
		t.Errorf("online output = %q", out)
	}
	idx, err = LoadOffline(home)
	if err != nil {
		t.Fatal(err)
	}
	if !idx.Empty() {
		t.Fatalf("index after online = %+v", idx)
	}
}
