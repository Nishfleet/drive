package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"html"
	"io/fs"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"
)

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
	switch goos {
	case "darwin":
		return PrefetchLaunchdPlistPath(home)
	case "windows":
		// Windows has no prefetch sidecar: its directory watcher is the stub
		// (prefetch_stub.go), so there is no item to write or stop.
		return ""
	default:
		return PrefetchSystemdUnitPath(home)
	}
}

func PrefetchLoginItem(goos, driveBin, home string) string {
	switch goos {
	case "darwin":
		return prefetchLaunchdPlist(driveBin, home)
	case "windows":
		return ""
	default:
		return prefetchSystemdUnit(driveBin, home)
	}
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
	b.WriteString("\t<key>KeepAlive</key>\n\t<dict>\n")
	b.WriteString("\t\t<key>Crashed</key>\n\t\t<true/>\n")
	b.WriteString("\t</dict>\n")
	b.WriteString("\t<key>ProcessType</key>\n\t<string>Background</string>\n")
	b.WriteString("\t<key>Nice</key>\n\t<integer>19</integer>\n")
	b.WriteString("</dict>\n</plist>\n")
	return b.String()
}

func startPrefetchLoginItem(goos, home, itemPath string) error {
	if !prefetchEnabled() || goos == "windows" {
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
	if goos == "windows" {
		return nil
	}
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
		if _, err := os.Stat(root); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
		}
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
