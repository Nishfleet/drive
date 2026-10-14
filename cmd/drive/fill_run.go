package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const loopbackRCAddr = "127.0.0.1:5572"

// FillResult is what one fill pass did, so `drive status` and the test can read what happened without re-running it.
type FillResult struct {
	Refreshed   bool
	Idle        bool
	BytesBefore int64
	BytesAfter  int64
	CapBytes    int64
}

// Ran reports whether the pass did anything.
func (r FillResult) Ran() bool { return r.Refreshed }

type fillBackend interface {
	stats(ctx context.Context) (vfsStats, error)
	refresh(ctx context.Context, recursive bool) error
	refreshDirs(ctx context.Context, dirs []string) error
	// vfs/refresh marks the directory cache stale before re-listing, so refreshing while storage is down fails later opens (https://github.com/rclone/rclone/issues/1963).
	reachable(ctx context.Context) error
	remote() string
}

func fillPass(ctx context.Context, c fillBackend, targets fillTargets, load1, load5 float64) (FillResult, error) {
	var res FillResult
	before, err := c.stats(ctx)
	if err != nil {
		return res, fmt.Errorf("fill: read cache stats: %w", err)
	}
	beforeBytes, err := liveCacheBytes(before.DiskCache.Path, before.DiskCache.BytesUsed)
	if err != nil {
		return res, fmt.Errorf("fill: %w", err)
	}
	res.BytesBefore = beforeBytes
	res.CapBytes = before.Opt.CacheMaxSize

	atCap := res.CapBytes > 0 && res.BytesBefore >= res.CapBytes
	idle := MachineIdle(load1, load5)
	offline := len(targets.offline) > 0
	res.Idle = ShouldFill(offline, load1, load5)
	storageUp := c.reachable(ctx) == nil
	fillRecent := storageUp && idle && !atCap && len(targets.recent) > 0
	if storageUp {
		if err := c.refresh(ctx, false); err != nil {
			return res, fmt.Errorf("fill: refresh directory cache: %w", err)
		}
		if dirs := listingDirs(targets); len(dirs) > 0 {
			if err := c.refreshDirs(ctx, dirs); err != nil {
				return res, fmt.Errorf("fill: refresh the folders: %w", err)
			}
		}
	}
	if !offline && !fillRecent {
		return res, nil
	}
	res.Refreshed = true

	budget := fillPassBudget
	if res.CapBytes > 0 {
		if head := res.CapBytes - res.BytesBefore; head < budget {
			budget = head
		}
	}
	if targets.opens != nil && res.CapBytes > 0 {
		if left := res.CapBytes - targets.opens.windowBytes(); left < budget {
			budget = left
		}
	}
	if budget < 0 {
		budget = 0
	}
	recentBytes, err := targets.read(ctx, fillRecent, budget)
	if err != nil {
		return res, fmt.Errorf("fill: read into cache: %w", err)
	}

	after, err := c.stats(ctx)
	if err != nil {
		return res, fmt.Errorf("fill: read cache stats after fill: %w", err)
	}
	afterBytes, err := liveCacheBytes(after.DiskCache.Path, after.DiskCache.BytesUsed)
	if err != nil {
		return res, fmt.Errorf("fill: %w", err)
	}
	res.BytesAfter = afterBytes
	if fillRecent && res.CapBytes > 0 && res.BytesBefore+recentBytes > res.CapBytes {
		return res, fmt.Errorf("fill: cache %s is over the %s cap; refusing to fill further",
			FormatBytes(res.BytesBefore+recentBytes), FormatBytes(res.CapBytes))
	}
	return res, nil
}

func listingDirs(targets fillTargets) []string {
	seen := map[string]struct{}{}
	var dirs []string
	add := func(rel string) {
		rel = strings.Trim(rel, "/")
		if rel == "" || rel == "." {
			return
		}
		if _, ok := seen[rel]; ok {
			return
		}
		seen[rel] = struct{}{}
		dirs = append(dirs, rel)
	}
	consider := func(rel string) {
		full := filepath.Join(targets.root, filepath.FromSlash(rel))
		info, err := os.Stat(full)
		if err == nil && info.IsDir() {
			add(rel)
			return
		}
		parent := path.Dir(strings.Trim(rel, "/"))
		if parent != "." && parent != "/" {
			add(parent)
		}
	}
	for _, rel := range targets.offline {
		consider(rel)
	}
	for _, rel := range targets.recent {
		consider(rel)
	}
	sort.Strings(dirs)
	return dirs
}

// vfs/stats diskCache.bytesUsed is only refreshed on rclone's cache poll, so it reads 0 right after a fill.
func liveCacheBytes(path string, reported int64) (int64, error) {
	if path == "" {
		return reported, nil
	}
	var total int64
	err := filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		total += info.Size()
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("measure the VFS cache at %s: %w", path, err)
	}
	return total, nil
}

func readLoadAverages() (float64, float64, error) {
	if runtime.GOOS == "darwin" {
		// macOS has no /proc; `sysctl vm.loadavg` gives the same numbers.
		out, err := exec.Command("sysctl", "-n", "vm.loadavg").Output()
		if err != nil {
			return 0, 0, fmt.Errorf("read vm.loadavg: %w", err)
		}
		return parseDarwinLoadAverages(string(out))
	}
	return readLoadAveragesFrom("/proc/loadavg")
}

func parseDarwinLoadAverages(out string) (float64, float64, error) {
	fields := strings.Fields(strings.Trim(strings.TrimSpace(out), "{}"))
	if len(fields) < 2 {
		return 0, 0, fmt.Errorf("vm.loadavg %q has no one- and five-minute averages", strings.TrimSpace(out))
	}
	one, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, 0, fmt.Errorf("vm.loadavg one-minute average %q: %w", fields[0], err)
	}
	five, err := strconv.ParseFloat(fields[1], 64)
	if err != nil {
		return 0, 0, fmt.Errorf("vm.loadavg five-minute average %q: %w", fields[1], err)
	}
	return one, five, nil
}

func readLoadAveragesFrom(path string) (float64, float64, error) {
	b, err := readFileTrimmed(path)
	if err != nil {
		return 0, 0, err
	}
	fields := strings.Fields(b)
	if len(fields) < 2 {
		return 0, 0, fmt.Errorf("%s: %q has no one- and five-minute averages", path, b)
	}
	one, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, 0, fmt.Errorf("%s one-minute average %q: %w", path, fields[0], err)
	}
	five, err := strconv.ParseFloat(fields[1], 64)
	if err != nil {
		return 0, 0, fmt.Errorf("%s five-minute average %q: %w", path, fields[1], err)
	}
	return one, five, nil
}

func readFileTrimmed(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	return strings.TrimSpace(string(b)), nil
}

const fillRecentAge = 24 * time.Hour

const fillPassBudget int64 = 1 << 30

const fillSelfGrace = 5 * time.Second

type recentOpens struct {
	mu     sync.Mutex
	opened map[string]time.Time
	filled map[string]time.Time
	sizes  map[string]int64
	bytes  int64
}

var mountOpens = &recentOpens{opened: map[string]time.Time{}, filled: map[string]time.Time{}, sizes: map[string]int64{}}

func (r *recentOpens) record(path string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if t, ok := r.filled[path]; ok && time.Since(t) < fillSelfGrace {
		return
	}
	r.opened[path] = time.Now()
}

func (r *recentOpens) markFilled(path string, n int64) {
	r.mu.Lock()
	if r.sizes == nil {
		r.sizes = map[string]int64{}
	}
	if _, ok := r.filled[path]; !ok {
		r.bytes += n
	}
	r.filled[path] = time.Now()
	r.sizes[path] = n
	r.mu.Unlock()
}

func (r *recentOpens) windowBytes() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.bytes
}

func (r *recentOpens) since(root string, now time.Time, age time.Duration) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for p, t := range r.opened {
		if now.Sub(t) > age {
			delete(r.opened, p)
			continue
		}
		if ft, ok := r.filled[p]; ok {
			if now.Sub(ft) <= age {
				continue
			}
			delete(r.filled, p)
		}
		rel, err := filepath.Rel(root, p)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		out = append(out, filepath.ToSlash(rel))
	}
	for p, ft := range r.filled {
		if now.Sub(ft) > age {
			delete(r.filled, p)
			if n, ok := r.sizes[p]; ok {
				r.bytes -= n
				delete(r.sizes, p)
			}
		}
	}
	sort.Strings(out)
	return out
}

func (r *recentOpens) forget(path string) {
	r.mu.Lock()
	delete(r.opened, path)
	r.mu.Unlock()
}

type fillTargets struct {
	root     string
	offline  []string
	recent   []string
	opens    *recentOpens
	readFile func(context.Context, string) (int64, error)
}

func (t fillTargets) read(ctx context.Context, includeRecent bool, budget int64) (int64, error) {
	var spent int64
	if includeRecent && budget > 0 {
		read := t.readFile
		if read == nil {
			read = fillReadFile
		}
		for _, rel := range t.recent {
			if err := ctx.Err(); err != nil {
				return spent, err
			}
			if spent >= budget {
				break
			}
			abs := filepath.Join(t.root, filepath.FromSlash(rel))
			n, err := read(ctx, abs)
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					if t.opens != nil {
						t.opens.forget(abs)
					}
					continue
				}
				return spent, err
			}
			spent += n
			if t.opens != nil {
				t.opens.markFilled(abs, n)
			}
		}
	}
	for _, rel := range t.offline {
		if err := ctx.Err(); err != nil {
			return spent, err
		}
		if _, err := KeepOffline(ctx, t.root, rel); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return spent, err
		}
	}
	return spent, nil
}

const fillReadChunk = 128 << 10

func fillReadFile(ctx context.Context, path string) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, fmt.Errorf("open %s to fill: %w", path, err)
	}
	defer f.Close()
	n, err := readCtxChunked(ctx, f)
	if err != nil {
		return n, fmt.Errorf("read %s to fill: %w", path, err)
	}
	return n, nil
}

func readCtxChunked(ctx context.Context, f io.Reader) (int64, error) {
	buf := make([]byte, fillReadChunk)
	var n int64
	for {
		if err := ctx.Err(); err != nil {
			return n, err
		}
		got, err := f.Read(buf)
		n += int64(got)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return n, nil
			}
			if ctxErr := ctx.Err(); ctxErr != nil {
				return n, ctxErr
			}
			return n, err
		}
	}
}

const fillInterval = time.Minute

const fillContextTimeout = 30 * time.Second

const offlineFillInterval = 10 * time.Second

// RunFillLoop is the background fill, running inside the mount process for as long as the mount does.
func RunFillLoop(ctx context.Context, c *rcClient, home, mountDir string) <-chan error {
	errs := make(chan error, 1)
	go func() {
		defer close(errs)
		if mountDir == "" {
			mountDir = DefaultMountDir(home)
		}
		for {
			targets := fillTargets{root: mountDir, opens: mountOpens}
			idx, err := LoadOffline(home)
			if err != nil {
				select {
				case errs <- fmt.Errorf("fill pass: %w", err):
				default:
				}
			} else {
				targets.offline = idx.Paths
			}
			targets.recent = mountOpens.since(mountDir, time.Now(), fillRecentAge)
			interval := fillInterval
			if len(targets.offline) > 0 {
				interval = offlineFillInterval
			}
			timer := time.NewTimer(interval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			passCtx, cancel := context.WithTimeout(ctx, fillContextTimeout)
			load1, load5, err := readLoadAverages()
			if err != nil {
				cancel()
				select {
				case errs <- fmt.Errorf("fill pass: %w", err):
				default:
				}
				continue
			}
			_, err = fillPass(passCtx, c, targets, load1, load5)
			cancel()
			if err != nil {
				select {
				case errs <- fmt.Errorf("fill pass: %w", err):
				default:
				}
			}
		}
	}()
	return errs
}
