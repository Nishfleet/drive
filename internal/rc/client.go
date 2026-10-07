package rc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Nishfleet/drive/internal/atomicwrite"
	"github.com/Nishfleet/drive/internal/login"
)

// Client is rclone's remote control over its loopback address, reached
// through the rclone binary itself (`rclone rc --rc-addr --user --pass ...`)
// rather than an HTTP client, so no listener of our own is added and the rc
// user/pass stay in rclone.env (mode 0600) the mount already wrote (drive#498).
type Client struct {
	Binary string
	Addr   string
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
func New(binary, addr, fs string) *Client {
	return &Client{Binary: binary, Addr: addr, fs: fs}
}

// SetAuth stores the remote-control user and password from rclone.env.
func (c *Client) SetAuth(user, pass string) { c.user, c.pass = user, pass }

// vfsStats is the part of vfs/stats the fill loop reads. Field names are
// rclone's own: the JSON keys come straight from the vfs/stats output, and
// the opt block is the mount's live options, not a copy this product keeps.
type VFSStats struct {
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
func (c *Client) Call(ctx context.Context, method string, params map[string]string, out any) error {
	args := []string{"rc", "--rc-addr", c.Addr}
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
	cmd := exec.CommandContext(ctx, c.Binary, args...)
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

// stats reads the cache's live state from the running mount.
func (c *Client) Stats(ctx context.Context) (VFSStats, error) {
	var s VFSStats
	if err := c.Call(ctx, "vfs/stats", map[string]string{"fs": c.fs}, &s); err != nil {
		return VFSStats{}, err
	}
	return s, nil
}

// Refresh asks rclone to refresh the mount's directory cache, so a file just
// written to the object store is visible to the other machine and to the
// read the fill does next. rclone's vfs/refresh is the stock call for this.
// The fill always passes recursive=false: a whole-tree refresh on a timer is
// the bug in drive#568. The conflict guard (#30) shares this call with
// recursive=false. Callers must not invoke this while storage is down:
// rclone forces the cache stale before it re-lists (issue #541).
func (c *Client) Refresh(ctx context.Context, recursive bool) error {
	params := map[string]string{"fs": c.fs}
	if recursive {
		params["recursive"] = "true"
	}
	var reply map[string]any
	if err := c.Call(ctx, "vfs/refresh", params, &reply); err != nil {
		return err
	}
	return VFSRefreshReplyError(reply, false)
}

// RefreshDirs refreshes named directories (rclone rc vfs/refresh dir=...).
// A path that is a file or is missing is skipped: the caller may pass a
// kept-offline file's parent and a folder in the same list.
func (c *Client) RefreshDirs(ctx context.Context, dirs []string) error {
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
	if err := c.Call(ctx, "vfs/refresh", params, &reply); err != nil {
		return err
	}
	return VFSRefreshReplyError(reply, true)
}

// VFSRefreshReplyError reads rclone's vfs/refresh JSON. A listing error is
// inside result with HTTP 200. skipFailed is for named dirs: a listed name
// that is a file, or that does not exist, is not a failure — but any other
// error string in a named dir is returned, so a real listing problem never
// hides behind an OK (issue #541).
func VFSRefreshReplyError(reply map[string]any, skipFailed bool) error {
	raw, ok := reply["result"]
	if !ok {
		// A reply with no result is not success: rclone's vfs/refresh
		// always answers with one, so a caller that reads its absence as an
		// OK would hide a changed remote-control shape behind a stale
		// listing for --dir-cache-time (24h) (issue #541).
		return fmt.Errorf("rclone rc vfs/refresh: reply carries no result object")
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
		if skipFailed && namedDirNotFound(s) {
			continue
		}
		return fmt.Errorf("rclone rc vfs/refresh %s: %s", p, s)
	}
	return nil
}

func namedDirNotFound(s string) bool {
	l := strings.ToLower(s)
	return strings.Contains(l, "not found") || strings.Contains(l, "not a directory") || strings.Contains(l, "is a file")
}

// Reachable asks the object store for the remote's root listing, not through
// the VFS, so a dead backend is a named error and the directory cache is
// left alone. operations/list with no recurse is one directory, the same
// shape vfs/refresh uses when it is safe to call.
func (c *Client) Reachable(ctx context.Context) error {
	// A dead S3 endpoint can hang operations/list until the fill's 30s
	// pass budget; three seconds is enough to see a live stand-in and
	// short enough that a dropped link does not stall keep-warm.
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var reply map[string]any
	return c.Call(probeCtx, "operations/list", map[string]string{"fs": c.fs, "remote": ""}, &reply)
}

// Remote is the mounted remote, so an interface value carries what rc needs.
func (c *Client) Remote() string { return c.fs }

// `drive pause`, `drive resume` and the per-file progress lines in
// `drive status` (drive issue #100). Every question they ask is asked of the
// running mount through rclone's own remote-control API (rclone.org/rc), over
// the loopback address the mount already binds (mount.go RCAddr, the same
// address the fill loop and the conflict guard use), so there is one rclone
// rc client in this CLI and one address in the product.
//
// Measured on this host 2026-10-03 with rclone v1.75.1 against a
// `rclone serve s3` stand-in:
//
//   - core/bwlimit with no argument answers the rate in force; core/bwlimit
//     rate="1KiB:off" sets it. rclone's rate is "UP:DOWN" (its own --bwlimit
//     docs), so Tx is the upload direction and the paused rate caps the
//     upload at 1 KiB/s while downloads stay unlimited.
//   - vfs/queue answers one entry per file waiting to upload (name, size,
//     uploading), with no second queue kept by this CLI.
//   - vfs/queue-set-expiry delays or releases a waiting item; pause holds
//     the queue this way, and resume releases it. In-flight items ignore
//     expiry: core/bwlimit is what slows those.
//   - core/stats answers the file in flight now (name, size, bytes,
//     percentage, eta) and the group's totals.
//
// Measured proof that the paused rate stops bytes leaving, same stand-in,
// same file: bytes transferred read 15,626,240 before the call and 19,066,880
// six seconds after it (the in-flight chunk finished), then 19,066,880 again
// six seconds later — a flat line. rate=off finished the file at exactly
// 157,286,400 bytes with transfers=1, so nothing was lost and nothing was
// sent twice.

// PausedBWLimit is the rclone bandwidth string that pauses uploads and leaves
// downloads alone. rclone's --bwlimit and rc core/bwlimit both read "UP:DOWN"
// (rclone.org/rc "core/bwlimit": `rclone rc core/bwlimit rate=1M:100k`), so
// the upload half is the first one. 1 KiB/s rather than 0, because 0 means
// "off" to rclone and would start the upload at full speed: measured above,
// "1KiB:off" flattens the byte counter while "off" resumes it.
const PausedBWLimit = "1KiB:off"

// RclonePausedBWLimit is how rclone reports the paused rate back. It collapses
// "1KiB" to "1Ki" in core/bwlimit's answer. Both spellings mean the same cap.
const RclonePausedBWLimit = "1Ki:off"

// ResumeBWLimit is rclone's "no cap" rate. A paused mount returns to this.
const ResumeBWLimit = "off"

// QueueHoldExpiry is a far-future vfs/queue-set-expiry (rclone.org/rc). A
// large positive number delays the item until resume; a large negative number
// makes it eligible immediately. An item that has already started uploading
// is not affected: rclone says so, and core/bwlimit is what slows that one.
const QueueHoldExpiry = "1000000000"
const QueueReleaseExpiry = "-1000000000"

const (
	pausedRate         = PausedBWLimit
	rclonePausedRate   = RclonePausedBWLimit
	queueHoldExpiry    = QueueHoldExpiry
	queueReleaseExpiry = QueueReleaseExpiry
)

// PauseStatePath is where the paused state is remembered. rclone's bandwidth
// limit lives in the running process, so a restart of the mount comes back
// unlimited unless this CLI writes the limit into the mount's own command line
// (mount.go BuildMountPlan reads it). An empty file means paused; anything
// else is newer than this read and is refused, not guessed at.
func PauseStatePath(home string) string {
	return filepath.Join(login.DefaultConfigDir(home), "paused")
}

// BwLimit is the rate rclone is running with right now: what core/bwlimit
// answers with no argument.
type BwLimit struct {
	Rate             string `json:"rate"`
	BytesPerSecond   int64  `json:"bytesPerSecond"`
	BytesPerSecondTx int64  `json:"bytesPerSecondTx"`
}

// SetBwLimit sets the rate on the running mount. An empty rate means no limit,
// which is what `drive resume` wants. The call is rclone's own documented
// method; this CLI keeps no rate of its own.
func (c *Client) SetBwLimit(ctx context.Context, rate string) error {
	var reply map[string]any
	return c.Call(ctx, "core/bwlimit", map[string]string{"rate": rate}, &reply)
}

// BwLimit asks the running mount what rate is in force.
func (c *Client) BwLimit(ctx context.Context) (BwLimit, error) {
	var l BwLimit
	if err := c.Call(ctx, "core/bwlimit", nil, &l); err != nil {
		return BwLimit{}, err
	}
	return l, nil
}

// QueueItem is one file rclone has in its VFS upload queue (rc vfs/queue).
// Size is the file's size; Uploading is rclone's own word for the one it is
// sending now. Tries is how many times rclone has tried and failed to send it,
// and Delay is the seconds until it tries again (issue #543): rclone retries
// forever with a 5-minute backoff, so a save that keeps failing is invisible
// without these two.
type QueueItem struct {
	Name      string  `json:"name"`
	Size      int64   `json:"size"`
	Uploading bool    `json:"uploading"`
	Tries     int     `json:"tries"`
	Delay     float64 `json:"delay"`
}

// Queue is the whole vfs/queue answer.
type Queue struct {
	Queue []QueueItem `json:"queue"`
}

// ReadQueue asks the mount what it is waiting to send. It is the conflict
// guard's own vfs/queue call (rcClient.queue), returned in the shape the
// status lines print. An absent queue key is an empty queue, which is the
// true answer when nothing has been saved.
func (c *Client) ReadQueue(ctx context.Context) (Queue, error) {
	entries, err := c.Queue(ctx)
	if err != nil {
		return Queue{}, err
	}
	items := make([]QueueItem, len(entries))
	for i, e := range entries {
		items[i] = QueueItem{Name: e.Name, Size: e.Size, Uploading: e.Uploading, Tries: e.Tries, Delay: e.Delay}
	}
	return Queue{Queue: items}, nil
}

// SetQueueExpiry sets one vfs/queue item's expiry (rc vfs/queue-set-expiry).
// expiry is seconds from now, as rclone's docs take it.
func (c *Client) SetQueueExpiry(ctx context.Context, id int, expiry string) error {
	var reply map[string]any
	params := map[string]string{"id": fmt.Sprintf("%d", id), "expiry": expiry}
	if c.fs != "" {
		params["fs"] = c.fs
	}
	return c.Call(ctx, "vfs/queue-set-expiry", params, &reply)
}

// HoldQueuedUploads delays every waiting VFS upload through rclone's own
// queue-set-expiry, so pause is a hold of rclone's queue, not a second queue.
// In-flight items are left to core/bwlimit: rclone ignores expiry on them.
func (c *Client) HoldQueuedUploads(ctx context.Context) error {
	return c.SetQueueExpiries(ctx, queueHoldExpiry)
}

// ReleaseQueuedUploads makes every waiting VFS upload eligible now.
func (c *Client) ReleaseQueuedUploads(ctx context.Context) error {
	return c.SetQueueExpiries(ctx, queueReleaseExpiry)
}

func (c *Client) SetQueueExpiries(ctx context.Context, expiry string) error {
	entries, err := c.Queue(ctx)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := c.SetQueueExpiry(ctx, e.ID, expiry); err != nil {
			return fmt.Errorf("vfs/queue-set-expiry id=%d: %w", e.ID, err)
		}
	}
	return nil
}

// Transfer is the file rclone is sending right now, as core/stats names it.
type Transfer struct {
	Name       string   `json:"name"`
	Size       int64    `json:"size"`
	Bytes      int64    `json:"bytes"`
	Percentage int      `json:"percentage"`
	Eta        *float64 `json:"eta"`
}

// Stats is the part of core/stats this file reads: the totals and the files in
// flight.
type Stats struct {
	Bytes          int64      `json:"bytes"`
	TotalBytes     int64      `json:"totalBytes"`
	Transfers      int64      `json:"transfers"`
	TotalTransfers int64      `json:"totalTransfers"`
	Eta            *float64   `json:"eta"`
	Transferring   []Transfer `json:"transferring"`
}

// cacheOutOfSpace asks the running mount whether the VFS cache disk is full.
// The answer is rclone's own vfs/stats diskCache.outOfSpace (the same block
// the fill loop reads in fill_run.go), so `drive status` does not invent a
// second full-disk detector. fs is omitted when empty: vfs/stats defaults to
// the mounted VFS, which is what status is asking about.
func (c *Client) CacheOutOfSpace(ctx context.Context) (bool, error) {
	s, err := c.CacheStats(ctx)
	if err != nil {
		return false, err
	}
	return s.DiskCache.OutOfSpace, nil
}

// cacheStats is the mount's own vfs/stats block: the live cache size, the
// limit in force and the uploads queued. fs is omitted when empty, so a
// status client asks the mounted VFS the same way cacheOutOfSpace does; the
// fill loop's client carries the remote and passes it.
func (c *Client) CacheStats(ctx context.Context) (VFSStats, error) {
	var s VFSStats
	params := map[string]string{}
	if c.fs != "" {
		params["fs"] = c.fs
	}
	if err := c.Call(ctx, "vfs/stats", params, &s); err != nil {
		return VFSStats{}, err
	}
	return s, nil
}

// ReadStats asks the mount for its transfer totals and the file in flight.
func (c *Client) ReadStats(ctx context.Context) (Stats, error) {
	var s Stats
	if err := c.Call(ctx, "core/stats", nil, &s); err != nil {
		return Stats{}, err
	}
	if s.Transferring == nil {
		s.Transferring = []Transfer{}
	}
	return s, nil
}

// SetPaused records that uploads are stopped. The file is written atomically
// with 0600: it is state the mount's command line is built from, and a
// half-written marker would either lose the pause or pause a drive that was
// never paused.
func SetPaused(home string) error {
	return atomicwrite.Write(PauseStatePath(home), []byte(pausedRate), 0o600)
}

// ClearPaused forgets the paused state. An absent marker is already resumed,
// so removing one that is not there is not an error.
func ClearPaused(home string) error {
	err := os.Remove(PauseStatePath(home))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove %s: %w", PauseStatePath(home), err)
	}
	return nil
}

// PausedRate returns the rate the mount should start with, or "" when uploads
// are not paused. It is what mount.go BuildMountPlan reads, so a restart of
// the mount starts already paused and no person has to pause it again. A
// missing marker is not a pause. An unreadable or junk marker is a pause:
// fail closed so a restart does not send at full speed.
func PausedRate(home string) string {
	path := PauseStatePath(home)
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ""
		}
		// Unreadable is not "not paused": a marker we cannot read still
		// means the last pause should hold, so a restart does not start
		// sending at full speed.
		return pausedRate
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == pausedRate || trimmed == rclonePausedRate {
		return pausedRate
	}
	// Junk is not a rate: fail closed and keep the pause.
	return pausedRate
}

// rateIsPaused reports whether rclone's own core/bwlimit answer is the paused
// rate. rclone reports "1Ki:off" for the "1KiB:off" we set.
func RateIsPaused(rate string) bool {
	switch strings.TrimSpace(rate) {
	case pausedRate, rclonePausedRate:
		return true
	default:
		return false
	}
}

// Paused reports whether the mount is paused, as recorded in the marker file.
func Paused(home string) bool {
	return PausedRate(home) != ""
}

// queueEntry is one upload in the mount's VFS queue, in rclone's own
// field names (the JSON keys come straight from vfs/queue).
type QueueEntry struct {
	Name      string  `json:"name"`
	Size      int64   `json:"size"`
	ID        int     `json:"id"`
	Tries     int     `json:"tries"`
	Uploading bool    `json:"uploading"`
	Delay     float64 `json:"delay"`
	Expiry    float64 `json:"expiry"`
}

// queue is rclone's own list of this mount's pending uploads: the
// paths this device has saved and storage has not taken yet. It is
// the only handle on the window in which a conflicting save happens,
// and it is rclone's answer to the question, not a second index
// this product keeps.
func (c *Client) Queue(ctx context.Context) ([]QueueEntry, error) {
	params := map[string]string{}
	if c.fs != "" {
		params["fs"] = c.fs
	}
	var reply struct {
		Queue []QueueEntry `json:"queue"`
	}
	if err := c.Call(ctx, "vfs/queue", params, &reply); err != nil {
		return nil, err
	}
	if reply.Queue == nil {
		return []QueueEntry{}, nil
	}
	return reply.Queue, nil
}

// remoteHas reports whether an object exists at the plain path.
// A missing object is an answer, not an error.
func (c *Client) RemoteHas(ctx context.Context, name string) (bool, error) {
	var reply struct {
		Item json.RawMessage `json:"item"`
	}
	if err := c.Call(ctx, "operations/stat", map[string]string{"fs": c.fs, "remote": name}, &reply); err != nil {
		return false, err
	}
	return string(reply.Item) != "null", nil
}

// isRemoteMissing reports a path rclone does not have yet: a listing or
// stat of a prefix that has never been written is "no files", not a
// failed pass.
func isRemoteMissing(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "directory not found")
}

// ParentContents names the files one folder of the remote holds. The
// folder is asked for first (operations/stat): a folder that is not
// there yet holds no paths and that is an answer, because the first
// save into a new folder queues before rclone has created the folder
// in storage. The listing itself is rclone's operations/list, which
// names files at that one level — the level the saves in it live at.
func (c *Client) ParentContents(ctx context.Context, dir string) (map[string]bool, error) {
	if dir != "" {
		var statReply struct {
			Item json.RawMessage `json:"item"`
		}
		if err := c.Call(ctx, "operations/stat", map[string]string{"fs": c.fs, "remote": dir}, &statReply); err != nil {
			if isRemoteMissing(err) {
				return map[string]bool{}, nil
			}
			return nil, err
		}
		if string(statReply.Item) == "null" {
			return map[string]bool{}, nil
		}
	}
	var reply struct {
		List []struct {
			Name  string `json:"Name"`
			IsDir bool   `json:"IsDir"`
		} `json:"list"`
	}
	if err := c.Call(ctx, "operations/list", map[string]string{"fs": c.fs, "remote": dir}, &reply); err != nil {
		if isRemoteMissing(err) {
			return map[string]bool{}, nil
		}
		return nil, err
	}
	present := make(map[string]bool, len(reply.List))
	for _, entry := range reply.List {
		if !entry.IsDir {
			present[entry.Name] = true
		}
	}
	return present, nil
}

// RemoteHash is the md5 of the object at the plain path, and "" when
// there is no object there. Existence is asked first: operations/hashsum
// on a path that is not there is an error, and a save that lands where
// nothing was is exactly the case the rule has to name, so "no object" is
// an answer and only a failed read is an error.
func (c *Client) RemoteHash(ctx context.Context, name string) (string, error) {
	exists, err := c.RemoteHas(ctx, name)
	if err != nil {
		return "", err
	}
	if !exists {
		return "", nil
	}
	var reply struct {
		Hashsum []string `json:"hashsum"`
	}
	hashErr := c.Call(ctx, "operations/hashsum", map[string]string{
		"fs": c.fs, "remote": name, "hashType": "md5",
	}, &reply)
	if hashErr == nil {
		hash, err := MatchHashSum(reply.Hashsum, name)
		if err == nil && hash != "" {
			return hash, nil
		}
		hashErr = err
	}
	fp, fpErr := c.RemoteFingerprint(ctx, name)
	if fpErr != nil {
		if hashErr != nil {
			return "", hashErr
		}
		return "", fpErr
	}
	return fp, nil
}

// remoteVersion is the object's size and mtime from operations/stat, and
// ok is false when there is no object at the plain path.
func (c *Client) RemoteVersion(ctx context.Context, name string) (int64, time.Time, bool, error) {
	var reply struct {
		Item *struct {
			Size    int64     `json:"Size"`
			ModTime time.Time `json:"ModTime"`
		} `json:"item"`
	}
	if err := c.Call(ctx, "operations/stat", map[string]string{"fs": c.fs, "remote": name}, &reply); err != nil {
		return 0, time.Time{}, false, err
	}
	if reply.Item == nil {
		return 0, time.Time{}, false, nil
	}
	return reply.Item.Size, reply.Item.ModTime, true, nil
}

// sameVersion reports whether an object is the file this device staged.
// The mtime is compared to the second because a backend may keep less
// precision than the local filesystem does.
func SameVersion(size int64, modTime time.Time, stagedSize int64, stagedMtime time.Time) bool {
	if size != stagedSize || stagedMtime.IsZero() {
		return false
	}
	d := modTime.Sub(stagedMtime)
	return d < time.Second && d > -time.Second
}

// remoteFingerprint is the object's ETag or version when MD5 is missing
// (multipart S3 uploads, web uploads). rclone's operations/stat ID is the
// S3 ETag; size and modtime are the fallback when even that is empty.
func (c *Client) RemoteFingerprint(ctx context.Context, name string) (string, error) {
	var reply struct {
		Item struct {
			ID      string            `json:"ID"`
			Size    int64             `json:"Size"`
			ModTime string            `json:"ModTime"`
			Hashes  map[string]string `json:"Hashes"`
		} `json:"item"`
	}
	if err := c.Call(ctx, "operations/stat", map[string]string{
		"fs": c.fs, "remote": name,
	}, &reply); err != nil {
		return "", err
	}
	if md5 := reply.Item.Hashes["MD5"]; md5 != "" {
		return md5, nil
	}
	if reply.Item.ID != "" {
		return "etag:" + reply.Item.ID, nil
	}
	return fmt.Sprintf("ver:%d:%s", reply.Item.Size, reply.Item.ModTime), nil
}

// matchHashSum picks the one hash of name out of a hashsum reply. The
// reply echoes other paths when the remote names a prefix, so the
// entry is matched by the name that follows the hash rather than by
// taking the first line.
func MatchHashSum(lines []string, name string) (string, error) {
	base := remoteBase(name)
	var fallback string
	for _, line := range lines {
		hash, path, ok := splitHashLine(line)
		if !ok {
			continue
		}
		// The remote that was asked for is matched first, so two files
		// that share a base name in different folders cannot trade
		// hashes. The base name is the fallback for a backend that
		// answers with the name its fs was asked for, and only when it
		// is the only entry: a reply carrying other paths is not
		// answered by guessing which one was meant.
		if path == name {
			return hash, nil
		}
		if path == base && fallback == "" {
			fallback = hash
		}
	}
	if fallback != "" && len(lines) == 1 {
		return fallback, nil
	}
	return "", fmt.Errorf("no md5 for %q in %v", name, lines)
}

// splitHashLine splits one hashsum reply line into its hash and its path.
// The hash is the first field and the path is the rest of the line, because
// a path may contain spaces: "report (conflict, mac).txt" is one name, not
// the word after the hash.
func splitHashLine(line string) (hash, path string, ok bool) {
	// rclone prints "hash  path" with two spaces. An empty MD5 (multipart
	// ETag without md5 metadata) is "  path", which TrimSpace would turn
	// into a path-only line and then into an error. Keep the two-space
	// split so an empty hash is still a hash.
	trimmed := strings.TrimRight(line, " \t\n")
	if trimmed == "" {
		return "", "", false
	}
	if i := strings.Index(trimmed, "  "); i >= 0 {
		return strings.TrimSpace(trimmed[:i]), strings.TrimSpace(trimmed[i+2:]), true
	}
	i := strings.IndexAny(trimmed, " \t")
	if i <= 0 {
		return "", "", false
	}
	return trimmed[:i], strings.TrimSpace(trimmed[i+1:]), true
}

// RemoteBase is the last segment of a '/'-separated remote path.
func RemoteBase(name string) string { return remoteBase(name) }

// remoteBase is the last segment of a '/'-separated remote path.
func remoteBase(name string) string {
	if i := strings.LastIndex(name, "/"); i >= 0 {
		return name[i+1:]
	}
	return name
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

// CopyLocalToRemote copies one file this device can read into the mount's
// own remote with rclone's own copy operation: the object store already
// holds the upload path and the credentials, and rclone is already
// the thing that talks to it, so this is not a second way to write
// to storage. srcRemote is relative to srcRoot, which for a
// conflict copy is this device's own mount.
func (c *Client) CopyLocalToRemote(ctx context.Context, srcRoot, srcRemote, dstRemote string) error {
	srcFs := srcRoot
	if filepath.IsAbs(srcRoot) {
		// Force the local backend. rclone's cache folder is named
		// drive{XXXX} when the remote has extra config, and `{XXXX}`
		// is also rclone's connection-string config syntax.
		srcFs = ":local:" + srcRoot
	}
	var reply map[string]any
	return c.Call(ctx, "operations/copyfile", map[string]string{
		"srcFs":     srcFs,
		"srcRemote": srcRemote,
		"dstFs":     c.fs,
		"dstRemote": dstRemote,
	}, &reply)
}
