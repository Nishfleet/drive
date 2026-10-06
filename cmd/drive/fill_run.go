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
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
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
//
// What a pass may fill is deliberately narrow (drive#568). It fills the paths
// somebody kept offline (#115) and the files somebody opened in the last
// fillRecentAge, and nothing else: it does not walk the tree and it does not
// list the whole drive on a timer. rclone's own --vfs-cache-max-age already
// keeps a file that was opened, so a second index of opens is not needed, and
// a drive larger than the cache no longer downloads continuously while the
// machine sits idle.

// rcClient is rclone's remote control over its loopback address, reached
// through the rclone binary itself (`rclone rc --rc-addr --user --pass ...`)
// rather than an HTTP client, so no listener of our own is added and the rc
// user/pass stay in rclone.env (mode 0600) the mount already wrote (drive#498).
type rcClient struct {
	binary string
	addr   string
	// fs is the mounted remote, e.g. drive:bucket/u/id, which vfs/stats and
	// vfs/refresh both take.
	fs string
	// user and pass are the --user/--pass rclone rc sends (the same pair
	// --rc-user/--rc-pass set on the mount, drive#498). Empty only in tests
	// that point at a fake rclone with no auth.
	user string
	pass string
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
	args := []string{"rc", "--rc-addr", c.addr}
	if c.user != "" || c.pass != "" {
		args = append(args, "--user", c.user, "--pass", c.pass)
	}
	args = append(args, method)
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
	var stderr strings.Builder
	cmd.Stderr = &stderr
	b, err := cmd.Output()
	if err != nil {
		if msg := rcErrorCause(stderr.String()); msg != "" {
			return fmt.Errorf("rclone rc %s: %s: %w", method, msg, err)
		}
		return fmt.Errorf("rclone rc %s: %w", method, err)
	}
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("rclone rc %s: decode %s: %w", method, strings.TrimSpace(string(b)), err)
	}
	return nil
}

// rcErrorCause is one short line of rclone's stderr, so a listing of a
// prefix that is not there yet can be told from a dead remote control
// without printing a backend dump.
func rcErrorCause(stderr string) string {
	msg := strings.TrimSpace(stderr)
	if msg == "" {
		return ""
	}
	if i := strings.IndexByte(msg, '\n'); i >= 0 {
		msg = msg[:i]
	}
	const max = 200
	if len(msg) > max {
		return msg[:max]
	}
	return msg
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
// written to the object store is visible to the other machine and to the
// read the fill does next. rclone's vfs/refresh is the stock call for this.
// The fill always passes recursive=false: a whole-tree refresh on a timer is
// the bug in drive#568. The conflict guard (#30) shares this call with
// recursive=false. Callers must not invoke this while storage is down:
// rclone forces the cache stale before it re-lists (issue #541).
func (c *rcClient) refresh(ctx context.Context, recursive bool) error {
	params := map[string]string{"fs": c.fs}
	if recursive {
		params["recursive"] = "true"
	}
	var reply map[string]any
	if err := c.call(ctx, "vfs/refresh", params, &reply); err != nil {
		return err
	}
	return vfsRefreshReplyError(reply, false)
}

// refreshDirs refreshes named directories (rclone rc vfs/refresh dir=...).
// A path that is a file or is missing is skipped: the caller may pass a
// kept-offline file's parent and a folder in the same list.
func (c *rcClient) refreshDirs(ctx context.Context, dirs []string) error {
	if len(dirs) == 0 {
		return nil
	}
	params := map[string]string{"fs": c.fs}
	for i, d := range dirs {
		key := "dir"
		if i > 0 {
			key = "dir" + strconv.Itoa(i+1)
		}
		params[key] = d
	}
	var reply map[string]any
	if err := c.call(ctx, "vfs/refresh", params, &reply); err != nil {
		return err
	}
	return vfsRefreshReplyError(reply, true)
}

// vfsRefreshReplyError reads rclone's vfs/refresh JSON. A listing error is
// inside result with HTTP 200. skipFailed is for named dirs: a file path is
// not a directory and must not fail the fill.
func vfsRefreshReplyError(reply map[string]any, skipFailed bool) error {
	raw, ok := reply["result"]
	if !ok {
		return nil
	}
	result, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("rclone rc vfs/refresh: result is %T, want an object", raw)
	}
	for p, v := range result {
		s, ok := v.(string)
		if !ok {
			return fmt.Errorf("rclone rc vfs/refresh: result[%q] is %T, want a string", p, v)
		}
		if s == "OK" {
			continue
		}
		if skipFailed {
			continue
		}
		return fmt.Errorf("rclone rc vfs/refresh %s: %s", p, s)
	}
	return nil
}

// reachable asks the object store for the remote's root listing, not through
// the VFS, so a dead backend is a named error and the directory cache is
// left alone. operations/list with no recurse is one directory, the same
// shape vfs/refresh uses when it is safe to call.
func (c *rcClient) reachable(ctx context.Context) error {
	// A dead S3 endpoint can hang operations/list until the fill's 30s
	// pass budget; three seconds is enough to see a live stand-in and
	// short enough that a dropped link does not stall keep-warm.
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var reply map[string]any
	return c.call(probeCtx, "operations/list", map[string]string{"fs": c.fs, "remote": ""}, &reply)
}

// loopbackRCAddr is the address the mount's remote control binds. rclone's
// default is localhost:5572; the plan sets it explicitly so the fill loop and
// the operator reach the same one even on a host with another rclone running.
// localhost only: the remote control is password-protected (drive#498) and
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
	refreshDirs(ctx context.Context, dirs []string) error
	// reachable reports whether the object store answers. vfs/refresh
	// forces the directory cache stale before it re-lists (rclone
	// vfs/dir.go readDir), so a refresh while storage is down makes
	// every later open fail (issue #541, rclone#1963).
	reachable(ctx context.Context) error
	// fs is the mounted remote, the value a stats call is addressed to.
	remote() string
}

// remote is the mounted remote, so an interface value carries what rc needs.
func (c *rcClient) remote() string { return c.fs }

// fillPass is one iteration of the loop: read the cache's live stats, ask
// rclone to refresh, read the targets through the mount into rclone's own
// cache, then read the stats again. The kept-offline set (#115) is filled in
// full regardless of load; recently-opened files are filled only on an idle
// pass under the cap, and under a per-pass byte budget. It returns the
// before/after the cap is checked against.
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
	// A cache already at the cap is rclone's to reclaim, except for a set the
	// person kept offline (#115): those files must still be re-read so rclone's
	// own last-access eviction drops the rest of the drive first. Recently
	// opened files are filled only when the machine is idle and the cache is
	// under the cap, so a fill never competes with a foreground open and never
	// loops the drive once the cache is full (drive#568).
	offline := len(targets.offline) > 0
	fillRecent := idle && !atCap && len(targets.recent) > 0
	res.Idle = ShouldFill(offline, load1, load5)
	storageUp := c.reachable(ctx) == nil
	// A non-recursive root refresh, and never a recursive one: a whole-tree
	// refresh every minute is what listed the drive and re-read it forever
	// (drive#568). Freshness for the other machine is this call, while
	// storage answers (issue #541). A dead backend must not be refreshed:
	// rclone forces the directory cache stale before it re-lists, so a
	// failed refresh would turn a kept-offline folder into I/O errors.
	if storageUp {
		if err := c.refresh(ctx, false); err != nil {
			return res, fmt.Errorf("fill: refresh directory cache: %w", err)
		}
		if dirs := listingDirs(targets); len(dirs) > 0 {
			if err := c.refreshDirs(ctx, dirs); err != nil {
				return res, fmt.Errorf("fill: refresh directory cache: %w", err)
			}
		}
	}
	if !offline && !fillRecent {
		return res, nil
	}
	res.Refreshed = true

	// The per-pass budget is this pass's headroom under the cap, capped at
	// fillPassBudget, so a drive larger than the cache is filled over several
	// passes and a pass stops when the next file would not fit. (One file larger
	// than the remaining headroom is still read and can evict; rclone cannot be
	// stopped mid-read, and the over-cap check below names that pass.) The
	// kept-offline set is read without the budget: #115 promises it in full, and
	// re-reading a file rclone already has downloads nothing.
	budget := fillPassBudget
	if res.CapBytes > 0 {
		if head := res.CapBytes - res.BytesBefore; head < budget {
			budget = head
		}
	}
	// The window budget: a window fills at most one cache's worth of
	// recently-opened files, so a drive larger than the cache is downloaded
	// once and not again after rclone evicts (drive#568).
	if targets.opens != nil && res.CapBytes > 0 {
		if left := res.CapBytes - targets.opens.windowBytes(); left < budget {
			budget = left
		}
	}
	if budget < 0 {
		budget = 0
	}
	targets.ctx = ctx
	recentBytes, err := targets.read(fillRecent, budget)
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
	// The cap is rclone's own --vfs-cache-max-size, read live from the mount.
	// rclone evicts over the cap on its cache poll. A keep-warm of the
	// kept-offline set is allowed to sit at or over the cap: that is rclone
	// evicting everything else. Only the recently-opened read is budgeted, so
	// only it can be a named failure when it crossed the cap; keying on
	// BytesAfter would blame the unbudgeted offline read (drive#568 review).
	if fillRecent && res.CapBytes > 0 && res.BytesBefore+recentBytes > res.CapBytes {
		return res, fmt.Errorf("fill: cache %s is over the %s cap; refusing to fill further",
			FormatBytes(res.BytesBefore+recentBytes), FormatBytes(res.CapBytes))
	}
	return res, nil
}

// listingDirs is the folders vfs/refresh should freshen besides the root:
// a kept-offline folder itself, and the parent of a kept or recently-opened
// file. The root is refreshed separately. Nested saves in those folders
// would otherwise stay invisible until --dir-cache-time (24h) expired
// (issue #541).
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

// fillRecentAge is how long a file somebody opened stays a fill target. It
// matches --vfs-cache-max-age: rclone keeps the bytes that long, and this is
// the list of paths to re-read, so the two clocks agree.
const fillRecentAge = 24 * time.Hour

// fillPassBudget is the most one pass reads into the cache for recently-opened
// files, before the headroom under --vfs-cache-max-size narrows it further. A
// drive larger than the cache is filled over several passes instead of in one
// long download, and a pass stops when the next read would evict (drive#568).
const fillPassBudget int64 = 1 << 30

// fillSelfGrace is how long after the fill read a file the fill ignores an
// open event for it. The read is through the mount, so the mount's own watcher
// sees it; without this a fill would re-arm its own target forever.
const fillSelfGrace = 5 * time.Second

// recentOpens is the set of files opened through the mount in the last
// fillRecentAge. It is the only record of "somebody opened this", and it lives
// in memory: rclone's own --vfs-cache-max-age already keeps the bytes, so this
// is the list of paths to re-read, not a second cache. The mount process fills
// it from the same directory watcher the prefetch loop already runs.
type recentOpens struct {
	mu     sync.Mutex
	opened map[string]time.Time
	filled map[string]time.Time
	// sizes is the byte count the fill read for each filled path, and bytes is
	// their sum. It is the fill window's download budget: a window fills at
	// most one cache's worth, so a drive larger than the cache stops after the
	// first cache and does not chase rclone's evictions (drive#568).
	sizes map[string]int64
	bytes int64
}

var mountOpens = &recentOpens{opened: map[string]time.Time{}, filled: map[string]time.Time{}, sizes: map[string]int64{}}

// record notes that path was opened through the mount. An open the fill itself
// just made (the fill reads through the mount) is ignored, so the fill does
// not re-arm its own target.
func (r *recentOpens) record(path string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if t, ok := r.filled[path]; ok && time.Since(t) < fillSelfGrace {
		return
	}
	r.opened[path] = time.Now()
}

// markFilled notes that the fill just read path, so the open event its read
// generates is not taken as a fresh open.
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

// windowBytes is the number of bytes the fill has read for the recently-opened
// set in this window. The fill stops once it reaches the cache size, so a drive
// larger than the cache is downloaded once, not on every pass.
func (r *recentOpens) windowBytes() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.bytes
}

// since returns the paths opened within age, as slash paths relative to root,
// and drops the ones that are older or already filled in this window. A path
// that is not under root is not this mount's and is ignored.
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
	// Prune the filled set on its own clock: a path can be filled without ever
	// being recorded as opened, so the opened loop above cannot be the only
	// place it is reclaimed. The window byte budget shrinks with it, so a new
	// window can fill a fresh cache's worth.
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

// forget drops path from the open set. The fill calls it when the file it
// tried to read is gone: a deleted file is not a target the next pass should
// probe again.
func (r *recentOpens) forget(path string) {
	r.mu.Lock()
	delete(r.opened, path)
	r.mu.Unlock()
}

// fillTargets is what one pass may fill: the paths somebody kept offline
// (#115) and the files somebody opened in the last fillRecentAge. It is never
// the whole tree (drive#568).
//
// The kept-offline read is two rules. On every pass every kept path is read
// through the mount, which both fills it and — the reason the rule is sound —
// marks it as the most recently used item in rclone's cache. rclone evicts
// over `--vfs-cache-max-size` by last access (vfs/vfscache/item.go
// `Items.Less` compares `info.ATime`), so a file the product re-reads on every
// pass is the last thing the cache drops and the rest of the drive goes first.
// Recently-opened files are read only on an idle pass, under the per-pass
// budget, and are remembered as filled so the fill does not read them again.
type fillTargets struct {
	root    string
	offline []string
	recent  []string
	// ctx is the pass deadline. A cancelled or timed-out pass stops between
	// files rather than walking the rest of the set (drive#516).
	ctx context.Context
	// opens records a recently-opened file as filled; nil is a test that does
	// not exercise the open registry.
	opens *recentOpens
	// readFile reads one file into the cache. It is a field so a test can
	// count bytes without a mount; nil means fillReadFile.
	readFile func(string) (int64, error)
}

// read fills the kept-offline set on every pass and the recently-opened files
// only when this pass is filling them, under budget bytes. It returns the bytes
// it read for the recently-opened set, so the caller can tell whether that read
// is what pushed the cache over the cap. A path that has been deleted from the
// drive reads as nothing rather than failing the pass: the next pass sees the
// new tree.
func (t fillTargets) read(includeRecent bool, budget int64) (int64, error) {
	var spent int64
	if includeRecent && budget > 0 {
		read := t.readFile
		if read == nil {
			read = fillReadFile
		}
		for _, rel := range t.recent {
			if err := t.ctxErr(); err != nil {
				return spent, err
			}
			if spent >= budget {
				break
			}
			abs := filepath.Join(t.root, filepath.FromSlash(rel))
			n, err := read(abs)
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
		if err := t.ctxErr(); err != nil {
			return spent, err
		}
		if _, err := KeepOffline(t.root, rel); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return spent, err
		}
	}
	return spent, nil
}

func (t fillTargets) ctxErr() error {
	if t.ctx == nil {
		return nil
	}
	return t.ctx.Err()
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
// the kept-offline paths and the recently-opened files through the mount so
// rclone fills its cache. It never walks the tree (drive#568).
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
