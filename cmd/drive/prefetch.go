package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"html"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
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
)

type prefetchTarget struct {
	Path string
	Dir  bool
	Size int64
}

type watchEvent struct {
	Path      string
	Dir       bool
	Open      bool
	CreateDir bool
}

type dirWatcher interface {
	Next() (watchEvent, error)
	Add(string) error
	Close() error
}

var (
	prefetchUserBusy atomic.Bool
	prefetchSelfOps  atomic.Int32
)

func prefetchEnabled() bool { return os.Getenv("DRIVE_PREFETCH") != "0" }

func PrefetchLoginItemPath(goos, home string) string {
	if goos == "darwin" {
		return PrefetchLaunchdPlistPath(home)
	}
	return PrefetchSystemdUnitPath(home)
}

func PrefetchLoginItem(goos, driveBin, home string) string {
	if goos == "darwin" {
		return prefetchLaunchdPlist(driveBin, home)
	}
	return prefetchSystemdUnit(driveBin, home)
}

func prefetchSystemdUnit(driveBin, home string) string {
	execStart := systemdEscapeArg(driveBin) + " prefetch --home " + systemdEscapeArg(home)
	return fmt.Sprintf(`[Unit]
Description=drive: prefetch the next folder at low priority
After=%s
PartOf=%s
BindsTo=%s

[Service]
Type=simple
Nice=19
IOSchedulingClass=idle
ExecStart=%s
Restart=on-failure
RestartSec=5

[Install]
WantedBy=%s
`, SystemdUnitName, SystemdUnitName, SystemdUnitName, execStart, SystemdUnitName)
}

func prefetchLaunchdPlist(driveBin, home string) string {
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	b.WriteString("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	b.WriteString("<plist version=\"1.0\">\n<dict>\n")
	fmt.Fprintf(&b, "\t<key>Label</key>\n\t<string>%s</string>\n", html.EscapeString(PrefetchLaunchdLabel))
	b.WriteString("\t<key>ProgramArguments</key>\n\t<array>\n")
	for _, a := range []string{driveBin, "prefetch", "--home", home} {
		fmt.Fprintf(&b, "\t\t<string>%s</string>\n", html.EscapeString(a))
	}
	b.WriteString("\t</array>\n")
	b.WriteString("\t<key>RunAtLoad</key>\n\t<true/>\n")
	b.WriteString("\t<key>KeepAlive</key>\n\t<true/>\n")
	b.WriteString("\t<key>ProcessType</key>\n\t<string>Background</string>\n")
	b.WriteString("\t<key>Nice</key>\n\t<integer>19</integer>\n")
	b.WriteString("</dict>\n</plist>\n")
	return b.String()
}

func startPrefetchLoginItem(goos, home, itemPath string) error {
	if !prefetchEnabled() {
		return nil
	}
	if goos == "darwin" {
		return bootstrapLaunchdLabel(PrefetchLaunchdLabel, itemPath)
	}
	for _, action := range []string{"daemon-reload", "enable", "restart"} {
		args := []string{"--user", action}
		if action != "daemon-reload" {
			args = append(args, PrefetchSystemdUnitName)
		}
		if err := exec.Command("systemctl", args...).Run(); err != nil {
			return fmt.Errorf("systemctl %s: %w", strings.Join(args, " "), err)
		}
	}
	return nil
}

func stopPrefetchLoginItem(goos, home string) error {
	itemPath := PrefetchLoginItemPath(goos, home)
	if _, err := os.Stat(itemPath); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("stat %s: %w", itemPath, err)
	}
	if goos == "darwin" {
		return bootoutLaunchdLabel(PrefetchLaunchdLabel, itemPath)
	}
	if err := exec.Command("systemctl", "--user", "disable", "--now", PrefetchSystemdUnitName).Run(); err != nil {
		return fmt.Errorf("systemctl --user disable --now %s: %w", PrefetchSystemdUnitName, err)
	}
	return nil
}

func runPrefetch(args []string) error {
	fs := flag.NewFlagSet("prefetch", flag.ContinueOnError)
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if !prefetchEnabled() {
		return nil
	}
	return runPrefetchLoop(context.Background(), DefaultMountDir(common.home))
}

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
	out, err := exec.Command("nmcli", "-t", "-f", "GENERAL.METERED", "g").CombinedOutput()
	if err != nil {
		return false
	}
	return parseNMMetered(string(out))
}

func runPrefetchLoop(ctx context.Context, root string) error {
	deadline := time.Now().Add(mountWait)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if st, err := os.Stat(root); err == nil && st.IsDir() {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("prefetch: mount dir %s did not appear within %s", root, mountWait)
		}
		time.Sleep(50 * time.Millisecond)
	}
	w, err := newDirWatcher(root)
	if err != nil {
		return err
	}
	defer w.Close()
	go func() {
		<-ctx.Done()
		_ = w.Close()
	}()
	for {
		ev, err := w.Next()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, fs.ErrClosed) || errors.Is(err, os.ErrClosed) {
				return nil
			}
			return err
		}
		if ev.CreateDir {
			if addErr := w.Add(ev.Path); addErr != nil {
				fmt.Fprintf(os.Stderr, "drive: prefetch watch %s: %v\n", ev.Path, addErr)
			}
			continue
		}
		if !ev.Open {
			continue
		}
		if prefetchSelfOps.Load() > 0 {
			continue
		}
		if !ev.Dir {
			prefetchUserBusy.Store(true)
			time.AfterFunc(250*time.Millisecond, func() { prefetchUserBusy.Store(false) })
			continue
		}
		if shouldSkipPrefetch(connectionMetered(), prefetchUserBusy.Load()) {
			continue
		}
		_ = prefetchOnce(ev.Path)
	}
}

func prefetchOnce(dir string) error {
	if shouldSkipPrefetch(connectionMetered(), prefetchUserBusy.Load()) {
		return nil
	}
	prefetchSelfOps.Add(1)
	defer prefetchSelfOps.Add(-1)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	targets := planPrefetch(dir, entries, prefetchMaxEntries, prefetchMaxBytes, prefetchChunk, prefetchSmallFile)
	for _, t := range targets {
		if shouldSkipPrefetch(false, prefetchUserBusy.Load()) {
			return nil
		}
		started := time.Now()
		var n int
		if t.Dir {
			kids, readErr := os.ReadDir(t.Path)
			if readErr != nil {
				return readErr
			}
			n = len(kids)
		} else {
			got, readErr := readFirstChunk(t.Path, prefetchChunk)
			if readErr != nil {
				return readErr
			}
			n = got
		}
		throttlePrefetch(n, started)
	}
	return nil
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
