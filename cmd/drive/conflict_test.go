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

// The conflict rule (drive issue #30). Each test drives the real code
// rather than a copy of it:
//
//   - the naming (ConflictName) is what the issue's finish line names
//     literally, so it is tested on the shapes a real drive holds;
//   - the decision (conflictGuard.pass) is tested against a counted
//     stand-in backend, including the case that must write nothing;
//   - the two-mount behaviour on real storage is TestTwoDevicesKeepBothSaves
//     in conflict_e2e_test.go.

func TestConflictNamePutsTheDeviceBeforeTheExtension(t *testing.T) {
	for _, tc := range []struct {
		path   string
		device string
		want   string
	}{
		{"report.txt", "mac", "report (conflict, mac).txt"},
		{"notes", "studio-1", "notes (conflict, studio-1)"},
		{"photos/img.JPEG", "Mac", "photos/img (conflict, Mac).JPEG"},
		// Only the last extension is the format: a tar.gz keeps both.
		{"archive.tar.gz", "mac", "archive.tar (conflict, mac).gz"},
		// A dotfile is a whole name, not a format called ".env".
		{".env", "mac", ".env (conflict, mac)"},
		// Empty extension markers go away.
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
	// The marker and the device must never be able to introduce a folder of
	// their own: a device name is sanitized to filename characters.
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
	// The cap: a device name that is too long is a name, not a filename
	// error at the mount's first conflict.
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

// fakeConflictBackend is a counted stand-in for the mount's remote control:
// the queue, the objects and the copies are plain maps, so a test says exactly
// which state each pass sees. The counters are how a test proves which remote
// calls a pass made: a path that never existed must cost no hashsum, and a
// folder's listing must be asked for once, not once per save in it.
type fakeConflictBackend struct {
	pending    []queueEntry      // what vfs/queue reports
	objects    map[string]string // remote path -> md5
	copied     []string          // the remote paths written as conflict copies
	listCalls  int               // parentContents calls
	hashCalls  int               // remoteHash calls
	pollCounts map[string]int    // remoteHash calls per path
	refreshed  int
	failWith   error
	// clobber makes one copy land at a name that holds another mount's
	// save, which is the race two mounts answering to the same device
	// name can produce: both find the name free in the same instant.
	clobber bool
	// clobbered is set once the one clobber has happened, so a retry
	// under the next number carries this device's own bytes.
	clobbered bool
	// alwaysClobber clobbers every name, which is the case where the
	// guard must give up rather than claim another writer's save.
	alwaysClobber bool
}

func newFakeBackend() *fakeConflictBackend {
	return &fakeConflictBackend{
		objects:    map[string]string{},
		pollCounts: map[string]int{},
	}
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
	f.hashCalls++
	f.pollCounts[name]++
	return f.objects[name], nil
}

// parentContents derives one folder's listing from the objects map, the
// way a real listing reflects the objects in storage.
func (f *fakeConflictBackend) parentContents(_ context.Context, dir string) (map[string]bool, error) {
	if f.failWith != nil {
		return nil, f.failWith
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

// copyLocalToRemote models rclone's operations/copyfile: the object that
// lands at dstRemote is the md5 of the real file the guard read, because
// the source is this device's own mount and the file is real bytes on
// disk. clobber is how another mount's save at the same name is modelled.
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

// hashFile is the md5 of a real file, so a copy of real bytes carries the
// hash those bytes have.
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
	if f.failWith != nil {
		return f.failWith
	}
	f.refreshed++
	return nil
}

// guardFor builds a guard over a mount dir with real files under it, so
// the hashing reads the bytes a mount would serve.
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

// TestConflictGuardKeepsTheLosersVersion is the issue's headline: two devices
// save the same path in one sync window, and both saves survive.
func TestConflictGuardKeepsTheLosersVersion(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "A-is-this-machines-save\n"})
	// The save is in flight: it is in the queue, nothing has landed.
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

	// The other device's save landed after it: the object's hash is neither
	// this device's bytes nor the version that preceded the save.
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
	// The conflict copy is gone from the watch list once it is written.
	if len(g.seen) != 0 {
		t.Errorf("the guard still watches %v", g.seen)
	}
	// The path stays recorded on the result, so a log says what happened.
	if len(res.Claimed) != 1 || res.Claimed[0].Remote != want || res.Claimed[0].LosingPath != "report.txt" {
		t.Errorf("Claimed = %+v, want the one conflict copy", res.Claimed)
	}
}

// TestConflictGuardSkipsTheRemoteHashForAPathThatNeverExisted proves the
// parent listing does the work of the per-path hashsum at first sight: one
// listing of the folder says which paths ever existed, and a path it leaves
// out is hashed at the remote never — a drop of new files into one folder
// costs one listing instead of one hashsum per file.
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
	// One listing of the top of the drive answered for both saves, and only
	// the path it showed to have existed was hashed.
	if f.listCalls != 1 {
		t.Errorf("the folder was listed %d times, want once for both saves", f.listCalls)
	}
	if f.hashCalls != 1 {
		t.Errorf("%d remote hashes were read, want 1 (old.txt only): a path that never existed has no hash to read", f.hashCalls)
	}
	// The never-existed save is still protected: the baseline is "" and the
	// decision runs the same way when the other device lands on it.
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

// TestConflictGuardSightsABoundedNumberOfSavesPerPass proves one pass does
// bounded work: a drop bigger than conflictSightMax is sighted over several
// passes, and what is still waiting is counted, because that count is what
// `drive status` reports.
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

// TestConflictGuardPollsABoundedNumberAndResumes proves the landed side of
// the same bound: a pass decides conflictPollMax paths and the next pass
// continues down the watch list from there, so no path is polled twice
// while another has not been polled at all.
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
	// Every save has landed (its own bytes), so every path is polled.
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
	// The first hundred in first-sight order were polled; the tail was not.
	for i, name := range g.order {
		want := 1
		if i >= conflictPollMax {
			want = 0
		}
		if got := f.pollCounts[name]; got != want {
			t.Fatalf("save %d was polled %d times after one pass, want %d", i, got, want)
		}
	}
	// The second pass resumes from where the first stopped: the tail gets
	// its first poll, which a pass that restarted from the top would never
	// reach while the head hogs the bound.
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("second polling pass: %v", err)
	}
	if f.hashCalls != 2*conflictPollMax {
		t.Fatalf("two passes polled %d paths, want %d", f.hashCalls, 2*conflictPollMax)
	}
	// Every path has now been polled, each as often as its window says,
	// and no path has been polled twice while another waited: the head's
	// count is ahead of the tail's by exactly the ring step.
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

// TestConflictGuardFinishesATenThousandEntryQueueAcrossPasses is the finish
// line's own case: a drop of 10,000 small files cannot be sighted, decided
// and drained in one pass, and no pass may error while the guard works
// through it. The queue is sighted conflictSightMax at a time, a wave of
// wins runs its window, and the rest ends as named skips once this
// device's files are gone and the other device's saves have landed — every
// entry reaches a decision, and the watch list ends empty.
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

	// A wave of 300 lands as this device's own wins: each needs its
	// conflictWinPolls polls, a hundred per pass, so the wave takes about
	// sixty passes.
	const wave = 300
	for i := 0; i < wave; i++ {
		f.objects[name(i)] = md5Hex(body)
	}
	f.pending = f.pending[wave:]
	for range 80 {
		if _, err := g.pass(context.Background(), f); err != nil {
			t.Fatalf("pass %d in the win wave: %v", passes, err)
		}
		passes++
	}
	if len(g.seen) != total-wave {
		t.Fatalf("the win wave left %d saves watched, want %d", len(g.seen), total-wave)
	}

	// The rest: this device's files are gone from the machine and the other
	// device's saves have landed on every one of them. Nothing can be
	// written for them, so each is named once and dropped — and no pass
	// errors, which is the point: the guard keeps up without ever failing.
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

// TestConflictGuardWritesNoSecondCopyOfAnySave is the disk half of the same
// finish line: the guard hashes the bytes where they are and claims them
// from the mount, so its own footprint beside the mount stays nothing. The
// budget is the contract; zero is the design.
func TestConflictGuardWritesNoSecondCopyOfAnySave(t *testing.T) {
	const conflictGuardSideBudget = 4096
	const total = 150
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	drop := filepath.Join(mountDir, "drop")
	if err := os.MkdirAll(drop, 0o700); err != nil {
		t.Fatal(err)
	}
	body := strings.Repeat("a reasonably sized save\n", 170) // ~4 KiB each
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
	// Ten land under the other device's saves (claims); the rest are this
	// device's own wins.
	f.pending = nil
	for i := 0; i < total; i++ {
		if i < 10 {
			f.objects[name(i)] = md5Hex("the other device's save\n")
		} else {
			f.objects[name(i)] = md5Hex(body)
		}
	}
	for range 60 {
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
	// The whole footprint the guard left beside the mount: none. Walk the
	// test's own root and add up everything that is not the mount dir.
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

// TestConflictGuardNamesASkipOnce proves a save the rule leaves alone is
// named on the pass that first sees it and not again while it stays in the
// queue: a skip line every half second for the life of an upload is not a
// thing a person can read.
func TestConflictGuardNamesASkipOnce(t *testing.T) {
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
	first, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if len(first.Skipped) != 1 || first.Skipped[0].Remote != "movie.mov" {
		t.Fatalf("Skipped = %+v, want movie.mov", first.Skipped)
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
	// The queue has released the path, so the entry goes with it: the map
	// does not grow on a mount that never stops.
	f.pending = nil
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass: %v", err)
	}
	if len(g.seen) != 0 {
		t.Errorf("still watches %v", g.seen)
	}
}

// TestConflictGuardRetriesANameAnotherMountTook proves the conflict copy is
// this device's own save, not whoever wrote the name last: two mounts
// answering to the same device name can look at the same free name in the
// same instant, so the copy is read back and a name holding another writer's
// bytes is retried under the next number.
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
	// The name the other mount took is not this device's claim.
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass: %v", err)
	}
}

// TestConflictGuardGivesUpWhenEveryNameIsTaken proves a mount that races with
// every name says so, rather than claiming a second device's save under this
// device's name.
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

// TestConflictGuardLeavesAWinningSaveAlone is the other half of the same
// rule: this device's save is the one that landed, and nothing is written.
func TestConflictGuardLeavesAWinningSaveAlone(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "the winning save\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 17}}
	f.objects["report.txt"] = "older-version"
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	// This device's bytes landed, so the plain path is what this device wrote.
	f.pending = nil
	f.objects["report.txt"] = md5Hex("the winning save\n")
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass after the save landed: %v", err)
	}
	if len(f.copied) != 0 {
		t.Errorf("wrote %v for a save that won", f.copied)
	}
	// The win is not decided on the pass that sees it: the other device's
	// save can still land on top of it for the rest of the sync window, and
	// that overwrite is exactly what the guard exists for.
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

// TestConflictGuardKeepsASaveThatLandsSecondsLater proves the case a
// same-instant proof cannot see. A device's own save has already landed, so
// the plain path holds its bytes, and the other device's save lands on top
// of it a moment later — the ordinary case when two people save the same
// file seconds apart inside the mount's five-second write-back window. The
// guard keeps watching through that window and writes the conflict copy
// from the bytes its own mount still serves, so the earlier save is not the
// save that silently disappears.
func TestConflictGuardKeepsASaveThatLandsSecondsLater(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "A-this-device-saved-first\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 26}}
	f.objects["report.txt"] = "nothing-here-yet"
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	// This device's upload has landed, and it is the plain path now.
	f.pending = nil
	f.objects["report.txt"] = md5Hex("A-this-device-saved-first\n")
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass after the save landed: %v", err)
	}
	// The other device's save lands on top of it, seconds later.
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

// TestConflictGuardRehashesTheBytesTheUploadWillCarry proves a device that
// writes the same path again before its write-back fires protects the newer
// bytes, not the ones hashed at first sight. The bytes the upload carries
// are the bytes on the mount when it fires, so a hash of an older write
// would be the wrong version to keep.
func TestConflictGuardRehashesTheBytesTheUploadWillCarry(t *testing.T) {
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	path := filepath.Join(mountDir, "report.txt")
	if err := os.MkdirAll(mountDir, 0o700); err != nil {
		t.Fatal(err)
	}
	// The first write is hashed, then this device writes the path again
	// with a different size, which is what rclone's VFS reports through
	// the mount's stat.
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
	// The other device's save lands on top, and the conflict copy is the
	// bytes this device will actually upload — the re-hash at the decision
	// is what keeps the newer write.
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

// TestConflictGuardNumbersARepeatedConflict proves a device that loses the
// same file twice does not overwrite the copy of its first loss.
func TestConflictGuardNumbersARepeatedConflict(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "second loss\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 12}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	f.pending = nil
	// The first loss is already kept under the first conflict name.
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
	// The first copy is untouched.
	if got := f.objects["report (conflict, mac).txt"]; got != "A-the-first-loss" {
		t.Errorf("the first conflict copy was overwritten: %s", got)
	}
	if len(res.Claimed) != 1 || res.Claimed[0].Remote != want {
		t.Errorf("Claimed = %+v", res.Claimed)
	}
}

// TestConflictGuardKeepsAFolderInTheConflictName proves a save lost inside a
// folder is kept inside that folder.
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

// TestConflictGuardWaitsForASaveThatHasNotLandedYet proves the rule is not
// an eager one: the queue has released a path whose object is still the
// version that preceded the save, and the guard watches it rather than
// claiming a conflict.
func TestConflictGuardWaitsForASaveThatHasNotLandedYet(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "this device's save\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 20}}
	f.objects["report.txt"] = "the-version-before"
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	// The upload failed once, so the queue released the path and the object is
	// still the old one. The save is not lost yet: the queue retries it.
	f.pending = nil
	for i := 0; i < conflictClaimPolls-1; i++ {
		if _, err := g.pass(context.Background(), f); err != nil {
			t.Fatalf("pass %d: %v", i, err)
		}
		if len(f.copied) != 0 {
			t.Fatalf("pass %d claimed a conflict while the object was unchanged", i)
		}
	}
	// Once the budget is spent, the path is no longer watched; it is not a
	// conflict and it must not grow the map on a mount that never stops.
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

// TestConflictGuardSkipsASaveTooLargeToProtect proves the one skip is named.
func TestConflictGuardSkipsASaveTooLargeToProtect(t *testing.T) {
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
	if len(res.Skipped) != 1 || res.Skipped[0].Remote != "movie.mov" {
		t.Errorf("Skipped = %+v, want the save that was left alone", res.Skipped)
	}
	if len(res.Skipped) == 1 && res.Skipped[0].Reason == "" {
		t.Error("a skip with no reason is a lost save nobody was told about")
	}
	// A skipped save is not a watched save: the guard never claims it.
	f.pending = nil
	f.objects["movie.mov"] = "someone-elses-save"
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass: %v", err)
	}
	if len(f.copied) != 0 {
		t.Errorf("claimed a conflict for a save it had skipped: %v", f.copied)
	}
}

// TestConflictGuardReportsAFailingPass proves a remote-control failure is not
// swallowed into "no conflict": the mount keeps running and the cause is
// named.
func TestConflictGuardReportsAFailingPass(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "a save\n"})
	f.pending = []queueEntry{{Name: "report.txt", Size: 7}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	if len(g.seen) != 1 {
		t.Fatalf("the hashed save is not watched: %v", g.seen)
	}
	// A failing queue read is an error, and it must not lose the save this
	// device already hashed: the next good pass still decides it, so a
	// pass that cannot read its queue cannot silently strand one.
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

// TestConflictGuardNamesASaveItCanNoLongerHash proves that when a save grows
// past the protection cap before its write-back fires, the guard does not
// claim bytes it cannot hash whole: a conflict copy of a version nobody
// uploaded is not the save it exists to keep. The path is dropped from the
// watch and named, and no conflict name is written for it.
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
	// This device grows the save past the cap before its write-back fires,
	// and the other device's save lands on top. This device has nothing it
	// can hash whole, so it writes no conflict copy and names the loss.
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

// TestConflictGuardNamesASaveGoneBeforeTheClaim proves the same honesty for
// a save whose bytes are gone from the machine when the other device's save
// lands: there is nothing left to write, so the loss is named once instead
// of being retried every pass forever.
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

// TestMatchHashSumPicksTheRightEntry proves the hash is taken for the entry
// named, not the first line of a multi-path reply.
// TestMatchHashSum proves the hash is taken for the path that was asked
// for, whether or not that path has spaces in it: a conflict name is
// "report (conflict, mac).txt", and a reply parsed by words would return
// the hash of a different file.
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
	// A name with spaces is matched as a whole name.
	got, err = matchHashSum(lines, "report (conflict, mac).txt")
	if err != nil {
		t.Fatal(err)
	}
	if got != "aaa" {
		t.Errorf("matchHashSum for the conflict name = %q, want aaa", got)
	}
	// The single-entry reply is the base name's own, which is how a backend
	// that answers with the file it was asked about reads.
	if got, err := matchHashSum([]string{"ccc  report.txt"}, "report.txt"); err != nil || got != "ccc" {
		t.Errorf("matchHashSum(single) = (%q, %v), want (ccc, nil)", got, err)
	}
	if _, err := matchHashSum(lines, "missing.txt"); err == nil {
		t.Error("matchHashSum accepted a path it cannot find")
	}
}

// TestHashMountFileHashesTheBytesTheMountServes proves the hash and the
// bytes are the same bytes: the md5 the decision compares is the md5 of
// what the mount path holds, read where it lies.
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

// TestHashMountFileRefusesASaveThatGrewPastTheCap proves a save that grows
// past the cap while it is hashed is a named skip rather than a hash of
// truncated bytes: a conflict copy made of those would be a corrupt version
// of the save it exists to keep.
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
	// A sparse file of cap+1 bytes reads back as cap+1 zero bytes, which
	// is exactly what a save that grew past the cap is at the hash.
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

// TestConflictGuardBehindReadsTheStateFile proves the state file is an
// answer only while it is fresh, and never an error surfaced to a person:
// a missing, stale, or alien file is "no answer", because the guard's own
// failures are named on the mount's log.
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

// TestConflictGuardLineNamesTheBacklog proves the status line: a fresh
// answer bigger than one pass's bound is named with its number, one pass's
// worth of backlog is not (the next pass clears it), and no answer prints
// nothing.
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

// TestRunConflictLoopWritesTheBacklogStateFile proves the loop records its
// backlog where `drive status` reads it, on the real loop and not a copy:
// a queue bigger than one pass's bound shows up as the behind count within
// a pass or two of starting.
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
	msgs := RunConflictLoop(ctx, "mac", mountDir, statePath, f)
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

// md5Hex is the md5 a test expects rclone's operations/hashsum to report.
func md5Hex(s string) string {
	f := md5.Sum([]byte(s))
	return hex.EncodeToString(f[:])
}
