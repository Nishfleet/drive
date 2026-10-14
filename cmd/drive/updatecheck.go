package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const updateNoticeWords = "a newer drive is available: run drive update"

const updateCheckInterval = 24 * time.Hour

func updateCheckPath(home string) string {
	return filepath.Join(filepath.Dir(DefaultCacheDir(home)), "update-check.json")
}

type updateCheckRecord struct {
	CheckedAt  int64 `json:"checkedAt"`
	NotifiedAt int64 `json:"notifiedAt"`
}

func updateExists() (bool, error) {
	return updateExistsOn(defaultLookPath, defaultCapture)
}

func updateExistsOn(lookPath func(string) (string, error), capture captureRunner) (bool, error) {
	kind, err := detectInstallRoute(lookPath, capture)
	if err != nil {
		return false, nil
	}
	return packageHasUpdate(kind, capture)
}

type updateNoticeOptions struct {
	home         string
	now          func() time.Time
	updateExists func() (bool, error)
	probeTimeout time.Duration
	out          io.Writer
	path         string
}

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

	probeTimeout := o.probeTimeout
	if probeTimeout <= 0 {
		probeTimeout = updateProbeTimeout
	}

	unlock, err := lockUpdateCheck(path + ".lock")
	if err != nil {
		return false
	}
	defer unlock()

	now := nowFn()
	before := readUpdateCheck(path, now)
	if now.Unix()-before.CheckedAt < int64(updateCheckInterval/time.Second) {
		return false
	}

	newer, err := updateExistsWithin(existsFn, probeTimeout)
	rec := updateCheckRecord{CheckedAt: now.Unix(), NotifiedAt: before.NotifiedAt}
	if err != nil {
		_ = writeUpdateCheck(path, rec)
		return false
	}
	if !newer {
		_ = writeUpdateCheck(path, rec)
		return false
	}

	if now.Unix()-rec.NotifiedAt < int64(updateCheckInterval/time.Second) {
		_ = writeUpdateCheck(path, rec)
		return false
	}
	rec.NotifiedAt = now.Unix()
	if err := writeUpdateCheck(path, rec); err != nil {
		return false
	}
	fmt.Fprintln(out, updateNoticeWords)
	return true
}

const updateProbeTimeout = 10 * time.Second

func updateExistsWithin(exists func() (bool, error), d time.Duration) (bool, error) {
	type answer struct {
		newer bool
		err   error
	}
	done := make(chan answer, 1)
	go func() {
		newer, err := exists()
		done <- answer{newer: newer, err: err}
	}()
	select {
	case a := <-done:
		return a.newer, a.err
	case <-time.After(d):
		return false, fmt.Errorf("the update check did not answer within %s", d)
	}
}

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

func writeUpdateCheck(path string, rec updateCheckRecord) error {
	raw, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return WriteFileAtomic(path, raw, 0o644)
}

func lockUpdateCheck(lockPath string) (func(), error) {
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
