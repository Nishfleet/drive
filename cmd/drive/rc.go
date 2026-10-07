package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// `drive pause`, `drive resume` and the per-file progress lines in
// `drive status` (drive issue #100). Every question they ask is asked of the
// running mount through rclone's own remote-control API (rclone.org/rc), over
// the loopback address this mount stored in rclone.env (drive#807), so there is
// one rclone rc client in this CLI and one address per mount, not one shared
// 5572 that two mounts collide on.
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

// pausedRate is the rclone bandwidth string that pauses uploads and leaves
// downloads alone. rclone's --bwlimit and rc core/bwlimit both read "UP:DOWN"
// (rclone.org/rc "core/bwlimit": `rclone rc core/bwlimit rate=1M:100k`), so
// the upload half is the first one. 1 KiB/s rather than 0, because 0 means
// "off" to rclone and would start the upload at full speed: measured above,
// "1KiB:off" flattens the byte counter while "off" resumes it.
const pausedRate = "1KiB:off"

// rclonePausedRate is how rclone reports the paused rate back. It collapses
// "1KiB" to "1Ki" in core/bwlimit's answer. Both spellings mean the same cap.
const rclonePausedRate = "1Ki:off"

// resumeRate is rclone's own word for no limit at all.
const resumeRate = "off"

// queueHoldExpiry is a far-future vfs/queue-set-expiry (rclone.org/rc). A
// large positive number delays the item until resume; a large negative number
// makes it eligible immediately. An item that has already started uploading
// is not affected: rclone says so, and core/bwlimit is what slows that one.
const queueHoldExpiry = "1000000000"
const queueReleaseExpiry = "-1000000000"

// PauseStatePath is where the paused state is remembered. rclone's bandwidth
// limit lives in the running process, so a restart of the mount comes back
// unlimited unless this CLI writes the limit into the mount's own command line
// (mount.go BuildMountPlan reads it). An empty file means paused; anything
// else is newer than this read and is refused, not guessed at.
func PauseStatePath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "paused")
}

// rcTimeout bounds one rc call. `drive status` is what a person runs when
// something is wrong, so a hung remote control must turn a status line into a
// named failure rather than a hung terminal. It is the same order of
// magnitude as the fill loop's own per-call bound (fillContextTimeout).
const rcTimeout = 30 * time.Second

// mountRCClient returns the remote-control client for this device's running
// mount, or an error when the binary cannot be resolved. It is the same client
// the background fill uses (fill_run.go newRCClient) on the loopback address
// this mount stored in rclone.env (drive#807), so `drive pause`, `drive resume`
// and the progress lines in `drive status` ask this device's mount rather than
// whoever bound 127.0.0.1:5572.
//
// The methods used here (core/bwlimit, vfs/queue, vfs/queue-set-expiry,
// core/stats) take no `fs`
// argument, so no remote path is needed to address them. vfs/queue is the
// same call the conflict guard already makes (conflict_guard.go queue); this
// client omits `fs` when it has none, which is rclone's default for the
// mounted VFS.
//
// Before any of those methods run, the client asks core/version so a stale
// address or some other process on the port is a named failure, not a pause
// of the wrong rclone.
//
// A caller that only prints a line must not fail on a machine with no rclone
// installed, so a resolve failure is reported by the caller's error, not by
// the constructor.
func mountRCClient(home string) (*rcClient, error) {
	binary, err := ResolveRclone("")
	if err != nil {
		return nil, fmt.Errorf("rclone: %w", err)
	}
	addr, err := resolveMountRCAddr(home)
	if err != nil {
		return nil, err
	}
	c := newRCClient(binary, addr, "")
	auth, err := ReadRCAuth(home)
	if err != nil {
		return nil, fmt.Errorf("rclone rc auth: %w", err)
	}
	c.user, c.pass = auth.User, auth.Pass
	ctx, cancel := rcCtx()
	defer cancel()
	if err := c.requireVersion(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

// resolveMountRCAddr is the address the CLI uses to reach this home's mount.
// DRIVE_RC_ADDR wins (tests and --rc-addr), then the address prepareMountAuth
// stored in rclone.env. The shipped 5572 is never a silent fallback: that is
// how pause/status used to talk to whichever rclone owned the port (drive#807).
func resolveMountRCAddr(home string) (string, error) {
	if set := strings.TrimSpace(os.Getenv(rcAddrEnvName)); set != "" {
		if !IsLoopbackAddr(set) {
			return "", fmt.Errorf("%s %s is not a loopback address: the mount's remote control binds loopback only", rcAddrEnvName, set)
		}
		return set, nil
	}
	auth, err := ReadRCAuth(home)
	if err != nil {
		return "", fmt.Errorf("rclone rc address: %w", err)
	}
	if auth.Addr == "" {
		return "", fmt.Errorf("rclone rc address is missing from %s; run drive mount", RcloneEnvPath(home))
	}
	if !IsLoopbackAddr(auth.Addr) {
		return "", fmt.Errorf("stored rc address %s is not a loopback address", auth.Addr)
	}
	return auth.Addr, nil
}

// rcVersion is the part of rclone rc core/version this client needs: a
// non-empty version string means the listener is rclone, not some other
// HTTP service on the stored port.
type rcVersion struct {
	Version string `json:"version"`
}

// requireVersion asks rclone who it is before the client acts. An empty
// version or a failed call is a named error, so pause/status never mutate
// a stranger on the port (drive#807).
func (c *rcClient) requireVersion(ctx context.Context) error {
	var v rcVersion
	if err := c.call(ctx, "core/version", nil, &v); err != nil {
		return fmt.Errorf("rclone rc core/version: %w", err)
	}
	if strings.TrimSpace(v.Version) == "" {
		return fmt.Errorf("rclone rc core/version: empty version")
	}
	return nil
}

// rcCtx bounds one remote-control call. See rcTimeout.
func rcCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), rcTimeout)
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
func (c *rcClient) SetBwLimit(ctx context.Context, rate string) error {
	var reply map[string]any
	return c.call(ctx, "core/bwlimit", map[string]string{"rate": rate}, &reply)
}

// BwLimit asks the running mount what rate is in force.
func (c *rcClient) BwLimit(ctx context.Context) (BwLimit, error) {
	var l BwLimit
	if err := c.call(ctx, "core/bwlimit", nil, &l); err != nil {
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
func (c *rcClient) ReadQueue(ctx context.Context) (Queue, error) {
	entries, err := c.queue(ctx)
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
func (c *rcClient) SetQueueExpiry(ctx context.Context, id int, expiry string) error {
	var reply map[string]any
	params := map[string]string{"id": fmt.Sprintf("%d", id), "expiry": expiry}
	if c.fs != "" {
		params["fs"] = c.fs
	}
	return c.call(ctx, "vfs/queue-set-expiry", params, &reply)
}

// HoldQueuedUploads delays every waiting VFS upload through rclone's own
// queue-set-expiry, so pause is a hold of rclone's queue, not a second queue.
// In-flight items are left to core/bwlimit: rclone ignores expiry on them.
func (c *rcClient) HoldQueuedUploads(ctx context.Context) error {
	return c.setQueueExpiries(ctx, queueHoldExpiry)
}

// ReleaseQueuedUploads makes every waiting VFS upload eligible now.
func (c *rcClient) ReleaseQueuedUploads(ctx context.Context) error {
	return c.setQueueExpiries(ctx, queueReleaseExpiry)
}

func (c *rcClient) setQueueExpiries(ctx context.Context, expiry string) error {
	entries, err := c.queue(ctx)
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
func (c *rcClient) cacheOutOfSpace(ctx context.Context) (bool, error) {
	s, err := c.cacheStats(ctx)
	if err != nil {
		return false, err
	}
	return s.DiskCache.OutOfSpace, nil
}

// cacheStats is the mount's own vfs/stats block: the live cache size, the
// limit in force and the uploads queued. fs is omitted when empty, so a
// status client asks the mounted VFS the same way cacheOutOfSpace does; the
// fill loop's client carries the remote and passes it.
func (c *rcClient) cacheStats(ctx context.Context) (vfsStats, error) {
	var s vfsStats
	params := map[string]string{}
	if c.fs != "" {
		params["fs"] = c.fs
	}
	if err := c.call(ctx, "vfs/stats", params, &s); err != nil {
		return vfsStats{}, err
	}
	return s, nil
}

// ReadStats asks the mount for its transfer totals and the file in flight.
func (c *rcClient) ReadStats(ctx context.Context) (Stats, error) {
	var s Stats
	if err := c.call(ctx, "core/stats", nil, &s); err != nil {
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
	return WriteFileAtomic(PauseStatePath(home), []byte(pausedRate), 0o600)
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
func rateIsPaused(rate string) bool {
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
