package rc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Nishfleet/drive/internal/atomicwrite"
	"github.com/Nishfleet/drive/internal/login"
)

// Client is rclone's remote control over its loopback address, reached through the rclone binary itself (`rclone rc --rc-addr --user --pass ...`) rather than an HTTP client, so no listener of our own is added and the rc user/pass stay in rclone.env (mode 0600) the mount already wrote (drive#498).
type Client struct {
	Binary string
	Addr   string
	fs     string
	user   string
	pass   string
}

// newRCClient builds the client for the mount's remote control.
func New(binary, addr, fs string) *Client {
	return &Client{Binary: binary, Addr: addr, fs: fs}
}

// SetAuth stores the remote-control user and password from rclone.env.
func (c *Client) SetAuth(user, pass string) { c.user, c.pass = user, pass }

// UpdateRemoteConfig reloads the live rclone remote with a fresh credential (drive#749).
func (c *Client) UpdateRemoteConfig(cfg login.StorageConfig) error {
	params := map[string]string{
		"access_key_id":     cfg.AccessKey,
		"secret_access_key": cfg.SecretKey,
	}
	if cfg.SessionToken != "" {
		params["session_token"] = cfg.SessionToken
	}
	body, err := json.Marshal(map[string]any{
		"name":       login.RcloneRemoteName,
		"parameters": params,
	})
	if err != nil {
		return err
	}
	base := c.Addr
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		base = "http://" + base
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(base, "/")+"/config/update", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.user != "" || c.pass != "" {
		req.SetBasicAuth(c.user, c.pass)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("rclone rc config/update: %w", err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return fmt.Errorf("rclone rc config/update: %w", err)
	}
	if len(b) > 0 {
		var reply map[string]any
		if err := json.Unmarshal(b, &reply); err != nil {
			return fmt.Errorf("rclone rc config/update: decode %s: %w", strings.TrimSpace(string(b)), err)
		}
		if errText, ok := reply["error"].(string); ok && errText != "" {
			return fmt.Errorf("rclone rc config/update: %s", errText)
		}
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("rclone rc config/update: HTTP %s", res.Status)
	}
	return nil
}

// vfsStats is the part of vfs/stats the fill loop reads.
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
		CacheMaxSize      int64 `json:"CacheMaxSize"`
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

// Refresh asks rclone to refresh the mount's directory cache, so a file just written to the object store is visible to the other machine and to the read the fill does next.
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

// VFSRefreshReplyError reads rclone's vfs/refresh JSON.
func VFSRefreshReplyError(reply map[string]any, skipFailed bool) error {
	raw, ok := reply["result"]
	if !ok {
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

// Reachable asks the object store for the remote's root listing, not through the VFS, so a dead backend is a named error and the directory cache is left alone.
func (c *Client) Reachable(ctx context.Context) error {
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var reply map[string]any
	return c.Call(probeCtx, "operations/list", map[string]string{"fs": c.fs, "remote": ""}, &reply)
}

// Remote is the mounted remote, so an interface value carries what rc needs.
func (c *Client) Remote() string { return c.fs }

// PausedBWLimit is the rclone bandwidth string that pauses uploads and leaves downloads alone.
const PausedBWLimit = "1KiB:off"

// RclonePausedBWLimit is how rclone reports the paused rate back.
const RclonePausedBWLimit = "1Ki:off"

// ResumeBWLimit is rclone's "no cap" rate.
const ResumeBWLimit = "off"

// QueueHoldExpiry is a far-future vfs/queue-set-expiry (rclone.org/rc).
const QueueHoldExpiry = "1000000000"
const QueueReleaseExpiry = "-1000000000"

const (
	pausedRate         = PausedBWLimit
	rclonePausedRate   = RclonePausedBWLimit
	queueHoldExpiry    = QueueHoldExpiry
	queueReleaseExpiry = QueueReleaseExpiry
)

// PauseStatePath is where the paused state is remembered.
func PauseStatePath(home string) string {
	return filepath.Join(login.DefaultConfigDir(home), "paused")
}

// BwLimit is the rate rclone is running with right now: what core/bwlimit answers with no argument.
type BwLimit struct {
	Rate             string `json:"rate"`
	BytesPerSecond   int64  `json:"bytesPerSecond"`
	BytesPerSecondTx int64  `json:"bytesPerSecondTx"`
}

// SetBwLimit sets the rate on the running mount.
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

// ReadQueue asks the mount what it is waiting to send.
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
func (c *Client) SetQueueExpiry(ctx context.Context, id int, expiry string) error {
	var reply map[string]any
	params := map[string]string{"id": fmt.Sprintf("%d", id), "expiry": expiry}
	if c.fs != "" {
		params["fs"] = c.fs
	}
	return c.Call(ctx, "vfs/queue-set-expiry", params, &reply)
}

// HoldQueuedUploads delays every waiting VFS upload through rclone's own queue-set-expiry, so pause is a hold of rclone's queue, not a second queue.
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

// Stats is the part of core/stats this file reads: the totals and the files in flight.
type Stats struct {
	Bytes          int64      `json:"bytes"`
	TotalBytes     int64      `json:"totalBytes"`
	Transfers      int64      `json:"transfers"`
	TotalTransfers int64      `json:"totalTransfers"`
	Eta            *float64   `json:"eta"`
	Transferring   []Transfer `json:"transferring"`
}

// cacheOutOfSpace asks the running mount whether the VFS cache disk is full.
func (c *Client) CacheOutOfSpace(ctx context.Context) (bool, error) {
	s, err := c.CacheStats(ctx)
	if err != nil {
		return false, err
	}
	return s.DiskCache.OutOfSpace, nil
}

// cacheStats is the mount's own vfs/stats block: the live cache size, the limit in force and the uploads queued.
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

// SetPaused records that uploads are stopped.
func SetPaused(home string) error {
	return atomicwrite.Write(PauseStatePath(home), []byte(pausedRate), 0o600)
}

// ClearPaused forgets the paused state.
func ClearPaused(home string) error {
	err := os.Remove(PauseStatePath(home))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove %s: %w", PauseStatePath(home), err)
	}
	return nil
}

// PausedRate returns the rate the mount should start with, or "" when uploads are not paused.
func PausedRate(home string) string {
	path := PauseStatePath(home)
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ""
		}
		return pausedRate
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == pausedRate || trimmed == rclonePausedRate {
		return pausedRate
	}
	return pausedRate
}

// rateIsPaused reports whether rclone's own core/bwlimit answer is the paused rate.
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

// queueEntry is one upload in the mount's VFS queue, in rclone's own field names (the JSON keys come straight from vfs/queue).
type QueueEntry struct {
	Name      string  `json:"name"`
	Size      int64   `json:"size"`
	ID        int     `json:"id"`
	Tries     int     `json:"tries"`
	Uploading bool    `json:"uploading"`
	Delay     float64 `json:"delay"`
	Expiry    float64 `json:"expiry"`
}

// queue is rclone's own list of this mount's pending uploads: the paths this device has saved and storage has not taken yet.
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
func (c *Client) RemoteHas(ctx context.Context, name string) (bool, error) {
	var reply struct {
		Item json.RawMessage `json:"item"`
	}
	if err := c.Call(ctx, "operations/stat", map[string]string{"fs": c.fs, "remote": name}, &reply); err != nil {
		return false, err
	}
	return string(reply.Item) != "null", nil
}

func isRemoteMissing(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "directory not found")
}

// ParentContents names the files one folder of the remote holds.
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

// RemoteHash is the md5 of the object at the plain path, and "" when there is no object there.
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

// remoteVersion is the object's size and mtime from operations/stat, and ok is false when there is no object at the plain path.
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
func SameVersion(size int64, modTime time.Time, stagedSize int64, stagedMtime time.Time) bool {
	if size != stagedSize || stagedMtime.IsZero() {
		return false
	}
	d := modTime.Sub(stagedMtime)
	return d < time.Second && d > -time.Second
}

// remoteFingerprint is the object's ETag or version when MD5 is missing (multipart S3 uploads, web uploads).
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

// matchHashSum picks the one hash of name out of a hashsum reply.
func MatchHashSum(lines []string, name string) (string, error) {
	base := remoteBase(name)
	var fallback string
	for _, line := range lines {
		hash, path, ok := splitHashLine(line)
		if !ok {
			continue
		}
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

func splitHashLine(line string) (hash, path string, ok bool) {
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

func remoteBase(name string) string {
	if i := strings.LastIndex(name, "/"); i >= 0 {
		return name[i+1:]
	}
	return name
}

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

// CopyLocalToRemote copies one file this device can read into the mount's own remote with rclone's own copy operation: the object store already holds the upload path and the credentials, and rclone is already the thing that talks to it, so this is not a second way to write to storage.
func (c *Client) CopyLocalToRemote(ctx context.Context, srcRoot, srcRemote, dstRemote string) error {
	srcFs := srcRoot
	if filepath.IsAbs(srcRoot) {
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
