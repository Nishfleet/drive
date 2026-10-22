package main

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestConflictNamePutsTheDeviceBeforeTheExtension(t *testing.T) {
	for _, tc := range []struct {
		path   string
		device string
		want   string
	}{
		{"report.txt", "mac", "report (conflict, mac).txt"},
		{"notes", "studio-1", "notes (conflict, studio-1)"},
		{"photos/img.JPEG", "Mac", "photos/img (conflict, Mac).JPEG"},
		{"archive.tar.gz", "mac", "archive.tar (conflict, mac).gz"},
		{".env", "mac", ".env (conflict, mac)"},
		{"trailing.", "mac", "trailing. (conflict, mac)"},
	} {
		if got := ConflictName(tc.path, tc.device); got != tc.want {
			t.Errorf("ConflictName(%q, %q) = %q, want %q", tc.path, tc.device, got, tc.want)
		}
	}
}

func TestConflictNameKeepsTheFolder(t *testing.T) {
	got := ConflictName("a/b/c/report.txt", "mac")
	if got != "a/b/c/report (conflict, mac).txt" {
		t.Fatalf("ConflictName moved the folder: %q", got)
	}
	if strings.Contains(SanitizeDevice("a/b"), "/") {
		t.Fatal("SanitizeDevice left a path separator in a device name")
	}
}

func TestSanitizeDevice(t *testing.T) {
	for _, tc := range []struct {
		in, want string
	}{
		{"mac", "mac"},
		{"Mac Studio", "Mac-Studio"},
		{"John's Mac:Book", "John-s-Mac-Book"},
		{"..", ""},
		{"---", ""},
		{"", ""},
		{"a/b*c?d", "a-b-c-d"},
	} {
		if got := SanitizeDevice(tc.in); got != tc.want {
			t.Errorf("SanitizeDevice(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if got := SanitizeDevice(strings.Repeat("a", 500)); len(got) > maxDeviceNameLen {
		t.Errorf("SanitizeDevice kept %d characters", len(got))
	}
}

func TestDefaultDeviceNameIsNeverEmpty(t *testing.T) {
	if name := DefaultDeviceName(); name == "" {
		t.Fatal("DefaultDeviceName returned an empty name")
	}
}

func TestConflictDeviceFromName(t *testing.T) {
	for _, name := range []string{
		"report (conflict, mac).txt",
		"report (conflict, Mac Studio).txt",
		"dir/report (conflict, mac).txt",
	} {
		if _, ok := ConflictDeviceFromName(name); !ok {
			t.Errorf("ConflictDeviceFromName(%q) did not recognise its own name", name)
		}
	}
	for _, name := range []string{
		"report.txt",
		"report (conflict, ).txt",
		"conflict, mac.txt",
		"",
	} {
		if _, ok := ConflictDeviceFromName(name); ok {
			t.Errorf("ConflictDeviceFromName(%q) accepted a name it did not produce", name)
		}
	}
}

type fakeConflictBackend struct {
	pending       []queueEntry
	objects       map[string]string
	copied        []string
	listCalls     int
	hashCalls     int
	pollCounts    map[string]int
	refreshed     int
	failWith      error
	clobber       bool
	clobbered     bool
	alwaysClobber bool
	hashErr       map[string]error
	listErr       error
	versions      map[string]objectVersion
	down          error
	refreshErr    error
}

type objectVersion struct {
	size    int64
	modTime time.Time
}

func newFakeBackend() *fakeConflictBackend {
	return &fakeConflictBackend{
		objects:    map[string]string{},
		pollCounts: map[string]int{},
		hashErr:    map[string]error{},
		versions:   map[string]objectVersion{},
	}
}

func (f *fakeConflictBackend) remoteVersion(_ context.Context, name string) (int64, time.Time, bool, error) {
	if f.failWith != nil {
		return 0, time.Time{}, false, f.failWith
	}
	if _, ok := f.objects[name]; !ok {
		return 0, time.Time{}, false, nil
	}
	v := f.versions[name]
	return v.size, v.modTime, true, nil
}

func (f *fakeConflictBackend) landAs(t *testing.T, name, etag, p string) {
	t.Helper()
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	f.objects[name] = etag
	f.versions[name] = objectVersion{size: info.Size(), modTime: info.ModTime()}
}

func (f *fakeConflictBackend) queue(context.Context) ([]queueEntry, error) {
	return f.pending, f.failWith
}

func (f *fakeConflictBackend) remoteHas(_ context.Context, name string) (bool, error) {
	if f.failWith != nil {
		return false, f.failWith
	}
	_, ok := f.objects[name]
	return ok, nil
}

func (f *fakeConflictBackend) remoteHash(_ context.Context, name string) (string, error) {
	if f.failWith != nil {
		return "", f.failWith
	}
	if err := f.hashErr[name]; err != nil {
		return "", err
	}
	f.hashCalls++
	f.pollCounts[name]++
	return f.objects[name], nil
}

func (f *fakeConflictBackend) parentContents(_ context.Context, dir string) (map[string]bool, error) {
	if f.failWith != nil {
		return nil, f.failWith
	}
	if f.listErr != nil {
		return nil, f.listErr
	}
	f.listCalls++
	present := map[string]bool{}
	for name := range f.objects {
		if parentDir(name) == dir {
			present[remoteBase(name)] = true
		}
	}
	return present, nil
}

func (f *fakeConflictBackend) copyLocalToRemote(_ context.Context, srcRoot, srcRemote, dstRemote string) error {
	if f.failWith != nil {
		return f.failWith
	}
	if f.clobber && (f.alwaysClobber || !f.clobbered) {
		f.clobbered = true
		f.objects[dstRemote] = "another-mounts-save"
		f.copied = append(f.copied, dstRemote)
		return nil
	}
	sum, err := hashFile(filepath.Join(srcRoot, filepath.FromSlash(srcRemote)))
	if err != nil {
		return fmt.Errorf("read the source of %s: %w", srcRemote, err)
	}
	f.objects[dstRemote] = sum
	f.copied = append(f.copied, dstRemote)
	return nil
}

func hashFile(p string) (string, error) {
	src, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer src.Close()
	sum := md5.New()
	if _, err := io.Copy(sum, src); err != nil {
		return "", err
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

func (f *fakeConflictBackend) refresh(_ context.Context, _ bool) error {
	if f.refreshErr != nil {
		return f.refreshErr
	}
	f.refreshed++
	return nil
}

func (f *fakeConflictBackend) reachable(_ context.Context) error { return f.down }

func guardFor(t *testing.T, device string, files map[string]string) (*conflictGuard, string, *fakeConflictBackend) {
	t.Helper()
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	for name, body := range files {
		p := filepath.Join(mountDir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	g := newConflictGuard(device, mountDir)
	f := newFakeBackend()
	return g, mountDir, f
}

func TestConflictGuardKeepsTheLosersVersion(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "A-is-this-machines-save\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 22}}
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	if res.Watched != 1 {
		t.Errorf("Watched = %d, want 1", res.Watched)
	}
	if len(f.copied) != 0 {
		t.Fatalf("copied %v while the save was still in flight", f.copied)
	}
	if len(res.Claimed) != 0 {
		t.Error("claimed a conflict before the save landed", res.Claimed[0].Remote)
	}

	f.pending = nil
	f.objects["report.txt"] = md5Hex("B-is-the-other-machines-save\n")
	res, err = g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass after the other device landed: %v", err)
	}
	want := "report (conflict, mac).txt"
	if len(f.copied) != 1 || f.copied[0] != want {
		t.Fatalf("copied %v, want [%s]", f.copied, want)
	}
	if got := f.objects[want]; got != md5Hex("A-is-this-machines-save\n") {
		t.Errorf("the conflict copy holds %q, want this device's own bytes", got)
	}
	if f.refreshed == 0 {
		t.Error("the pass did not refresh the directory cache, so a listing would not see the copy")
	}
	if len(g.seen) != 0 {
		t.Errorf("the guard still watches %v", g.seen)
	}
	if len(res.Claimed) != 1 || res.Claimed[0].Remote != want || res.Claimed[0].LosingPath != "report.txt" {
		t.Errorf("Claimed = %+v, want the one conflict copy", res.Claimed)
	}
}

func TestConflictGuardSkipsTheRefreshWhenStorageIsDown(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "A-is-this-machines-save\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 22}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	f.pending = nil
	f.objects["report.txt"] = md5Hex("B-is-the-other-machines-save\n")
	f.down = errors.New("connection refused")
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass after the claim with storage down: %v", err)
	}
	want := "report (conflict, mac).txt"
	if len(f.copied) != 1 || f.copied[0] != want {
		t.Fatalf("copied %v, want [%s]: a dead backend must still get its conflict copy", f.copied, want)
	}
	if f.refreshed != 0 {
		t.Errorf("the pass refreshed the directory cache while storage was down: rclone forces it stale before it re-lists, so every kept-offline open would fail until the cache expired (issue #541)")
	}
	if len(res.Claimed) != 1 {
		t.Errorf("Claimed = %+v, want the one conflict copy", res.Claimed)
	}
}

func TestConflictGuardNamesTheRefreshFailureAfterAClaim(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "A-is-this-machines-save\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 22}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	f.pending = nil
	f.objects["report.txt"] = md5Hex("B-is-the-other-machines-save\n")
	f.refreshErr = errors.New("connection reset by peer")
	res, err := g.pass(context.Background(), f)
	if err == nil || !strings.Contains(err.Error(), "refresh after claiming") {
		t.Fatalf("pass with a failing refresh: %v", err)
	}
	if !strings.Contains(err.Error(), "connection reset by peer") {
		t.Errorf("the error does not carry the backend's own message: %v", err)
	}
	want := "report (conflict, mac).txt"
	if len(f.copied) != 1 || f.copied[0] != want {
		t.Errorf("copied %v, want [%s]: the copy still lands, only the refresh failed", f.copied, want)
	}
	if len(res.Claimed) != 1 {
		t.Errorf("Claimed = %+v, want the one conflict copy that must be retried on the next pass", res.Claimed)
	}
}

func TestConflictGuardSkipsTheRemoteHashForAPathThatNeverExisted(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{
		"new.txt": "brand new\n",
		"old.txt": "been there all along\n",
	})
	f.objects["old.txt"] = "the-old-version"
	f.pending = []queueEntry{{Name: "new.txt", Size: 10}, {Name: "old.txt", Size: 21}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass: %v", err)
	}
	if f.listCalls != 1 {
		t.Errorf("the folder was listed %d times, want once for both saves", f.listCalls)
	}
	if f.hashCalls != 1 {
		t.Errorf("%d remote hashes were read, want 1 (old.txt only): a path that never existed has no hash to read", f.hashCalls)
	}
	f.pending = nil
	f.objects["new.txt"] = md5Hex("the other device's save\n")
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass after the other device landed: %v", err)
	}
	want := "new (conflict, mac).txt"
	if len(f.copied) != 1 || f.copied[0] != want {
		t.Fatalf("copied %v, want [%s]", f.copied, want)
	}
	if got := f.objects[want]; got != md5Hex("brand new\n") {
		t.Errorf("the conflict copy holds %q, want this device's own bytes", got)
	}
}

func TestConflictGuardFallsBackToAHashWhenTheListingFails(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"new.txt": "brand new\n"})
	f.listErr = errors.New("directory not found")
	f.pending = []queueEntry{{Name: "new.txt", Size: 10}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("a listing that fails is not a failed pass: %v", err)
	}
	if g.seen["new.txt"] == nil {
		t.Fatal("the save was not watched")
	}
	if g.seen["new.txt"].previous != "" {
		t.Errorf("previous = %q, want empty: the hashsum said the path never existed", g.seen["new.txt"].previous)
	}
	f.listErr = nil
	f.pending = nil
	f.objects["new.txt"] = md5Hex("the other device's save\n")
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	if len(f.copied) != 1 {
		t.Fatalf("copied %v, want the conflict copy after a listing that failed at first sight", f.copied)
	}
}

func TestConflictGuardSightsABoundedNumberOfSavesPerPass(t *testing.T) {
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	if err := os.MkdirAll(mountDir, 0o700); err != nil {
		t.Fatal(err)
	}
	const total = 2 * conflictSightMax
	f := newFakeBackend()
	f.pending = make([]queueEntry, 0, total)
	for i := 0; i < total; i++ {
		name := fmt.Sprintf("save-%03d.txt", i)
		if err := os.WriteFile(filepath.Join(mountDir, name), []byte("a save\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		f.pending = append(f.pending, queueEntry{Name: name, Size: 7})
	}
	g := newConflictGuard("mac", mountDir)
	first, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if len(g.seen) != conflictSightMax {
		t.Errorf("the first pass sighted %d saves, want the bound %d", len(g.seen), conflictSightMax)
	}
	if first.Behind != total-conflictSightMax {
		t.Errorf("Behind = %d, want %d: the rest of the drop is the backlog", first.Behind, total-conflictSightMax)
	}
	if first.Watched != total {
		t.Errorf("Watched = %d, want %d", first.Watched, total)
	}
	second, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("second pass: %v", err)
	}
	if len(g.seen) != total {
		t.Errorf("the second pass left %d saves unseen", total-len(g.seen))
	}
	if second.Behind != 0 {
		t.Errorf("Behind = %d after the queue was sighted, want 0", second.Behind)
	}
}

func TestConflictGuardPollsABoundedNumberAndResumes(t *testing.T) {
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	if err := os.MkdirAll(mountDir, 0o700); err != nil {
		t.Fatal(err)
	}
	const total = 150
	f := newFakeBackend()
	f.pending = make([]queueEntry, 0, total)
	for i := 0; i < total; i++ {
		name := fmt.Sprintf("save-%03d.txt", i)
		if err := os.WriteFile(filepath.Join(mountDir, name), []byte("a save\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		f.pending = append(f.pending, queueEntry{Name: name, Size: 7})
	}
	g := newConflictGuard("mac", mountDir)
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("sighting pass: %v", err)
	}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("sighting pass: %v", err)
	}
	if len(g.seen) != total {
		t.Fatalf("only %d of %d saves sighted", len(g.seen), total)
	}
	f.pending = nil
	for i := 0; i < total; i++ {
		f.objects[fmt.Sprintf("save-%03d.txt", i)] = md5Hex("a save\n")
	}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("polling pass: %v", err)
	}
	if f.hashCalls != conflictPollMax {
		t.Fatalf("the pass polled %d paths, want the bound %d", f.hashCalls, conflictPollMax)
	}
	for i, name := range g.order {
		want := 1
		if i >= conflictPollMax {
			want = 0
		}
		if got := f.pollCounts[name]; got != want {
			t.Fatalf("save %d was polled %d times after one pass, want %d", i, got, want)
		}
	}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("second polling pass: %v", err)
	}
	if f.hashCalls != 2*conflictPollMax {
		t.Fatalf("two passes polled %d paths, want %d", f.hashCalls, 2*conflictPollMax)
	}
	for i, name := range g.order {
		save := g.seen[name]
		if save == nil {
			t.Fatalf("%s dropped early", name)
		}
		if save.winPolls != f.pollCounts[name] {
			t.Fatalf("save %d: %d win polls against %d remote hashes", i, save.winPolls, f.pollCounts[name])
		}
		if i >= conflictPollMax && f.pollCounts[name] != 1 {
			t.Fatalf("save %d in the tail was polled %d times, want 1: the second pass resumed past the head instead of repeating it", i, f.pollCounts[name])
		}
	}
}

func TestRetireFinishedKeepsTheCursorOnTheNextSurvivingName(t *testing.T) {
	kept, cursor := retireFinished([]string{"a", "b", "c", "d"}, []string{"b"}, 1)
	if strings.Join(kept, ",") != "a,c,d" {
		t.Fatalf("kept = %v, want a,c,d", kept)
	}
	if cursor != 1 || kept[cursor] != "c" {
		t.Fatalf("cursor = %d (%q), want c", cursor, kept[cursor])
	}
	kept, cursor = retireFinished([]string{"a", "b", "c"}, []string{"a", "b"}, 0)
	if strings.Join(kept, ",") != "c" || cursor != 0 {
		t.Fatalf("kept=%v cursor=%d, want c at 0", kept, cursor)
	}
}

func TestConflictGuardRefreshesALargeFingerprintOnRewrite(t *testing.T) {
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	if err := os.MkdirAll(mountDir, 0o700); err != nil {
		t.Fatal(err)
	}
	big := filepath.Join(mountDir, "movie.mov")
	if err := os.WriteFile(big, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(big, conflictProtectMax+1); err != nil {
		t.Fatal(err)
	}
	f := newFakeBackend()
	g := newConflictGuard("mac", mountDir)
	f.pending = []queueEntry{{Name: "movie.mov", Size: conflictProtectMax + 1}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	first := g.seen["movie.mov"].stat
	if err := os.Truncate(big, conflictProtectMax+2); err != nil {
		t.Fatal(err)
	}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	save := g.seen["movie.mov"]
	if save.stat.size != conflictProtectMax+2 {
		t.Fatalf("fingerprint size = %d, want the rewritten size", save.stat.size)
	}
	if save.stat.size == first.size && save.stat.modTime.Equal(first.modTime) {
		t.Fatal("the rewritten large save kept its first fingerprint")
	}
	f.pending = nil
	f.landAs(t, "movie.mov", "etag-of-rewrite", big)
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Skipped) != 0 {
		t.Errorf("Skipped = %+v, want none for this device's own rewritten large upload", res.Skipped)
	}
}

func TestConflictGuardNamesWhenClaimSourceChanged(t *testing.T) {
	g, mountDir, f := guardFor(t, "mac", map[string]string{"report.txt": "this-machines-save\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 20}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mountDir, "report.txt"), []byte("changed under the mount\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.clobber = true
	_, err := g.claim(context.Background(), f, "report.txt", g.seen["report.txt"])
	if !errors.Is(err, errClaimSourceChanged) {
		t.Fatalf("claim = %v, want the named skip for a source that changed", err)
	}
}

func TestConflictGuardFinishesATenThousandEntryQueueAcrossPasses(t *testing.T) {
	const total = 10000
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	drop := filepath.Join(mountDir, "drop")
	if err := os.MkdirAll(drop, 0o700); err != nil {
		t.Fatal(err)
	}
	body := "a small save from this device\n"
	name := func(i int) string { return fmt.Sprintf("drop/save-%04d.txt", i) }
	f := newFakeBackend()
	f.pending = make([]queueEntry, 0, total)
	for i := 0; i < total; i++ {
		if err := os.WriteFile(filepath.Join(mountDir, filepath.FromSlash(name(i))), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		f.pending = append(f.pending, queueEntry{Name: name(i), Size: int64(len(body))})
	}
	g := newConflictGuard("mac", mountDir)
	passes := 0
	first, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("first pass: %v", err)
	}
	passes++
	if first.Behind != total-conflictSightMax {
		t.Fatalf("Behind after the first pass = %d, want %d", first.Behind, total-conflictSightMax)
	}
	for len(g.seen) < total {
		if _, err := g.pass(context.Background(), f); err != nil {
			t.Fatalf("pass %d: %v", passes, err)
		}
		passes++
		if passes > 200 {
			t.Fatalf("sighting did not finish the queue: %d of %d seen after 200 passes", len(g.seen), total)
		}
	}
	if first.Watched != total {
		t.Errorf("Watched = %d, want %d", first.Watched, total)
	}

	const wave = 300
	for i := 0; i < wave; i++ {
		f.objects[name(i)] = md5Hex(body)
	}
	f.pending = f.pending[wave:]
	for range wave*conflictWinPolls/conflictPollMax + 20 {
		if _, err := g.pass(context.Background(), f); err != nil {
			t.Fatalf("pass %d in the win wave: %v", passes, err)
		}
		passes++
	}
	if len(g.seen) != total-wave {
		t.Fatalf("the win wave left %d saves watched, want %d", len(g.seen), total-wave)
	}

	for i := wave; i < total; i++ {
		if err := os.Remove(filepath.Join(mountDir, filepath.FromSlash(name(i)))); err != nil {
			t.Fatal(err)
		}
		f.objects[name(i)] = md5Hex("the other device's save\n")
	}
	f.pending = nil
	skips := 0
	for len(g.seen) > 0 {
		res, err := g.pass(context.Background(), f)
		if err != nil {
			t.Fatalf("pass %d in the drain: %v", passes, err)
		}
		skips += len(res.Skipped)
		passes++
		if passes > 1000 {
			t.Fatalf("the drain did not finish: %d saves still watched", len(g.seen))
		}
	}
	if skips != total-wave {
		t.Errorf("%d skips were named, want %d: every lost save is a named one", skips, total-wave)
	}
	if len(g.order) != 0 {
		t.Errorf("the watch list still holds %d entries", len(g.order))
	}
	t.Logf("%d passes for the whole queue", passes)
}

func TestConflictGuardWritesNoSecondCopyOfAnySave(t *testing.T) {
	const conflictGuardSideBudget = 4096
	const total = 150
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	drop := filepath.Join(mountDir, "drop")
	if err := os.MkdirAll(drop, 0o700); err != nil {
		t.Fatal(err)
	}
	body := strings.Repeat("a reasonably sized save\n", 170)
	name := func(i int) string { return fmt.Sprintf("drop/save-%03d.txt", i) }
	f := newFakeBackend()
	f.pending = make([]queueEntry, 0, total)
	for i := 0; i < total; i++ {
		if err := os.WriteFile(filepath.Join(mountDir, filepath.FromSlash(name(i))), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		f.pending = append(f.pending, queueEntry{Name: name(i), Size: int64(len(body))})
	}
	g := newConflictGuard("mac", mountDir)
	for range 4 {
		if _, err := g.pass(context.Background(), f); err != nil {
			t.Fatalf("sighting pass: %v", err)
		}
	}
	if len(g.seen) != total {
		t.Fatalf("only %d of %d saves sighted", len(g.seen), total)
	}
	f.pending = nil
	for i := 0; i < total; i++ {
		if i < 10 {
			f.objects[name(i)] = md5Hex("the other device's save\n")
		} else {
			f.objects[name(i)] = md5Hex(body)
		}
	}
	for range total*conflictWinPolls/conflictPollMax + 20 {
		if _, err := g.pass(context.Background(), f); err != nil {
			t.Fatalf("deciding pass: %v", err)
		}
	}
	if len(g.seen) != 0 {
		t.Fatalf("%d saves still watched", len(g.seen))
	}
	if len(f.copied) != 10 {
		t.Errorf("copied %v, want the ten conflict copies", f.copied)
	}
	var side int64
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() && !strings.HasPrefix(p, mountDir+string(filepath.Separator)) {
			side += info.Size()
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if side > conflictGuardSideBudget {
		t.Errorf("the guard left %d bytes beside the mount, over the %d-byte budget", side, conflictGuardSideBudget)
	}
	if side != 0 {
		t.Errorf("the guard left %d bytes beside the mount, want 0: the bytes are hashed where they are", side)
	}
}

func TestConflictGuardNamesASkipOnce(t *testing.T) {
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	if err := os.MkdirAll(filepath.Join(mountDir, "folder"), 0o700); err != nil {
		t.Fatal(err)
	}
	f := newFakeBackend()
	g := newConflictGuard("mac", mountDir)
	f.pending = []queueEntry{{Name: "folder"}}
	first, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if len(first.Skipped) != 1 || first.Skipped[0].Remote != "folder" {
		t.Fatalf("Skipped = %+v, want folder", first.Skipped)
	}
	second, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("second pass: %v", err)
	}
	if len(second.Skipped) != 0 {
		t.Errorf("named the same skip again: %+v", second.Skipped)
	}
	if len(f.copied) != 0 {
		t.Errorf("wrote %v for a save it had skipped", f.copied)
	}
	f.pending = nil
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass: %v", err)
	}
	if len(g.seen) != 0 {
		t.Errorf("still watches %v", g.seen)
	}
}

func TestConflictGuardRetriesANameAnotherMountTook(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "this-machines-save\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 20}}
	f.clobber = true
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	f.pending = nil
	f.objects["report.txt"] = "the-other-machines-save"
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass after the other device landed: %v", err)
	}
	want := "report (conflict, mac 2).txt"
	if len(res.Claimed) != 1 || res.Claimed[0].Remote != want {
		t.Fatalf("Claimed = %+v, want %s", res.Claimed, want)
	}
	if got := f.objects[want]; got != md5Hex("this-machines-save\n") {
		t.Errorf("%s holds %q, want this device's own bytes", want, got)
	}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass: %v", err)
	}
}

func TestConflictGuardGivesUpWhenEveryNameIsTaken(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "this-machines-save\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 20}}
	f.clobber = true
	f.alwaysClobber = true
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	f.pending = nil
	f.objects["report.txt"] = "the-other-machines-save"
	_, err := g.pass(context.Background(), f)
	if err == nil {
		t.Fatal("claimed a conflict name that holds another writer's bytes")
	}
	if !strings.Contains(err.Error(), "another writer") {
		t.Errorf("the error did not name the race: %v", err)
	}
}

func TestConflictGuardLeavesAWinningSaveAlone(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "the winning save\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 17}}
	f.objects["report.txt"] = "older-version"
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	f.pending = nil
	f.objects["report.txt"] = md5Hex("the winning save\n")
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass after the save landed: %v", err)
	}
	if len(f.copied) != 0 {
		t.Errorf("wrote %v for a save that won", f.copied)
	}
	if len(g.seen) != 1 {
		t.Fatalf("the guard watches %v, wants the path held until the win window ends", g.seen)
	}
	for range conflictWinPolls {
		if _, err := g.pass(context.Background(), f); err != nil {
			t.Fatalf("pass during the win window: %v", err)
		}
	}
	if len(f.copied) != 0 {
		t.Errorf("wrote %v for a save that won", f.copied)
	}
	if len(g.seen) != 0 {
		t.Errorf("still watches %v after the win window ended", g.seen)
	}
}

func TestConflictGuardKeepsASaveThatLandsSecondsLater(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "A-this-device-saved-first\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 26}}
	f.objects["report.txt"] = "nothing-here-yet"
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	f.pending = nil
	f.objects["report.txt"] = md5Hex("A-this-device-saved-first\n")
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass after the save landed: %v", err)
	}
	f.objects["report.txt"] = md5Hex("B-the-other-device-saved-second\n")
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass after the other device's save landed: %v", err)
	}
	want := "report (conflict, mac).txt"
	if len(f.copied) != 1 || f.copied[0] != want {
		t.Fatalf("copied %v, want [%s]", f.copied, want)
	}
	if got := f.objects[want]; got != md5Hex("A-this-device-saved-first\n") {
		t.Errorf("the conflict copy holds %q, want this device's own bytes", got)
	}
	if len(res.Claimed) != 1 || res.Claimed[0].Remote != want || res.Claimed[0].LosingPath != "report.txt" {
		t.Errorf("Claimed = %+v, want the one conflict copy", res.Claimed)
	}
	if len(g.seen) != 0 {
		t.Errorf("the guard still watches %v", g.seen)
	}
}

func TestConflictGuardKeepsASaveWhoseObjectAnotherDevicesFailedUploadRemoved(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "A-this-device-saved\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 20}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	f.pending = nil
	delete(f.objects, "report.txt")
	emptyFor := 15 * time.Second
	if emptyFor <= 10*time.Second || emptyFor >= conflictWatchWindow {
		t.Fatalf("the empty phase %v must sit between the old 10s budget and the %v window", emptyFor, conflictWatchWindow)
	}
	for i := range int(emptyFor / conflictInterval) {
		if _, err := g.pass(context.Background(), f); err != nil {
			t.Fatalf("pass %d while the other upload waits to retry: %v", i, err)
		}
		if len(f.copied) != 0 {
			t.Fatalf("pass %d claimed a conflict while the plain path was empty", i)
		}
	}
	f.objects["report.txt"] = md5Hex("B-the-retried-upload\n")
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass after the retried upload landed: %v", err)
	}
	want := "report (conflict, mac).txt"
	if len(f.copied) != 1 || f.copied[0] != want {
		t.Fatalf("copied %v, want [%s]: the save was lost with no copy kept", f.copied, want)
	}
	if got := f.objects[want]; got != md5Hex("A-this-device-saved\n") {
		t.Errorf("the conflict copy holds %q, want this device's own bytes", got)
	}
}

func TestConflictGuardRehashesTheBytesTheUploadWillCarry(t *testing.T) {
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	path := filepath.Join(mountDir, "report.txt")
	if err := os.MkdirAll(mountDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("first write\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := newFakeBackend()
	g := newConflictGuard("mac", mountDir)
	f.pending = []queueEntry{{Name: "report.txt", Size: 13}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	if err := os.WriteFile(path, []byte("second write\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.pending = nil
	f.objects["report.txt"] = md5Hex("B-the-other-device-saved-second\n")
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass after the other device's save landed: %v", err)
	}
	want := "report (conflict, mac).txt"
	if got := f.objects[want]; got != md5Hex("second write\n") {
		t.Errorf("the conflict copy holds %q, want the second write", got)
	}
}

func TestConflictGuardNumbersARepeatedConflict(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "second loss\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 12}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	f.pending = nil
	f.objects["report.txt"] = "A-other-devices-save"
	f.objects["report (conflict, mac).txt"] = "A-the-first-loss"
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass after the other device landed: %v", err)
	}
	want := "report (conflict, mac 2).txt"
	if len(f.copied) != 1 || f.copied[0] != want {
		t.Fatalf("copied %v, want [%s]", f.copied, want)
	}
	if got := f.objects["report (conflict, mac).txt"]; got != "A-the-first-loss" {
		t.Errorf("the first conflict copy was overwritten: %s", got)
	}
	if len(res.Claimed) != 1 || res.Claimed[0].Remote != want {
		t.Errorf("Claimed = %+v", res.Claimed)
	}
}

func TestConflictGuardKeepsAFolderInTheConflictName(t *testing.T) {
	g, _, f := guardFor(t, "studio-1", map[string]string{"photos/img.JPEG": "the losing save"})
	f.pending = []queueEntry{{Name: "photos/img.JPEG", Size: 15}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	f.pending = nil
	f.objects["photos/img.JPEG"] = "the winning save"
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass after the other device landed: %v", err)
	}
	want := "photos/img (conflict, studio-1).JPEG"
	if len(f.copied) != 1 || f.copied[0] != want {
		t.Fatalf("copied %v, want [%s]", f.copied, want)
	}
}

func TestConflictGuardWaitsForASaveThatHasNotLandedYet(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "this device's save\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 20}}
	f.objects["report.txt"] = "the-version-before"
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	f.pending = nil
	for i := 0; i < conflictClaimPolls-1; i++ {
		if _, err := g.pass(context.Background(), f); err != nil {
			t.Fatalf("pass %d: %v", i, err)
		}
		if len(f.copied) != 0 {
			t.Fatalf("pass %d claimed a conflict while the object was unchanged", i)
		}
	}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass: %v", err)
	}
	if len(g.seen) != 0 {
		t.Errorf("still watches %v", g.seen)
	}
	if len(f.copied) != 0 {
		t.Errorf("wrote %v for a save that never landed", f.copied)
	}
}

func TestConflictGuardComparesALargeFileByFingerprint(t *testing.T) {
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	if err := os.MkdirAll(mountDir, 0o700); err != nil {
		t.Fatal(err)
	}
	big := filepath.Join(mountDir, "movie.mov")
	if err := os.WriteFile(big, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(big, conflictProtectMax+1); err != nil {
		t.Fatal(err)
	}
	f := newFakeBackend()
	g := newConflictGuard("mac", mountDir)
	f.pending = []queueEntry{{Name: "movie.mov", Size: conflictProtectMax + 1}}
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if len(res.Skipped) != 0 {
		t.Errorf("Skipped = %+v, want the large save watched not skipped", res.Skipped)
	}
	if g.seen["movie.mov"] == nil || !g.seen["movie.mov"].byFingerprint {
		t.Fatal("the large save is not watched by fingerprint")
	}
	f.pending = nil
	f.landAs(t, "movie.mov", "this-device-etag", big)
	res, err = g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if len(res.Skipped) != 0 {
		t.Errorf("Skipped = %+v, want no skip when this device's large upload lands", res.Skipped)
	}
}

func TestConflictGuardOwnLargeUploadIsNotASkip(t *testing.T) {
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	if err := os.MkdirAll(mountDir, 0o700); err != nil {
		t.Fatal(err)
	}
	big := filepath.Join(mountDir, "movie.mov")
	if err := os.WriteFile(big, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(big, conflictProtectMax+1); err != nil {
		t.Fatal(err)
	}
	f := newFakeBackend()
	g := newConflictGuard("mac", mountDir)
	f.pending = []queueEntry{{Name: "movie.mov", Size: conflictProtectMax + 1}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	f.pending = nil
	f.landAs(t, "movie.mov", "etag-of-this-upload", big)
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Skipped) != 0 {
		t.Errorf("Skipped = %+v, want none for this device's own large upload", res.Skipped)
	}
	if len(f.copied) != 0 {
		t.Errorf("claimed a conflict copy of a file too large to copy: %v", f.copied)
	}
}

func TestConflictGuardNamesALargeOverwrite(t *testing.T) {
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	if err := os.MkdirAll(mountDir, 0o700); err != nil {
		t.Fatal(err)
	}
	big := filepath.Join(mountDir, "movie.mov")
	if err := os.WriteFile(big, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(big, conflictProtectMax+1); err != nil {
		t.Fatal(err)
	}
	f := newFakeBackend()
	g := newConflictGuard("mac", mountDir)
	f.pending = []queueEntry{{Name: "movie.mov", Size: conflictProtectMax + 1}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	f.pending = nil
	f.objects["movie.mov"] = "etag:other-device"
	f.versions["movie.mov"] = objectVersion{size: conflictProtectMax + 2, modTime: time.Now().Add(time.Minute)}
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Skipped) != 1 || res.Skipped[0].Remote != "movie.mov" {
		t.Errorf("Skipped = %+v, want the overwritten large save named", res.Skipped)
	}
	if len(g.seen) != 0 {
		t.Errorf("still watches %v", g.seen)
	}
}

func TestConflictGuardReportsAFailingPass(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "a save\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 7}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	if len(g.seen) != 1 {
		t.Fatalf("the hashed save is not watched: %v", g.seen)
	}
	f.failWith = errConflictTestQueue
	if _, err := g.pass(context.Background(), f); err == nil {
		t.Fatal("a failing pass reported no error")
	} else if !strings.Contains(err.Error(), "read the upload queue") {
		t.Errorf("the error did not name what failed: %v", err)
	}
	if len(g.seen) != 1 {
		t.Errorf("a failed queue read lost the hashed save: %v", g.seen)
	}
}

var errConflictTestQueue = &conflictTestError{"queue"}

func TestConflictGuardNamesAPersistentHashError(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"ok.txt": "ok\n"})
	f.pending = []queueEntry{{Name: "ok.txt", Size: 3}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	f.pending = nil
	f.hashErr["ok.txt"] = errors.New("empty md5")
	var res ConflictResult
	var err error
	for i := 0; i < conflictHashFailPolls; i++ {
		res, err = g.pass(context.Background(), f)
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(res.Skipped) != 1 || res.Skipped[0].Remote != "ok.txt" {
		t.Errorf("Skipped = %+v, want the hash error named after %d fails", res.Skipped, conflictHashFailPolls)
	}
}

func TestConflictGuardHoldsAHashErrorOnThatEntryOnly(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{
		"ok.txt":  "ok\n",
		"bad.txt": "bad\n",
	})
	f.objects["bad.txt"] = "the version already there"
	f.pending = []queueEntry{{Name: "ok.txt", Size: 3}, {Name: "bad.txt", Size: 4}}
	f.hashErr["bad.txt"] = errors.New("empty md5")
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("a hash error on one path failed the pass: %v", err)
	}
	if g.seen["ok.txt"] == nil {
		t.Fatal("the good save was not watched")
	}
	if g.seen["bad.txt"] == nil || g.seen["bad.txt"].previous != "" {
		t.Fatal("the failing hash did not hold its entry with no baseline")
	}
	if len(res.Claimed) != 0 {
		t.Errorf("claimed %v on a pass with a hash error", res.Claimed)
	}
}

func TestConflictGuardKeepsSavesMadeWhileStorageWasUnreachable(t *testing.T) {
	const name = "offline.txt"
	const bodyA = "A: the save made while the device could not reach storage\n"
	const bodyB = "B: the save made while the device could not reach storage\n"

	store := map[string]string{}
	versions := map[string]objectVersion{}
	type device struct {
		guard *conflictGuard
		back  *fakeConflictBackend
	}
	newDevice := func(deviceName, body string) device {
		g, _, f := guardFor(t, deviceName, map[string]string{name: body})
		f.objects, f.versions = store, versions
		return device{guard: g, back: f}
	}
	devices := []device{newDevice("mac", bodyA), newDevice("linux", bodyB)}
	downErr := errors.New("storage unreachable")

	for _, d := range devices {
		d.back.listErr = downErr
		d.back.hashErr[name] = downErr
		d.back.pending = []queueEntry{{Name: name, Size: int64(len(bodyA))}}
		if _, err := d.guard.pass(context.Background(), d.back); err != nil {
			t.Fatalf("pass with storage unreachable: %v", err)
		}
	}
	for _, d := range devices {
		if save := d.guard.seen[name]; save == nil || save.previous != "" {
			t.Fatalf("device %s holds the save with a baseline read while storage was unreachable: %+v", d.guard.device, d.guard.seen)
		}
	}

	store[name] = md5Hex(bodyB)
	versions[name] = objectVersion{size: int64(len(bodyB)), modTime: time.Now()}
	for _, d := range devices {
		d.back.listErr = nil
		delete(d.back.hashErr, name)
		d.back.pending = nil
	}
	for i := 0; i < conflictClaimPolls+2; i++ {
		for _, d := range devices {
			if _, err := d.guard.pass(context.Background(), d.back); err != nil {
				t.Fatalf("pass %d after the reconnect: %v", i, err)
			}
		}
	}

	if got := store[name]; got != md5Hex(bodyB) {
		t.Errorf("the plain file holds %q, want the save that landed later", got)
	}
	want := ConflictName(name, "mac")
	if got := store[want]; got != md5Hex(bodyA) {
		t.Errorf("the save made while storage was down survived nowhere: %s holds %q, want this device's bytes", want, got)
	}
	if len(devices[1].back.copied) != 0 {
		t.Errorf("the device whose save landed last kept a copy of its own: %v", devices[1].back.copied)
	}
}

func TestConflictGuardKeepsASaveWithAnUnreadBaseline(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "my save\n"})
	f.objects["report.txt"] = md5Hex("the version before the save\n")
	f.pending = []queueEntry{{Name: "report.txt", Size: 8}}
	f.hashErr["report.txt"] = errors.New("hashsum timed out")
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	if previous := g.seen["report.txt"].previous; previous != "" {
		t.Fatalf("previous = %q, want no baseline after a failed read", previous)
	}
	delete(f.hashErr, "report.txt")
	f.pending = nil
	named := 0
	for i := 0; i < conflictClaimPolls+1; i++ {
		res, err := g.pass(context.Background(), f)
		if err != nil {
			t.Fatal(err)
		}
		named += len(res.Skipped)
	}
	want := ConflictName("report.txt", "mac")
	if got := f.objects[want]; got != md5Hex("my save\n") {
		t.Errorf("%s holds %q: a save whose baseline could not be read was dropped instead of kept", want, got)
	}
	if named != 0 {
		t.Errorf("Skipped = %d, want the save kept rather than named as unprotected", named)
	}
	if len(g.seen) != 0 {
		t.Errorf("the guard still watches %v", g.seen)
	}
}

func TestConflictGuardUsesLastSyncedAsBaseline(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "newer save\n"})
	g.synced["report.txt"] = "last-synced-hash"
	f.objects["report.txt"] = "other-device-already-there"
	f.pending = []queueEntry{{Name: "report.txt", Size: 11}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	save := g.seen["report.txt"]
	if save == nil {
		t.Fatal("the save is not watched")
	}
	if save.previous != "last-synced-hash" {
		t.Errorf("previous = %q, want the last-synced hash, not the current remote", save.previous)
	}
}

type versionFailBackend struct{ *fakeConflictBackend }

func (versionFailBackend) remoteVersion(context.Context, string) (int64, time.Time, bool, error) {
	return 0, time.Time{}, false, errors.New("stat timed out")
}

func TestConflictGuardNamesALargeFileWhoseVersionCannotBeRead(t *testing.T) {
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	if err := os.MkdirAll(mountDir, 0o700); err != nil {
		t.Fatal(err)
	}
	big := filepath.Join(mountDir, "movie.mov")
	if err := os.WriteFile(big, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(big, conflictProtectMax+1); err != nil {
		t.Fatal(err)
	}
	f := &versionFailBackend{fakeConflictBackend: newFakeBackend()}
	g := newConflictGuard("mac", mountDir)
	f.pending = []queueEntry{{Name: "movie.mov", Size: conflictProtectMax + 1}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	f.pending = nil
	f.objects["movie.mov"] = "etag:new"
	var named []ConflictSkip
	for i := 0; i < conflictHashFailPolls; i++ {
		res, err := g.pass(context.Background(), f)
		if err != nil {
			t.Fatal(err)
		}
		named = append(named, res.Skipped...)
	}
	if len(named) != 1 || named[0].Remote != "movie.mov" {
		t.Errorf("Skipped = %+v, want the unreadable large save named once", named)
	}
}

func TestConflictGuardNamesASaveItCanNoLongerHash(t *testing.T) {
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	path := filepath.Join(mountDir, "movie.mov")
	if err := os.MkdirAll(mountDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("a small save\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := newFakeBackend()
	g := newConflictGuard("mac", mountDir)
	f.pending = []queueEntry{{Name: "movie.mov", Size: 13}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	if err := os.Truncate(path, conflictProtectMax+1); err != nil {
		t.Fatal(err)
	}
	f.pending = nil
	f.objects["movie.mov"] = md5Hex("another device's save\n")
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass after the other device's save landed: %v", err)
	}
	if len(res.Skipped) != 1 || res.Skipped[0].Remote != "movie.mov" {
		t.Fatalf("Skipped = %+v, want the save left alone", res.Skipped)
	}
	if len(res.Skipped) == 1 && res.Skipped[0].Reason == "" {
		t.Error("the skip has no reason, so a person cannot act on it")
	}
	if len(f.copied) != 0 {
		t.Errorf("copied %v for a save it could not hash", f.copied)
	}
	if len(g.seen) != 0 {
		t.Errorf("still watches %v", g.seen)
	}
	t.Logf("skip: %+v", res.Skipped)
}

func TestConflictGuardNamesASaveGoneBeforeTheClaim(t *testing.T) {
	g, mountDir, f := guardFor(t, "mac", map[string]string{"report.txt": "this device's save\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 20}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	if err := os.Remove(filepath.Join(mountDir, "report.txt")); err != nil {
		t.Fatal(err)
	}
	f.pending = nil
	f.objects["report.txt"] = md5Hex("the other device's save\n")
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass after the other device's save landed: %v", err)
	}
	if len(res.Skipped) != 1 || res.Skipped[0].Remote != "report.txt" {
		t.Fatalf("Skipped = %+v, want the save that is gone", res.Skipped)
	}
	if len(f.copied) != 0 {
		t.Errorf("copied %v for bytes it no longer holds", f.copied)
	}
	if len(g.seen) != 0 {
		t.Errorf("still watches %v", g.seen)
	}
}

type conflictTestError struct{ what string }

func (e *conflictTestError) Error() string { return e.what }

func TestMatchHashSum(t *testing.T) {
	lines := []string{
		"aaa  report (conflict, mac).txt",
		"bbb  report.txt",
	}
	got, err := matchHashSum(lines, "report.txt")
	if err != nil {
		t.Fatal(err)
	}
	if got != "bbb" {
		t.Errorf("matchHashSum = %q, want bbb", got)
	}
	got, err = matchHashSum(lines, "report (conflict, mac).txt")
	if err != nil {
		t.Fatal(err)
	}
	if got != "aaa" {
		t.Errorf("matchHashSum for the conflict name = %q, want aaa", got)
	}
	if got, err := matchHashSum([]string{"ccc  report.txt"}, "report.txt"); err != nil || got != "ccc" {
		t.Errorf("matchHashSum(single) = (%q, %v), want (ccc, nil)", got, err)
	}
	if _, err := matchHashSum(lines, "missing.txt"); err == nil {
		t.Error("matchHashSum accepted a path it cannot find")
	}
	got, err = matchHashSum([]string{"  multipart.bin"}, "multipart.bin")
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Errorf("empty md5 = %q, want empty so the caller compares by ETag", got)
	}
}

func TestHashMountFileHashesTheBytesTheMountServes(t *testing.T) {
	g, _, _ := guardFor(t, "mac", map[string]string{
		"notes.txt":   "hashed bytes\n",
		"a/inner.bin": "nested bytes\n",
	})
	hash, err := g.hashMountFile("notes.txt")
	if err != nil {
		t.Fatal(err)
	}
	if hash != md5Hex("hashed bytes\n") {
		t.Errorf("hash = %q, want the md5 of the bytes at the mount path", hash)
	}
	hash, err = g.hashMountFile("a/inner.bin")
	if err != nil {
		t.Fatal(err)
	}
	if hash != md5Hex("nested bytes\n") {
		t.Errorf("nested hash = %q, want the md5 of the bytes in their folder", hash)
	}
}

func TestHashMountFilePrefersTheVFSCacheFile(t *testing.T) {
	g, mountDir, _ := guardFor(t, "mac", map[string]string{"notes.txt": "from the mount\n"})
	g.cacheDir = t.TempDir()
	g.fs = "drive:bucket/u/me"
	cached := filepath.Join(g.cacheDir, "vfs", "drive", "bucket", "u", "me", "notes.txt")
	if err := os.MkdirAll(filepath.Dir(cached), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cached, []byte("from the cache\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	hash, err := g.hashMountFile("notes.txt")
	if err != nil {
		t.Fatal(err)
	}
	if hash != md5Hex("from the cache\n") {
		t.Errorf("hash = %q, want the VFS cache bytes, not %q on the mount", hash, mountDir)
	}
}

func TestHashMountFileFindsRcloneConfigHashCacheDir(t *testing.T) {
	g, _, _ := guardFor(t, "mac", map[string]string{"notes.txt": "from the mount\n"})
	g.cacheDir = t.TempDir()
	g.fs = "drive:bucket/u/me"
	cached := filepath.Join(g.cacheDir, "vfs", "drive{i9Otv}", "bucket", "u", "me", "notes.txt")
	if err := os.MkdirAll(filepath.Dir(cached), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cached, []byte("from the hashed cache\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	hash, err := g.hashMountFile("notes.txt")
	if err != nil {
		t.Fatal(err)
	}
	if hash != md5Hex("from the hashed cache\n") {
		t.Errorf("hash = %q, want the drive{config} VFS cache bytes", hash)
	}
}

func TestCacheFileIsEmptyWhenTheCacheHasNotBeenCreatedYet(t *testing.T) {
	g := newConflictGuard("mac", t.TempDir())
	g.cacheDir = filepath.Join(t.TempDir(), "missing")
	g.fs = "drive:bucket/u/conflict"
	if p := g.cacheFile("report.txt"); p != "" {
		t.Errorf("cacheFile = %q, want empty: a missing cache is not a panic", p)
	}
}

func TestConflictGuardDoesNotFailThePassWhenTheCacheFileIsMissing(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"notes.txt": "hashed bytes\n"})
	g.cacheDir = t.TempDir()
	g.fs = "drive:bucket/u/me"
	f.pending = []queueEntry{{Name: "notes.txt", Size: 13}}
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("a missing cache file failed the pass: %v", err)
	}
	if g.seen["notes.txt"] != nil {
		t.Fatal("a missing cache file was recorded as sighted; the next pass must be able to hash it")
	}
	if len(res.Claimed) != 0 || len(res.Skipped) != 0 {
		t.Errorf("Claimed=%v Skipped=%v, want nothing decided until the cache file exists", res.Claimed, res.Skipped)
	}
}

func TestHashMountFileRefusesASaveThatGrewPastTheCap(t *testing.T) {
	root := t.TempDir()
	mount := filepath.Join(root, "Drive")
	if err := os.MkdirAll(mount, 0o700); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(mount, "movie.mov")
	out, err := os.Create(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := out.Truncate(conflictProtectMax + 1); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	g := newConflictGuard("mac", mount)
	hash, err := g.hashMountFile("movie.mov")
	if !errors.Is(err, errProtectTooLarge) {
		t.Fatalf("hashMountFile over the cap = (%q, %v), want the named skip", hash, err)
	}
	if hash != "" {
		t.Errorf("hashed %q for a save that is over the cap", hash)
	}
}

func TestConflictGuardBehindReadsTheStateFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "conflict-guard.json")
	now := time.Now()
	if got := conflictGuardBehind(path, now); got != -1 {
		t.Errorf("no file read as %d, want -1", got)
	}
	if err := writeConflictGuardState(path, 9999, now); err != nil {
		t.Fatal(err)
	}
	if got := conflictGuardBehind(path, now); got != 9999 {
		t.Errorf("behind = %d, want 9999", got)
	}
	if got := conflictGuardBehind(path, now.Add(conflictStateFresh+time.Second)); got != -1 {
		t.Errorf("a stale file read as %d, want -1", got)
	}
	if err := os.WriteFile(path, []byte("not the guard's file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := conflictGuardBehind(path, now); got != -1 {
		t.Errorf("an alien file read as %d, want -1", got)
	}
	if err := os.WriteFile(path, []byte(`{"behind":5}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := conflictGuardBehind(path, now); got != -1 {
		t.Errorf("a file with no timestamp read as %d, want -1", got)
	}
}

func TestConflictGuardLineNamesTheBacklog(t *testing.T) {
	home := t.TempDir()
	now := time.Now()
	if line := conflictGuardLine(home, now); line != "" {
		t.Errorf("no guard running printed %q", line)
	}
	if err := writeConflictGuardState(ConflictGuardStatePath(home), conflictSightMax, now); err != nil {
		t.Fatal(err)
	}
	if line := conflictGuardLine(home, now); line != "" {
		t.Errorf("one pass's backlog printed %q, want nothing", line)
	}
	if err := writeConflictGuardState(ConflictGuardStatePath(home), conflictSightMax+1, now); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("conflict guard behind by %d saves", conflictSightMax+1)
	if line := conflictGuardLine(home, now); line != want {
		t.Errorf("line = %q, want %q", line, want)
	}
	if err := writeConflictGuardState(ConflictGuardStatePath(home), 99999, now.Add(-conflictStateFresh-time.Second)); err != nil {
		t.Fatal(err)
	}
	if line := conflictGuardLine(home, now); line != "" {
		t.Errorf("a stale answer printed %q, want nothing", line)
	}
}

func TestRunConflictLoopWritesTheBacklogStateFile(t *testing.T) {
	const total = 2*conflictSightMax + 50
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	if err := os.MkdirAll(mountDir, 0o700); err != nil {
		t.Fatal(err)
	}
	f := newFakeBackend()
	f.pending = make([]queueEntry, 0, total)
	for i := 0; i < total; i++ {
		name := fmt.Sprintf("save-%03d.txt", i)
		if err := os.WriteFile(filepath.Join(mountDir, name), []byte("a save\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		f.pending = append(f.pending, queueEntry{Name: name, Size: 7})
	}
	statePath := filepath.Join(root, "conflict-guard.json")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	msgs := RunConflictLoop(ctx, "mac", mountDir, "", "", statePath, f)
	defer func() {
		cancel()
		for range msgs {
		}
	}()
	want := total - conflictSightMax
	deadline := time.Now().Add(4 * time.Second)
	for {
		if got := conflictGuardBehind(statePath, time.Now()); got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the state file never said behind=%d", want)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func md5Hex(s string) string {
	f := md5.Sum([]byte(s))
	return hex.EncodeToString(f[:])
}

func TestStockHostnameGetsASuffix(t *testing.T) {
	got := stockedHostname("MacBook-Air")
	if !strings.HasPrefix(got, "MacBook-Air-") || len(got) != len("MacBook-Air-")+4 {
		t.Fatalf("stocked hostname = %q, want MacBook-Air-<4 characters>", got)
	}
	if again := stockedHostname("MacBook-Air"); again != got {
		t.Fatalf("the suffix moved between two runs: %q then %q", got, again)
	}
}

func TestStockHostnameWithLocalSuffixGetsASuffix(t *testing.T) {
	if !isStockHostname("MacBook-Air.local") {
		t.Fatal("isStockHostname(\"MacBook-Air.local\") = false, want true")
	}
	got := stockedHostname("MacBook-Air.local")
	if !strings.HasPrefix(got, "MacBook-Air-") || strings.Contains(got, ".local") {
		t.Fatalf("stockedHostname(\"MacBook-Air.local\") = %q, want MacBook-Air-<4 characters>", got)
	}
}

func TestStockHostnameMatchIgnoresCase(t *testing.T) {
	for _, host := range []string{"macbook-air", "MACBOOK-PRO-2", "MacBook-Air.LOCAL", "imac.Local"} {
		if !isStockHostname(host) {
			t.Errorf("isStockHostname(%q) = false, want true", host)
		}
		got := stockedHostname(host)
		if got == host || strings.Contains(strings.ToLower(got), ".local") {
			t.Errorf("stockedHostname(%q) = %q, want the name without .local plus a suffix", host, got)
		}
	}
}

func TestChosenHostnameIsLeftAlone(t *testing.T) {
	for _, host := range []string{
		"Nish's MacBook",
		"studio",
		"MacBook-Air-2x",
		"MacBook-Air-",
		"MacBookAir",
	} {
		if got := stockedHostname(host); got != host {
			t.Errorf("stockedHostname(%q) = %q, want it untouched", host, got)
		}
	}
}

func TestIsStockHostname(t *testing.T) {
	stock := []string{
		"MacBook", "MacBook-Air", "MacBook-Pro", "iMac", "Mac-mini",
		"Mac-Studio", "Mac-Pro",
		"MacBook-Air-2", "iMac-7", "Mac-mini-10",
	}
	for _, host := range stock {
		if !isStockHostname(host) {
			t.Errorf("isStockHostname(%q) = false, want true", host)
		}
	}
	for _, host := range []string{"Nish's MacBook", "studio", "MacBook-Air-2x", "MacBook-Air-", "MacBookAir"} {
		if isStockHostname(host) {
			t.Errorf("isStockHostname(%q) = true, want false", host)
		}
	}
}

func TestDeviceNameFlagWinsOverTheHostname(t *testing.T) {
	if got := deviceName("studio", "MacBook-Air"); got != "studio" {
		t.Errorf("deviceName with a flag = %q, want the flag's name", got)
	}
	if got := deviceName("  ", "MacBook-Air"); !strings.HasPrefix(got, "MacBook-Air-") {
		t.Errorf("deviceName with a blank flag = %q, want the stock hostname suffixed", got)
	}
	if got := deviceName("", "Nish's MacBook"); got != "Nish-s-MacBook" {
		t.Errorf("deviceName with a chosen hostname = %q, want the sanitized \"Nish-s-MacBook\"", got)
	}
	if got, want := deviceName("", "Nish's MacBook"), SanitizeDevice(stockedHostname("Nish's MacBook")); got != want {
		t.Errorf("deviceName = %q, mount conflict name = %q, want one name", got, want)
	}
	if got := deviceName("", ""); got != "this device" {
		t.Errorf("deviceName with no hostname = %q, want \"this device\"", got)
	}
}

func TestMachineIDIsPresent(t *testing.T) {
	if id := machineID(); strings.TrimSpace(id) == "" {
		t.Fatal("machineID() = \"\", want this machine's identifier")
	}
}
