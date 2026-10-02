//go:build darwin

package main

import (
	"fmt"
	"os"
	"syscall"
	"time"
)

type kqueueWatcher struct {
	kq    int
	root  string
	fds   map[string]int
	files map[string]*os.File
}

func newDirWatcher(root string) (dirWatcher, error) {
	kq, err := syscall.Kqueue()
	if err != nil {
		return nil, fmt.Errorf("kqueue: %w", err)
	}
	w := &kqueueWatcher{kq: kq, root: root, fds: map[string]int{}, files: map[string]*os.File{}}
	if err := w.Add(root); err != nil {
		_ = w.Close()
		return nil, err
	}
	return w, nil
}

func (w *kqueueWatcher) Add(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	fd := int(f.Fd())
	ev := syscall.Kevent_t{
		Ident:  uint64(fd),
		Filter: syscall.EVFILT_VNODE,
		Flags:  syscall.EV_ADD | syscall.EV_CLEAR,
		Fflags: syscall.NOTE_WRITE,
	}
	if _, err := syscall.Kevent(w.kq, []syscall.Kevent_t{ev}, nil, nil); err != nil {
		_ = f.Close()
		return fmt.Errorf("kevent add %s: %w", path, err)
	}
	w.fds[path] = fd
	w.files[path] = f
	return nil
}

func (w *kqueueWatcher) Close() error {
	for _, f := range w.files {
		_ = f.Close()
	}
	return syscall.Close(w.kq)
}

func (w *kqueueWatcher) Next() (watchEvent, error) {
	events := make([]syscall.Kevent_t, 1)
	n, err := syscall.Kevent(w.kq, nil, events, nil)
	if err != nil {
		return watchEvent{}, err
	}
	if n < 1 {
		time.Sleep(10 * time.Millisecond)
		return watchEvent{}, nil
	}
	ev := events[0]
	path := w.root
	for p, fd := range w.fds {
		if uint64(fd) == ev.Ident {
			path = p
			break
		}
	}
	dir := true
	if st, err := os.Stat(path); err == nil {
		dir = st.IsDir()
	}
	if ev.Fflags&syscall.NOTE_WRITE != 0 && dir {
		entries, err := os.ReadDir(path)
		if err == nil {
			for _, e := range entries {
				if e.IsDir() {
					child := path + "/" + e.Name()
					if _, ok := w.fds[child]; !ok {
						_ = w.Add(child)
						return watchEvent{Path: child, Dir: true, CreateDir: true}, nil
					}
				}
			}
		}
		return watchEvent{Path: path, Dir: true, Open: true}, nil
	}
	return watchEvent{Path: path, Dir: dir, Open: true}, nil
}
