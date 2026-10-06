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
//     in e2e_test.go.

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
// which state each pass sees.
type fakeConflictBackend struct {
	pending   []queueEntry      // what vfs/queue reports
	objects   map[string]string // remote path -> md5
	exports   map[string]string // staging path -> the md5 it was staged with
	copied    []string          // the remote paths written as conflict copies
	refreshed int
	failWith  error
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
	hashErr       map[string]error
	// versions is the size and mtime operations/stat reports per object.
	versions map[string]objectVersion
}

type objectVersion struct {
	size    int64
	modTime time.Time
}

func newFakeBackend() *fakeConflictBackend {
	return &fakeConflictBackend{
		objects:  map[string]string{},
		exports:  map[string]string{},
		hashErr:  map[string]error{},
		versions: map[string]objectVersion{},
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

// landAs records the object at name as the version of the local file p,
// which is what rclone's upload of this device's save leaves in storage.
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
	return f.objects[name], nil
}

// copyLocalToRemote models rclone's operations/copyfile: the object that
// lands at dstRemote is the md5 of the staged file, which is real bytes on
// disk, because the guard copied this device's save out of the mount while
// its upload was queued. A test that wants to say the staged bytes are
// something else sets exports, which is how a foreign or corrupt copy is
// modelled; clobber is how another mount's save at the same name is modelled.
func (f *fakeConflictBackend) copyLocalToRemote(_ context.Context, stagingRoot, srcRemote, dstRemote string) error {
	if f.failWith != nil {
		return f.failWith
	}
	if f.clobber && (f.alwaysClobber || !f.clobbered) {
		f.clobbered = true
		f.objects[dstRemote] = "another-mounts-save"
		f.copied = append(f.copied, dstRemote)
		return nil
	}
	if hash, ok := f.exports[srcRemote]; ok {
		f.objects[dstRemote] = hash
		f.copied = append(f.copied, dstRemote)
		return nil
	}
	sum, err := hashFile(filepath.Join(stagingRoot, filepath.FromSlash(srcRemote)))
	if err != nil {
		return fmt.Errorf("read the staged copy of %s: %w", srcRemote, err)
	}
	f.objects[dstRemote] = sum
	f.copied = append(f.copied, dstRemote)
	return nil
}

// hashFile is the md5 of a real file, so a stand-in copy of real staged
// bytes carries the hash those bytes have.
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

// guardFor builds a guard over a mount dir with the files staged under it,
// so the real staging path runs.
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
	staging := ConflictStagingDir(root)
	g := newConflictGuard(device, mountDir, staging)
	f := newFakeBackend()
	return g, staging, f
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
	f.exports["report.txt"] = md5Hex("A-is-this-machines-save\n")
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
	// A save that left the drive before the pass can stage it is still a
	// named skip. A file over the staging cap is not: that case is watched
	// by fingerprint (TestConflictGuardComparesALargeFileByFingerprint).
	f := newFakeBackend()
	g := newConflictGuard("mac", mountDir, ConflictStagingDir(root))
	f.pending = []queueEntry{{Name: "gone.txt", Size: 4}}
	first, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if len(first.Skipped) != 1 || first.Skipped[0].Remote != "gone.txt" {
		t.Fatalf("Skipped = %+v, want gone.txt", first.Skipped)
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
	// that overwrite is exactly what the staged copy exists for.
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
// guard keeps the staged copy through that window and writes the conflict
// copy, so the earlier save is not the save that silently disappears.
func TestConflictGuardKeepsASaveThatLandsSecondsLater(t *testing.T) {
	g, staging, f := guardFor(t, "mac", map[string]string{"report.txt": "A-this-device-saved-first\n"})
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
	// The staged copy is gone once the save it protected has been decided.
	if _, err := os.Stat(filepath.Join(staging, "report.txt")); !os.IsNotExist(err) {
		t.Errorf("the staged copy is still on disk: %v", err)
	}
}

// TestConflictGuardStagesTheBytesTheUploadWillCarry proves a device that
// writes the same path again before its write-back fires protects the newer
// bytes, not the ones staged at first sight. The bytes the upload carries are
// the bytes on the mount when it fires, so a staged copy of an older write
// would be the wrong version to keep.
func TestConflictGuardStagesTheBytesTheUploadWillCarry(t *testing.T) {
	root := t.TempDir()
	mountDir := filepath.Join(root, "Drive")
	path := filepath.Join(mountDir, "report.txt")
	if err := os.MkdirAll(mountDir, 0o700); err != nil {
		t.Fatal(err)
	}
	// The first write is staged, then this device writes the path again
	// with a different size, which is what rclone's VFS reports through
	// the mount's stat.
	if err := os.WriteFile(path, []byte("first write\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := newFakeBackend()
	g := newConflictGuard("mac", mountDir, ConflictStagingDir(root))
	f.pending = []queueEntry{{Name: "report.txt", Size: 13}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	first := filepath.Join(ConflictStagingDir(root), "report.txt")
	got, err := os.ReadFile(first)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "first write\n" {
		t.Fatalf("staged %q, want the first write", got)
	}
	if err := os.WriteFile(path, []byte("second write\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass after the save was written again: %v", err)
	}
	got, err = os.ReadFile(first)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "second write\n" {
		t.Errorf("staged %q, want the bytes the upload will carry (the second write)", got)
	}
	// The other device's save lands on top of the re-staged one, and the
	// conflict copy is the bytes this device will actually upload.
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

// TestConflictGuardComparesALargeFileByFingerprint proves a save over the
// staging cap is still watched: it is compared by size/mtime (and the remote
// ETag via remoteHash) rather than skipped, and a conflict is named without
// claiming a copy there are no staged bytes for.
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
	if err := os.Truncate(big, conflictStageMax+1); err != nil {
		t.Fatal(err)
	}
	f := newFakeBackend()
	g := newConflictGuard("mac", mountDir, ConflictStagingDir(root))
	f.pending = []queueEntry{{Name: "movie.mov", Size: conflictStageMax + 1}}
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if len(res.Skipped) != 0 {
		t.Errorf("Skipped = %+v, want the large save watched not skipped", res.Skipped)
	}
	if g.seen["movie.mov"] == nil {
		t.Fatal("the large save is not watched")
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
	if err := os.Truncate(big, conflictStageMax+1); err != nil {
		t.Fatal(err)
	}
	f := newFakeBackend()
	g := newConflictGuard("mac", mountDir, ConflictStagingDir(root))
	f.pending = []queueEntry{{Name: "movie.mov", Size: conflictStageMax + 1}}
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
		t.Errorf("claimed a conflict copy with no staged bytes: %v", f.copied)
	}
}

// TestConflictGuardNamesALargeOverwrite proves the late overwrite the
// fingerprint watch exists for: another device's version of a file too large
// to stage lands, its size and mtime are not this device's, and the guard
// names it rather than reading it as this device's own upload.
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
	if err := os.Truncate(big, conflictStageMax+1); err != nil {
		t.Fatal(err)
	}
	f := newFakeBackend()
	g := newConflictGuard("mac", mountDir, ConflictStagingDir(root))
	f.pending = []queueEntry{{Name: "movie.mov", Size: conflictStageMax + 1}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	f.pending = nil
	f.objects["movie.mov"] = "etag:other-device"
	f.versions["movie.mov"] = objectVersion{size: conflictStageMax + 2, modTime: time.Now().Add(time.Minute)}
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
		t.Fatalf("the staged save is not watched: %v", g.seen)
	}
	// A failing queue read is an error, and it must not lose the save this
	// device already staged: the next good pass still decides it, so a
	// pass that cannot read its queue cannot silently strand one.
	f.failWith = errConflictTestQueue
	if _, err := g.pass(context.Background(), f); err == nil {
		t.Fatal("a failing pass reported no error")
	} else if !strings.Contains(err.Error(), "read the upload queue") {
		t.Errorf("the error did not name what failed: %v", err)
	}
	if len(g.seen) != 1 {
		t.Errorf("a failed queue read lost the staged save: %v", g.seen)
	}
}

var errConflictTestQueue = &conflictTestError{"queue"}

func TestConflictGuardHoldsAHashErrorOnThatEntryOnly(t *testing.T) {
	g, mountDir, f := guardFor(t, "mac", map[string]string{
		"ok.txt":  "ok\n",
		"bad.txt": "bad\n",
	})
	_ = mountDir
	f.pending = []queueEntry{{Name: "ok.txt", Size: 3}, {Name: "bad.txt", Size: 4}}
	f.hashErr["bad.txt"] = errors.New("empty md5")
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("a hash error on one path failed the pass: %v", err)
	}
	if g.seen["ok.txt"] == nil {
		t.Fatal("the good save was not watched")
	}
	if g.seen["bad.txt"] == nil {
		t.Fatal("the failing hash did not hold its entry")
	}
	if len(res.Claimed) != 0 {
		t.Errorf("claimed %v on a pass with a hash error", res.Claimed)
	}
}

// TestConflictGuardDoesNotClaimAnUnreadBaseline proves a save whose baseline
// hash could not be read at first sight is not claimed as a conflict against
// the version it was always going to replace, and that the baseline is read
// again on the next pass.
func TestConflictGuardDoesNotClaimAnUnreadBaseline(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "my save\n"})
	f.objects["report.txt"] = md5Hex("the version before the save\n")
	f.pending = []queueEntry{{Name: "report.txt", Size: 8}}
	f.hashErr["report.txt"] = errors.New("hashsum timed out")
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	if !g.seen["report.txt"].baselineUnknown {
		t.Fatal("a failed baseline read is not marked unknown")
	}
	// The upload leaves the queue without landing, and the read works again.
	delete(f.hashErr, "report.txt")
	f.pending = nil
	for i := 0; i < conflictClaimPolls+1; i++ {
		res, err := g.pass(context.Background(), f)
		if err != nil {
			t.Fatal(err)
		}
		if len(res.Claimed) != 0 {
			t.Fatalf("claimed %v against the version the save replaces", res.Claimed)
		}
	}
	if len(f.copied) != 0 {
		t.Errorf("copied %v", f.copied)
	}
}

// TestConflictGuardRereadsTheBaselineWhileQueued proves the baseline is read
// again on the next pass while the save is still queued.
func TestConflictGuardRereadsTheBaselineWhileQueued(t *testing.T) {
	g, _, f := guardFor(t, "mac", map[string]string{"report.txt": "my save\n"})
	before := md5Hex("the version before the save\n")
	f.objects["report.txt"] = before
	f.pending = []queueEntry{{Name: "report.txt", Size: 8}}
	f.hashErr["report.txt"] = errors.New("hashsum timed out")
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	delete(f.hashErr, "report.txt")
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	save := g.seen["report.txt"]
	if save.baselineUnknown || save.previous != before {
		t.Errorf("baselineUnknown=%v previous=%q, want the re-read baseline %q", save.baselineUnknown, save.previous, before)
	}
}

// TestConflictGuardNamesALargeFileWhoseVersionCannotBeRead proves a failing
// version read on a large file is named after conflictHashFailPolls passes
// rather than retried silently for ever.
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
	if err := os.Truncate(big, conflictStageMax+1); err != nil {
		t.Fatal(err)
	}
	f := &versionFailBackend{fakeConflictBackend: newFakeBackend()}
	g := newConflictGuard("mac", mountDir, ConflictStagingDir(root))
	f.pending = []queueEntry{{Name: "movie.mov", Size: conflictStageMax + 1}}
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

type versionFailBackend struct{ *fakeConflictBackend }

func (versionFailBackend) remoteVersion(context.Context, string) (int64, time.Time, bool, error) {
	return 0, time.Time{}, false, errors.New("stat timed out")
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

// TestConflictGuardNamesASaveItCanNoLongerRestage proves that when a save
// grows past the staging cap between two passes, the guard does not claim
// the older staged bytes: a conflict copy of a version nobody uploaded is
// not the save it exists to keep. The path is dropped from the watch and
// named, and no conflict name is written for it.
func TestConflictGuardNamesASaveItCanNoLongerRestage(t *testing.T) {
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
	g := newConflictGuard("mac", mountDir, ConflictStagingDir(root))
	f.pending = []queueEntry{{Name: "movie.mov", Size: 13}}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass with the save queued: %v", err)
	}
	// This device grows the save past the cap before its write-back fires.
	if err := os.Truncate(path, conflictStageMax+1); err != nil {
		t.Fatal(err)
	}
	if _, err := g.pass(context.Background(), f); err != nil {
		t.Fatalf("pass after the save grew: %v", err)
	}
	// The other device's save lands on top. There are no staged bytes for the
	// grown file, so the guard names it and writes no conflict copy.
	f.pending = nil
	f.objects["movie.mov"] = md5Hex("another device's save\n")
	res, err := g.pass(context.Background(), f)
	if err != nil {
		t.Fatalf("pass after the other device's save landed: %v", err)
	}
	if len(f.copied) != 0 {
		t.Errorf("copied %v for a save it could not restage", f.copied)
	}
	if len(res.Skipped) != 1 || res.Skipped[0].Remote != "movie.mov" {
		t.Errorf("Skipped = %+v, want the grown save named", res.Skipped)
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
	got, err = matchHashSum([]string{"  multipart.bin"}, "multipart.bin")
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Errorf("empty md5 = %q, want empty so the caller compares by ETag", got)
	}
}

// TestCopyFileWithHashStagesTheBytes proves the staged copy and the hash are
// of the same bytes, which is what the guard's decision compares.
func TestCopyFileWithHashStagesTheBytes(t *testing.T) {
	root := t.TempDir()
	mount := filepath.Join(root, "Drive")
	staging := ConflictStagingDir(root)
	src := filepath.Join(mount, "notes.txt")
	if err := os.MkdirAll(mount, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, []byte("staged bytes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	staged, hash, err := copyFileWithHash(src, filepath.Join(staging, "notes.txt"), staging)
	if err != nil {
		t.Fatal(err)
	}
	if staged != "notes.txt" {
		t.Errorf("staged path = %q, want notes.txt", staged)
	}
	got, err := os.ReadFile(filepath.Join(staging, staged))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "staged bytes\n" {
		t.Errorf("staged bytes = %q", got)
	}
	if hash != md5Hex("staged bytes\n") {
		t.Errorf("hash = %q, want the md5 of the staged bytes", hash)
	}
}

// TestCopyFileWithHashRefusesASaveThatGrewPastTheCap proves a save that
// grows past the cap between the size check and the copy is a named skip
// rather than a staged copy of truncated bytes with a hash of its own: a
// conflict copy made of those would be a corrupt version of the save it
// exists to keep.
func TestCopyFileWithHashRefusesASaveThatGrewPastTheCap(t *testing.T) {
	root := t.TempDir()
	mount := filepath.Join(root, "Drive")
	staging := ConflictStagingDir(root)
	if err := os.MkdirAll(mount, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(mount, "movie.mov")
	out, err := os.Create(src)
	if err != nil {
		t.Fatal(err)
	}
	// A sparse file of cap+1 bytes reads back as cap+1 zero bytes, which
	// is exactly what a save that grew past the cap is at the copy.
	if err := out.Truncate(conflictStageMax + 1); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	staged, hash, err := copyFileWithHash(src, filepath.Join(staging, "movie.mov"), staging)
	if !errors.Is(err, errStageTooLarge) {
		t.Fatalf("copyFileWithHash over the cap = (%q, %q, %v), want the named skip", staged, hash, err)
	}
	if staged != "" || hash != "" {
		t.Errorf("staged (%q, %q) for a save that is over the cap", staged, hash)
	}
	if _, err := os.Stat(filepath.Join(staging, "movie.mov")); !os.IsNotExist(err) {
		t.Errorf("the truncated copy is still in the staging dir: %v", err)
	}
}

// md5Hex is the md5 a test expects rclone's operations/hashsum to report.
func md5Hex(s string) string {
	f := md5.Sum([]byte(s))
	return hex.EncodeToString(f[:])
}
