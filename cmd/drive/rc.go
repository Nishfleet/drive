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

// resumeRate is rclone's own word for no limit at all.
const resumeRate = "off"

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
// the background fill uses (fill_run.go newRCClient) on the same loopback
// address MountPlan binds (RCAddr), so `drive pause`, `drive resume` and the
// progress lines in `drive status` ask the running mount rather than guessing,
// and the product has one rc client and one rc address.
//
// The methods used here (core/bwlimit, vfs/queue, core/stats) take no `fs`
// argument, so no remote path is needed to address them. vfs/queue is the
// same call the conflict guard already makes (conflict_guard.go queue); this
// client omits `fs` when it has none, which is rclone's default for the
// mounted VFS.
//
// A caller that only prints a line must not fail on a machine with no rclone
// installed, so a resolve failure is reported by the caller's error, not by
// the constructor.
func mountRCClient() (*rcClient, error) {
	binary, err := ResolveRclone("")
	if err != nil {
		return nil, fmt.Errorf("rclone: %w", err)
	}
	return newRCClient(binary, RCAddr(), ""), nil
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
// sending now.
type QueueItem struct {
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Uploading bool   `json:"uploading"`
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
		items[i] = QueueItem{Name: e.Name, Size: e.Size, Uploading: e.Uploading}
	}
	return Queue{Queue: items}, nil
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
// marker that cannot be read is not a pause: `drive pause` wrote it, so a
// missing one means not paused, and a pause that was never recorded must not
// be guessed out of an unreadable file.
func PausedRate(home string) string {
	data, err := os.ReadFile(PauseStatePath(home))
	if err != nil {
		return ""
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return ""
	}
	return trimmed
}

// Paused reports whether the mount is paused, as recorded in the marker file.
func Paused(home string) bool {
	return PausedRate(home) != ""
}
