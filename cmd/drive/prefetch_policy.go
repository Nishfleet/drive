package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Prefetch caps (issue #227). N entries and M bytes per listed folder; the
// first-chunk size matches --vfs-read-ahead. The bandwidth share is 1 MiB/s so
// prefetch never takes the pipe from a user's own read; --bwlimit is not set
// on the mount because that flag would slow the user too.
const (
	prefetchMaxEntries = 32
	prefetchMaxBytes   = 8 << 20
	prefetchChunk      = 128 << 10
	prefetchSmallFile  = 1 << 20
	prefetchShareBPS   = 1 << 20
	meteredCacheFor    = 30 * time.Second
)

type prefetchTarget struct {
	Path string
	Dir  bool
	Size int64
}

var (
	meteredMu  sync.Mutex
	meteredAt  time.Time
	meteredVal bool
)

// planPrefetch picks child directories to list and small files to warm, dirs
// first, under the N/M caps. It is the only policy: the watcher just calls it.
func planPrefetch(parent string, entries []os.DirEntry, maxN int, maxBytes, chunk, smallMax int64) []prefetchTarget {
	var (
		dirs, files []prefetchTarget
		bytes       int64
	)
	for _, e := range entries {
		if e.Name() == "." || e.Name() == ".." {
			continue
		}
		p := filepath.Join(parent, e.Name())
		if e.IsDir() {
			dirs = append(dirs, prefetchTarget{Path: p, Dir: true})
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if !info.Mode().IsRegular() || info.Size() > smallMax {
			continue
		}
		add := chunk
		if info.Size() < add {
			add = info.Size()
		}
		if bytes+add > maxBytes {
			continue
		}
		bytes += add
		files = append(files, prefetchTarget{Path: p, Size: info.Size()})
	}
	out := make([]prefetchTarget, 0, maxN)
	for _, t := range dirs {
		if len(out) >= maxN {
			return out
		}
		out = append(out, t)
	}
	for _, t := range files {
		if len(out) >= maxN {
			return out
		}
		out = append(out, t)
	}
	return out
}

func shouldSkipPrefetch(metered, userBusy bool) bool { return metered || userBusy }

func parseNMMetered(out string) bool {
	s := strings.TrimSpace(out)
	if i := strings.LastIndex(s, ":"); i >= 0 {
		s = s[i+1:]
	}
	return s == "yes" || s == "guess-yes"
}

func connectionMetered() bool {
	meteredMu.Lock()
	defer meteredMu.Unlock()
	if !meteredAt.IsZero() && time.Since(meteredAt) < meteredCacheFor {
		return meteredVal
	}
	out, err := exec.Command("nmcli", "-t", "-f", "GENERAL.METERED", "g").CombinedOutput()
	if err != nil {
		meteredAt, meteredVal = time.Now(), false
		return false
	}
	meteredVal = parseNMMetered(string(out))
	meteredAt = time.Now()
	return meteredVal
}

func readFirstChunk(path string, n int64) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	buf := make([]byte, n)
	got, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return got, err
	}
	return got, nil
}

func throttlePrefetch(bytes int, started time.Time) {
	if bytes <= 0 || prefetchShareBPS <= 0 {
		return
	}
	want := time.Duration(bytes) * time.Second / time.Duration(prefetchShareBPS)
	if elapsed := time.Since(started); elapsed < want {
		time.Sleep(want - elapsed)
	}
}
