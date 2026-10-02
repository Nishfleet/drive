//go:build linux

package main

import (
	"fmt"
	"path/filepath"
	"sync"
	"syscall"
	"unsafe"
)

const inotifyNameMax = 255

type inotifyWatcher struct {
	fd   int
	mu   sync.Mutex
	wd   map[int]string
	path map[string]int
}

func newDirWatcher(root string) (dirWatcher, error) {
	fd, err := syscall.InotifyInit1(syscall.IN_CLOEXEC)
	if err != nil {
		return nil, fmt.Errorf("inotify: %w", err)
	}
	w := &inotifyWatcher{fd: fd, wd: map[int]string{}, path: map[string]int{}}
	if err := w.Add(root); err != nil {
		_ = w.Close()
		return nil, err
	}
	return w, nil
}

func (w *inotifyWatcher) Add(path string) error {
	wd, err := syscall.InotifyAddWatch(w.fd, path, syscall.IN_OPEN|syscall.IN_CREATE|syscall.IN_MOVED_TO|syscall.IN_DELETE_SELF|syscall.IN_MOVE_SELF)
	if err != nil {
		return fmt.Errorf("inotify watch %s: %w", path, err)
	}
	w.mu.Lock()
	w.wd[wd] = path
	w.path[path] = wd
	w.mu.Unlock()
	return nil
}

func (w *inotifyWatcher) Close() error {
	return syscall.Close(w.fd)
}

func (w *inotifyWatcher) Next() (watchEvent, error) {
	buf := make([]byte, syscall.SizeofInotifyEvent+inotifyNameMax+1)
	for {
		n, err := syscall.Read(w.fd, buf)
		if err != nil {
			return watchEvent{}, err
		}
		if n < syscall.SizeofInotifyEvent {
			continue
		}
		raw := (*syscall.InotifyEvent)(unsafe.Pointer(&buf[0]))
		name := ""
		if raw.Len > 0 {
			nameBytes := buf[syscall.SizeofInotifyEvent:n]
			if z := indexNull(nameBytes); z >= 0 {
				name = string(nameBytes[:z])
			} else {
				name = string(nameBytes)
			}
		}
		w.mu.Lock()
		dir := w.wd[int(raw.Wd)]
		w.mu.Unlock()
		path := dir
		if name != "" {
			path = filepath.Join(dir, name)
		}
		mask := raw.Mask
		if mask&syscall.IN_CREATE != 0 && mask&syscall.IN_ISDIR != 0 {
			return watchEvent{Path: path, Dir: true, CreateDir: true}, nil
		}
		if mask&syscall.IN_MOVED_TO != 0 && mask&syscall.IN_ISDIR != 0 {
			return watchEvent{Path: path, Dir: true, CreateDir: true}, nil
		}
		if mask&syscall.IN_OPEN != 0 {
			return watchEvent{Path: path, Dir: mask&syscall.IN_ISDIR != 0, Open: true}, nil
		}
	}
}

func indexNull(b []byte) int {
	for i, v := range b {
		if v == 0 {
			return i
		}
	}
	return -1
}
