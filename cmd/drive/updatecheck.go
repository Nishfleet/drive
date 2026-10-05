package main

// The once-a-day update notice (drive#560): `drive status` is the command a
// person runs to look at their drive, so it is the one place a customer
// learns a newer build exists. The question it asks is the same one
// `drive update` asks — whether the package manager that installed this
// binary reports a newer package (update.go) — so the notice and the updater
// can never disagree about what "newer" means. It asks at most once every
// 24 hours, and keeps its state beside the VFS cache — not inside it,
// because `drive cache --clear` empties the vfs directory and would
// otherwise forget the last check every clear.
//
// The notice never fails the command it rides on: a package manager that
// will not answer is tomorrow's check, not today's error. It prints at most
// once per 24 hours even when status runs many times a day, which is what
// the notified-at stamp in the state file is for.

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// updateNoticeWords is the one line `drive status` prints when a newer
// release exists and this device has not been told about it in the last day.
const updateNoticeWords = "a newer drive is available: run drive update"

// updateCheckInterval is how often the notice may ask the package manager
// again, and how often it may print.
const updateCheckInterval = 24 * time.Hour

// updateCheckPath is the state file, next to the VFS cache directory rather
// than inside it (see the file comment).
func updateCheckPath(home string) string {
	return filepath.Join(filepath.Dir(DefaultCacheDir(home)), "update-check.json")
}

// updateCheckRecord is the state one line of JSON keeps between status runs.
// Timestamps are unix seconds.
type updateCheckRecord struct {
	CheckedAt  int64 `json:"checkedAt"`
	NotifiedAt int64 `json:"notifiedAt"`
}

// updateExists is the production read on "is a newer drive available": the
// install route this binary shipped on, asked the same way `drive update`
// asks it, so a customer is never told to run drive update on a machine
// whose route has nothing newer.
func updateExists() (bool, error) {
	return updateExistsOn(defaultLookPath, defaultCapture)
}

// updateExistsOn is updateExists with the package probe injected, so a test
// can prove the route ask without a package manager on the test host.
func updateExistsOn(lookPath func(string) (string, error), capture captureRunner) (bool, error) {
	kind, err := detectInstallRoute(lookPath, capture)
	if err != nil {
		// No package manager owns this binary (a checkout build, a
		// downloaded release): there is nothing to offer an update from,
		// and it is not an error worth a status line.
		return false, nil
	}
	return packageHasUpdate(kind, capture)
}

// updateNoticeOptions carries what a notice run reads and where it answers.
// The zero value is not a valid run: home is the one field runStatus always
// sets, and the nil funcs and writer fall back to the production choices so
// a test only overrides what it pins.
type updateNoticeOptions struct {
	home         string
	now          func() time.Time     // nil: time.Now
	updateExists func() (bool, error) // nil: the package manager route
	out          io.Writer            // nil: os.Stdout
	path         string               // nil: updateCheckPath(home)
}

// noticeUpdateOnceADay prints updateNoticeWords when a newer release exists
// and the notice has not printed in the last 24 hours. It never returns an
// error: a failed or corrupt check is quiet, and the next day retries it.
// Returns whether the notice printed.
//
// The read, the probe and the write hold a lock across them, because two
// `drive status` processes on one machine can otherwise both read a
// yesterday stamp, both print, and both write (the notice is throughput, not
// correctness, so a lost lock is a quiet miss and never a failure).
func noticeUpdateOnceADay(o updateNoticeOptions) bool {
	nowFn := o.now
	if nowFn == nil {
		nowFn = time.Now
	}
	existsFn := o.updateExists
	if existsFn == nil {
		existsFn = updateExists
	}
	out := o.out
	if out == nil {
		out = os.Stdout
	}
	path := o.path
	if path == "" {
		path = updateCheckPath(o.home)
	}

	unlock, err := lockUpdateCheck(path + ".lock")
	if err != nil {
		// Tomorrow's run owns the lock unheld; this one stays quiet.
		return false
	}
	defer unlock()

	now := nowFn()
	before := readUpdateCheck(path, now)
	if now.Unix()-before.CheckedAt < int64(updateCheckInterval/time.Second) {
		return false
	}

	newer, err := existsFn()
	rec := updateCheckRecord{CheckedAt: now.Unix(), NotifiedAt: before.NotifiedAt}
	if err != nil {
		// A quiet miss: write the checked-at stamp, so a package manager
		// that will not answer is retried tomorrow rather than on every
		// status run.
		_ = writeUpdateCheck(path, rec)
		return false
	}
	if !newer {
		_ = writeUpdateCheck(path, rec)
		return false
	}

	if now.Unix()-rec.NotifiedAt < int64(updateCheckInterval/time.Second) {
		// Told them today already: keep the fresh check so the next day
		// still knows about it, print nothing.
		_ = writeUpdateCheck(path, rec)
		return false
	}
	rec.NotifiedAt = now.Unix()
	if err := writeUpdateCheck(path, rec); err != nil {
		// The notice printed nothing yet, and writing state failed; printing
		// now would repeat on every status until the file is writable, so
		// stay quiet and let the next run try again.
		return false
	}
	fmt.Fprintln(out, updateNoticeWords)
	return true
}

// readUpdateCheck reads the state file. Anything unreadable or corrupt is the
// zero record: never checked. So is a stamp in the future — a clock rolled
// back, or a state file copied from another machine — because record time is
// the only thing that says "checked", and a future stamp would silence every
// check until the clock caught up with it.
func readUpdateCheck(path string, now time.Time) updateCheckRecord {
	var rec updateCheckRecord
	raw, err := os.ReadFile(path)
	if err != nil {
		return updateCheckRecord{}
	}
	if err := json.Unmarshal(raw, &rec); err != nil {
		return updateCheckRecord{}
	}
	if rec.CheckedAt > now.Unix() || rec.NotifiedAt > now.Unix() {
		return updateCheckRecord{}
	}
	return rec
}

// writeUpdateCheck writes the state file in one atomic replace.
func writeUpdateCheck(path string, rec updateCheckRecord) error {
	raw, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return WriteFileAtomic(path, raw, 0o644)
}

// lockUpdateCheck holds an exclusive lock across one notice run, so a second
// `drive status` cannot also print a notice the first one already decided.
// The lock is a zero-byte file beside the state, and it is never renamed: an
// atomic state write replaces the state file's inode, and a lock on the old
// inode would stop guarding anything.
func lockUpdateCheck(lockPath string) (func(), error) {
	// The lock lives beside the state file, in a directory that may not
	// exist on a machine that has never run a status check.
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := flock(f); err != nil {
		f.Close()
		return nil, err
	}
	return func() {
		flockEnd(f)
		f.Close()
	}, nil
}

