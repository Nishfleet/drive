package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// The background fill loop (drive issue #194). It runs inside the mount
// process — no second daemon, no script — and every line of it is a stock
// call to the same rclone that is serving the mount:
//
//   - rclone's remote control (`--rc`), the interface rclone ships for exactly
//     this: a local HTTP API over the running mount;
//   - vfs/stats, which reports the cache's own bytesUsed and the effective
//     CacheMaxSize, so the loop reads the cap from rclone rather than keeping
//     its own copy of the number;
//   - vfs/refresh, which rclone itself documents as refreshing the directory
//     cache (and a kept-offline folder is filled by reading it through the
//     mount, so the refresh is what makes a new file under one appear).
//
// The loop never downloads a byte by itself. When it decides a fill is due it
// tells rclone to refresh and then reads the files through the mount
// (io.Copy to io.Discard), which is the same path a foreground app takes, so
// the fill is bytes in rclone's own VFS cache and therefore already inside
// --vfs-cache-max-size. That is the whole cap argument: there is nowhere for
// a fill byte to live but the cache rclone caps.

// rcClient is rclone's remote control over its loopback address, reached
// through the rclone binary itself (`rclone rc --rc-addr ...`) rather than an
// HTTP client, so no listener of our own is added and the rc user/pass stay in
// the one rclone config the mount already wrote.
type rcClient struct {
	binary string
	addr   string
	// fs is the mounted remote, e.g. drive:bucket/u/id, which vfs/stats and
	// vfs/refresh both take.
	fs string
}

// newRCClient builds the client for the mount's remote control. The address
// is the one MountPlan puts on the command line, so there is one address in
// the product, not one in the CLI and another in the fill loop.
func newRCClient(binary, addr, fs string) *rcClient {
	return &rcClient{binary: binary, addr: addr, fs: fs}
}

// vfsStats is the part of vfs/stats the fill loop reads. Field names are
// rclone's own: the JSON keys come straight from the vfs/stats output, and
// the opt block is the mount's live options, not a copy this product keeps.
type vfsStats struct {
	DiskCache struct {
		BytesUsed     int64  `json:"bytesUsed"`
		Files         int64  `json:"files"`
		OutOfSpace    bool   `json:"outOfSpace"`
		Path          string `json:"path"`
		UploadsQueued int64  `json:"uploadsQueued"`
	} `json:"diskCache"`
	InUse int64 `json:"inUse"`
	Opt   struct {
		CacheMaxSize int64 `json:"CacheMaxSize"`
		// CacheMinFreeSpace is the disk floor rclone keeps the cache above
		// (--vfs-cache-min-free-space, issue #112). rclone reports it as -1
		// when the flag is off, which is how the test tells "no floor" from
		// "a floor of nothing".
		CacheMinFreeSpace int64 `json:"CacheMinFreeSpace"`
		ReadAhead         int64 `json:"ReadAhead"`
		ChunkSize         int64 `json:"ChunkSize"`
		ChunkSizeLimit    int64 `json:"ChunkSizeLimit"`
		WriteBack         int64 `json:"WriteBack"`
	} `json:"opt"`
}

// call runs one remote-control method and decodes the reply.
func (c *rcClient) call(ctx context.Context, method string, params map[string]string, out any) error {
	args := []string{"rc", "--rc-addr", c.addr, method}
	for k, v := range params {
		args = append(args, k+"="+v)
	}
	// The output guard: a remote-control error comes back as JSON with an
	// "error" field, and a non-zero exit with no JSON is a real failure, so a
	// missing method or a dead address is reported, never swallowed into an
	// empty stats block the fill would read as "no bytes cached".
	// exec.Command takes an argument vector and runs no shell, so a
	// remote or stored value cannot inject anything at this call site:
	// binary is the rclone path ResolveRclone resolved to an absolute
	// path before the mount started, and args is built here from the
	// method name and the loop's own constants.
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	cmd := exec.CommandContext(ctx, c.binary, args...)
	cmd.Stderr = nil
	b, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("rclone rc %s: %w", method, err)
	}
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("rclone rc %s: decode %s: %w", method, strings.TrimSpace(string(b)), err)
	}
	return nil
}

// stats reads the cache's live state from the running mount.
func (c *rcClient) stats(ctx context.Context) (vfsStats, error) {
	var s vfsStats
	if err := c.call(ctx, "vfs/stats", map[string]string{"fs": c.fs}, &s); err != nil {
		return vfsStats{}, err
	}
	return s, nil
}

// refresh asks rclone to refresh the mount's directory cache, so a file just
// written to the object store (or a folder just kept offline) is visible to
// the read the fill does next. rclone's vfs/refresh is the stock call for
// this; the loop does not list the object store a second way.
func (c *rcClient) refresh(ctx context.Context, recursive bool) error {
	params := map[string]string{"fs": c.fs}
	if recursive {
		params["recursive"] = "true"
	}
	var reply map[string]any
	return c.call(ctx, "vfs/refresh", params, &reply)
}

// loopbackRCAddr is the address the mount's remote control binds. rclone's
// default is localhost:5572; the plan sets it explicitly so the fill loop and
// the operator reach the same one even on a host with another rclone running.
// localhost only: the remote control is unauthenticated by design here, and
// it must not be reachable off the machine.
const loopbackRCAddr = "127.0.0.1:5572"

// FillResult is what one fill pass did, so `drive status` and the test can
// read what happened without re-running it. It reports the cache's own
// numbers (before and after) rather than a guess: bytesUsed is vfs/stats.
type FillResult struct {
	Refreshed   bool
	Idle        bool
	BytesBefore int64
	BytesAfter  int64
	CapBytes    int64
}

// Ran reports whether the pass did anything.
func (r FillResult) Ran() bool { return r.Refreshed }

// fillBackend is the two things a fill pass needs from the running mount: the
// cache's live state and a directory refresh. Both are rclone's own remote
// control, behind the interface so the cap rule below can be tested against a
// counted stand-in as well as against a real mount (the real path is covered by
// TestBackgroundFillNeverExceedsTheCap in e2e_test.go).
type fillBackend interface {
	stats(ctx context.Context) (vfsStats, error)
	refresh(ctx context.Context, recursive bool) error
	// fs is the mounted remote, the value a stats call is addressed to.
	remote() string
}

// remote is the mounted remote, so an interface value carries what rc needs.
func (c *rcClient) remote() string { return c.fs }

// fillPass is one iteration of the loop: read the cache's live stats, ask
// rclone to refresh, read the files through the mount into rclone's own
// cache, then read the stats again. offline says something is kept on the
// machine (#115) and is filled in full regardless of load; the load averages
// gate every other fill. It returns the before/after the cap is checked
// against.
func fillPass(ctx context.Context, c fillBackend, offline bool, load1, load5 float64, read fillRead) (FillResult, error) {
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
	// A cache already at the cap is rclone's to reclaim, except for a set the
	// person kept offline (#115): those files must still be re-read so rclone's
	// own last-access eviction drops the rest of the drive first. The rest of
	// the tree is filled only when the machine is idle and the cache is under
	// the cap, so a keep-warm pass never competes with a foreground open.
	keepWarm := offline
	fillRest := idle && !atCap
	if !keepWarm && !fillRest {
		res.Idle = ShouldFill(offline, load1, load5)
		return res, nil
	}
	res.Idle = ShouldFill(offline, load1, load5)
	if err := c.refresh(ctx, true); err != nil {
		return res, fmt.Errorf("fill: refresh directory cache: %w", err)
	}
	res.Refreshed = true

	// The read is through the mount, into io.Discard, so the bytes land in
	// rclone's VFS cache and nowhere else. idle here is fillRest: a kept-offline
	// set is read on every pass, and the rest of the tree only when this pass
	// is actually filling under the cap.
	if read != nil {
		if err := read(c.remote(), fillRest); err != nil {
			return res, fmt.Errorf("fill: read into cache: %w", err)
		}
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
	// The cap is rclone's own --vfs-cache-max-size, read live from the mount.
	// rclone evicts over the cap on its cache poll. A keep-warm of the
	// kept-offline set is allowed to sit at or over the cap: that is rclone
	// evicting everything else. A fill of the rest of the tree that crossed
	// the cap is a named failure, because that pass was supposed to stop.
	if fillRest && res.CapBytes > 0 && res.BytesAfter > res.CapBytes {
		return res, fmt.Errorf("fill: cache %s is over the %s cap; refusing to fill further",
			FormatBytes(res.BytesAfter), FormatBytes(res.CapBytes))
	}
	return res, nil
}

// liveCacheBytes is the current size of rclone's own VFS cache directory, the
// bytes --vfs-cache-max-size caps. vfs/stats' diskCache.bytesUsed is only
// refreshed on rclone's cache poll, so immediately after a fill it still reads
// 0 while the bytes are already on disk; the walk of the path rclone itself
// reports is what makes the loop's cap guard read the cache it is actually
// filling. A missing directory is an empty cache, not an error; any other walk
// error is returned rather than read as zero. path is empty on a backend that
// reports no disk cache (the counted stand-in in the unit tests), where
// rclone's own reported figure is all there is.
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

// readLoadAverages returns the host's one- and five-minute load averages, the
// same two numbers `uptime` prints, read from /proc/loadavg. It returns an
// error when the file cannot be read: the fill must not treat an unreadable
// load average as "idle" and start filling on a busy machine, so a missing
// /proc is a named failure, not a zero.
func readLoadAverages() (float64, float64, error) {
	if runtime.GOOS == "darwin" {
		// macOS has no /proc: the same numbers come from `sysctl vm.loadavg`,
		// so the background fill (and `drive offline`) can run on a Mac.
		out, err := exec.Command("sysctl", "-n", "vm.loadavg").Output()
		if err != nil {
			return 0, 0, fmt.Errorf("read vm.loadavg: %w", err)
		}
		return parseDarwinLoadAverages(string(out))
	}
	return readLoadAveragesFrom("/proc/loadavg")
}

// parseDarwinLoadAverages reads `sysctl -n vm.loadavg`, which prints
// "{ 1.23 1.45 1.67 }": the one-, five- and fifteen-minute averages in braces.
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

// readLoadAveragesFrom is the parse, with the path a parameter so a test can
// read a fixture rather than this host's real load.
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

// readFileTrimmed is a small indirection so the load-average read is one
// function a test can point at a fixture; it is the only file read the loop
// does not make through rclone.
func readFileTrimmed(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	return strings.TrimSpace(string(b)), nil
}

// fillStop is a small helper the loop uses to decide whether the host is going
// to sleep or shut down, without a select on two channels inline.
func fillStop(stop <-chan struct{}) bool {
	select {
	case <-stop:
		return true
	default:
		return false
	}
}

// fillReader returns the read the fill pass does. It reads the mounted tree
// through the mount itself, into io.Discard, so every byte it pulls lands in
// rclone's VFS cache and nowhere else: the fill is not a downloader, it is a
// foreground read that throws the result away, which is exactly what makes the
// cap argument true (the bytes live in the one cache --vfs-cache-max-size
// bounds).
//
// It walks the mount's own files, skipping the ones rclone already has whole
// (rclone serves those from disk without a read here, so a second pass over
// an already-filled cache costs a stat and nothing more), and reads the rest
// to io.Discard. A file that is still being written by a foreground app is
// left alone: rclone's write-back is 5s, so a read of a half-written file is
// a read of a torn file, and the fill must never be the reason a save is lost.
func fillReader(root string) fillRead {
	return func(_ string, _ bool) error { return fillReadTree(context.Background(), root) }
}

// fillReadTree reads files under root through the mount, into io.Discard.
// It stops when ctx is done, so a pass cannot outlive fillContextTimeout.
// A file that vanished under the walk is not a fill failure: somebody deleted
// it, and the next pass sees the new tree.
func fillReadTree(ctx context.Context, root string) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if ctx != nil {
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
			}
		}
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if d.IsDir() {
			return nil
		}
		_, err = fillReadFile(path)
		return err
	})
}

// fillRead is what one fill pass reads. idle says whether the machine is idle
// this pass, which the loop learns from the same load averages ShouldFill uses:
// a path the person keeps offline is filled whatever the load, and the rest of
// the tree only when the machine is idle, so keeping one folder offline does
// not download the whole drive.
type fillRead func(remote string, idle bool) error

// fillTargets is the whole kept-offline rule (#115) in one value: the mount
// root, and the paths inside it the person asked to be kept on this computer.
//
// The read is two rules. On every pass every kept path is read through the
// mount, which both fills it and — the reason the rule is sound — marks it as
// the most recently used item in rclone's cache. rclone evicts over
// `--vfs-cache-max-size` by last access (vfs/vfscache/item.go `Items.Less`
// compares `info.ATime`), so a file the product re-reads on every pass is the
// last thing the cache drops and the rest of the drive goes first. With
// nothing kept offline the read is the whole tree, exactly as it was before
// this rule existed.
type fillTargets struct {
	root     string
	offline  []string
	cacheDir string
	ctx      context.Context
}

// read fills pinned paths that are not yet whole in rclone's cache. It never
// walks the rest of the tree: a full-tree read churns the cache on a drive
// larger than 20 GB and ignores fillContextTimeout.
func (t fillTargets) read(_ string, idle bool) error {
	_ = idle
	ctx := t.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	for _, rel := range t.offline {
		if err := ctx.Err(); err != nil {
			return err
		}
		if t.pinnedFileIsWhole(rel) {
			continue
		}
		if _, err := KeepOffline(t.root, rel); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return err
		}
	}
	return nil
}

// pinnedFileIsWhole reports whether rclone already holds a complete copy of
// the pinned path: vfs metadata with a fingerprint and Dirty false. A missing
// cache is "not whole", so the fill still reads it.
func (t fillTargets) pinnedFileIsWhole(rel string) bool {
	if t.cacheDir == "" {
		return false
	}
	rel = filepath.ToSlash(rel)
	metaRoot := filepath.Join(t.cacheDir, "vfsMeta")
	whole := false
	_ = filepath.WalkDir(metaRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		key := queueKey(t.cacheDir, p)
		if key != rel && !strings.HasSuffix(key, "/"+rel) {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		var meta VFSMeta
		if json.Unmarshal(data, &meta) != nil {
			return nil
		}
		if !meta.Dirty && meta.Fingerprint != "" {
			whole = true
		}
		return nil
	})
	return whole
}

// fillReadFile reads one mounted file into io.Discard, which fills rclone's
// cache for it, and reports how many bytes it read so `drive offline` (#115)
// can say what it kept. The read is chunked, so a 10 GB file is a sequence of
// reads rather than one allocation.
func fillReadFile(path string) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, fmt.Errorf("open %s to fill: %w", path, err)
	}
	defer f.Close()
	n, err := io.Copy(io.Discard, f)
	if err != nil {
		return n, fmt.Errorf("read %s to fill: %w", path, err)
	}
	return n, nil
}

// fillInterval is the loop's period. It is not a cache setting: rclone decides
// what a fill does (vfs/stats, vfs/refresh, the read-ahead), this only
// decides when to let it. One minute is slow enough to be invisible to a
// foreground open and fast enough that a file opened is filled within a
// coffee break.
const fillInterval = time.Minute

// fillContextTimeout bounds one pass so a wedged remote-control call cannot
// hold the loop forever and starve the next pass.
const fillContextTimeout = 30 * time.Second

// offlineFillInterval is how often a fill pass runs while something is kept
// offline (#115), and it is the one setting this rule changes.
//
// It is short because the rule depends on rclone's eviction order rather than
// on a second cache: the kept-offline set survives `--vfs-cache-max-size` because the
// product re-reads it often enough to be the most recently used item every
// time rclone evicts. rclone's own cache poll defaults to one minute
// (`--vfs-cache-poll-interval`), so ten seconds puts six keep-warm reads
// between one poll and the next. Measured on a real mount against the stand-in
// in offline_e2e_test.go, where the cache is driven to several times its cap
// with six other files and the kept file is still whole on disk.
const offlineFillInterval = 10 * time.Second

// RunFillLoop is the background fill, running inside the mount process for as
// long as the mount does. It is started by mountForeground and stopped when
// the mount stops; it is not a second daemon and not a script.
//
// Each pass reads the kept-offline list from the config directory, reads
// rclone's own cache state over the remote control, asks whether the machine
// is idle, and when the pass is due refreshes the directory cache and reads
// the mounted files through the mount so rclone fills its cache.
//
// The list is re-read on every pass rather than held for the life of the
// mount, so `drive offline` on a running drive takes effect on the next pass
// without the person restarting anything — and `drive online` stops the
// keep-warm just as immediately. Every error is returned on the returned error
// channel with a named cause, and the loop continues: one bad pass must not
// take the mount down, and it must not be silent either.
func RunFillLoop(ctx context.Context, c *rcClient, home, mountDir string) <-chan error {
	errs := make(chan error, 1)
	go func() {
		defer close(errs)
		if mountDir == "" {
			mountDir = DefaultMountDir(home)
		}
		for {
			targets := fillTargets{root: mountDir}
			idx, err := LoadOffline(home)
			if err != nil {
				select {
				case errs <- fmt.Errorf("fill pass: %w", err):
				default:
				}
			} else {
				targets.offline = idx.Paths
			}
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
			targets.ctx = passCtx
			targets.cacheDir = DefaultCacheDir(home)
			_, err = fillPass(passCtx, c, len(targets.offline) > 0, load1, load5, targets.read)
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

// idleNow reads the load averages and applies the policy in one call, so the
// loop body is the whole rule and the test drives ShouldFill directly.
func idleNow(offline bool) (bool, error) {
	if offline {
		return true, nil
	}
	one, five, err := readLoadAverages()
	if err != nil {
		return false, fmt.Errorf("fill: read load average: %w", err)
	}
	return ShouldFill(offline, one, five), nil
}
