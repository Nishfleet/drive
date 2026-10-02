//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPrefetchWatcherSeesDirectoryOpen(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "child"), 0o755); err != nil {
		t.Fatal(err)
	}
	w, err := newDirWatcher(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	got := make(chan watchEvent, 1)
	errCh := make(chan error, 1)
	go func() {
		ev, err := w.Next()
		if err != nil {
			errCh <- err
			return
		}
		got <- ev
	}()
	time.Sleep(20 * time.Millisecond)
	f, err := os.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	select {
	case err := <-errCh:
		t.Fatal(err)
	case ev := <-got:
		if !ev.Open || !ev.Dir {
			t.Fatalf("event = %+v, want a directory open", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("watcher did not see the directory open")
	}
}
