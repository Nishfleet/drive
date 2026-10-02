package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The rclone remote-control client. `drive pause`, `drive resume` and the
// progress lines in `drive status` all work by asking the running mount the
// question through rclone's own rc API (rclone.org/rc), measured on this host
// 2026-10-03 with rclone v1.75.1 against a `rclone serve s3` stand-in:
//
//   - core/bwlimit with no argument answers the rate in force; core/bwlimit
//     rate="1KiB:off" sets it. rclone's rate is "UP:DOWN" (its own --bwlimit
//     docs), so Tx is the upload direction and the paused rate caps the
//     upload at 1 KiB/s while downloads stay unlimited.
//   - vfs/queue answers one entry per file waiting to upload
//     (name, size, uploading), with no second queue kept by this CLI.
//   - core/stats answers the file in flight now (name, size, bytes,
//     percentage, eta) and the group's totals.
//
// Measured proof that the paused rate stops bytes leaving, same stand-in,
// same file: bytes transferred read 15,626,240 before the call and
// 19,066,880 six seconds after it (the in-flight chunk finished), then
// 19,066,880 again six seconds later — a flat line. rate=off finished the
// file at exactly 157,286,400 bytes with transfers=1, so nothing was lost and
// nothing was sent twice.

// pausedRate is the rclone bandwidth string that pauses uploads and leaves
// downloads alone. rclone's --bwlimit and rc core/bwlimit both read "UP:DOWN"
// (rclone.org/rc "core/bwlimit": `rclone rc core/bwlimit rate=1M:100k`), so
// the upload half is the first one. 1 KiB/s rather than 0, because 0 means
// "off" to rclone and would start the upload at full speed: measured above,
// "1KiB:off" flattens the byte counter while "off" resumes it.
const pausedRate = "1KiB:off"

// resumeRate is rclone's own word for no limit at all.
const resumeRate = "off"

// rcDialTimeout and rcTimeout bound one rc call. `drive status` is what a
// person runs when something is wrong, so a hung socket must turn a status
// line into a named failure rather than a hung terminal.
const (
	rcDialTimeout = 2 * time.Second
	rcTimeout     = 5 * time.Second
)

// RCSocketPath is the unix socket the mount's rclone listens on. It is inside
// the config directory, which WriteFileAtomic creates 0700, so the socket is
// reachable by this user and by root only: the same protection the rclone
// config file gets, and a credential is never needed on this call.
func RCSocketPath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "rc.sock")
}

// PauseStatePath is where the paused state is remembered. rclone's bandwidth
// limit lives in the running process, so a restart of the mount comes back
// unlimited unless this CLI writes the limit into the mount's own command line
// (mount.go BuildMountPlan reads it). An empty file means paused; anything
// else is newer than this read and is refused, not guessed at.
func PauseStatePath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "paused")
}

// rcAddr renders the socket as rclone's --rc-addr value. A TCP listener would
// put an rc endpoint on the machine; a unix socket in a 0700 directory cannot
// be reached from anywhere but this user's processes.
func rcAddr(socketPath string) string {
	return "unix://" + socketPath
}

// rcClient is one rclone rc connection over its unix socket. The transport
// dials the socket directly, so no port, no localhost listener and no origin
// check is ever involved.
type rcClient struct {
	socketPath string
}

// newRCClient returns the client for this mount's socket. It does not connect:
// a caller that only wants to print a status line must not fail on a machine
// with no mount at all.
func newRCClient(socketPath string) *rcClient {
	return &rcClient{socketPath: socketPath}
}

// Post calls one rc method with form-encoded parameters and returns the
// response body. Every failure is named, because a caller that hides one
// prints a queue or a rate that was never read.
func (c *rcClient) Post(method string, params map[string]string) ([]byte, error) {
	body := make(url.Values, len(params))
	for k, v := range params {
		body.Set(k, v)
	}
	req, err := http.NewRequest(http.MethodPost, "http://localhost/"+method, strings.NewReader(body.Encode()))
	if err != nil {
		return nil, fmt.Errorf("rc %s: %w", method, err)
	}
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	client := &http.Client{
		Timeout: rcTimeout,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				_ = ctx
				_ = network
				_ = addr
				return net.DialTimeout("unix", c.socketPath, rcDialTimeout)
			},
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("rc %s: %w", method, err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, fmt.Errorf("rc %s: read: %w", method, err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("rc %s: %s: %s", method, resp.Status, bytes.TrimSpace(out))
	}
	// rclone answers a refused call with 200 and an "error" key, so a failed
	// call must be read as a failure and not as an empty answer.
	var envelope struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(out, &envelope); err == nil && envelope.Error != "" {
		return nil, fmt.Errorf("rc %s: %s", method, envelope.Error)
	}
	return out, nil
}

// BwLimit is the rate rclone is running with right now: what core/bwlimit
// answers with no argument.
type BwLimit struct {
	Rate             string `json:"rate"`
	BytesPerSecond   int64  `json:"bytesPerSecond"`
	BytesPerSecondTx int64  `json:"bytesPerSecondTx"`
}

// SetBwLimit sets the rate. An empty rate means no limit, which is what
// `drive resume` wants.
func (c *rcClient) SetBwLimit(rate string) error {
	params := map[string]string{"rate": rate}
	_, err := c.Post("core/bwlimit", params)
	return err
}

// BwLimit asks what rate is in force.
func (c *rcClient) BwLimit() (BwLimit, error) {
	out, err := c.Post("core/bwlimit", nil)
	if err != nil {
		return BwLimit{}, err
	}
	var l BwLimit
	if err := json.Unmarshal(out, &l); err != nil {
		return BwLimit{}, fmt.Errorf("rc core/bwlimit: parse: %w", err)
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

// ReadQueue asks the mount what it is waiting to send. An absent queue key is
// an empty queue, which is the true answer when nothing has been saved.
func (c *rcClient) ReadQueue() (Queue, error) {
	out, err := c.Post("vfs/queue", nil)
	if err != nil {
		return Queue{}, err
	}
	var q Queue
	if err := json.Unmarshal(out, &q); err != nil {
		return Queue{}, fmt.Errorf("rc vfs/queue: parse: %w", err)
	}
	if q.Queue == nil {
		q.Queue = []QueueItem{}
	}
	return q, nil
}

// Transfer is the file rclone is sending right now, as core/stats names it.
type Transfer struct {
	Name       string   `json:"name"`
	Size       int64    `json:"size"`
	Bytes      int64    `json:"bytes"`
	Percentage int      `json:"percentage"`
	Eta        *float64 `json:"eta"`
}

// Stats is the part of core/stats this file reads: the totals and the one
// transfer in flight.
type Stats struct {
	Bytes          int64      `json:"bytes"`
	TotalBytes     int64      `json:"totalBytes"`
	Transfers      int64      `json:"transfers"`
	TotalTransfers int64      `json:"totalTransfers"`
	Eta            *float64   `json:"eta"`
	Transferring   []Transfer `json:"transferring"`
}

// ReadStats asks the mount for its transfer totals and the file in flight.
func (c *rcClient) ReadStats() (Stats, error) {
	out, err := c.Post("core/stats", nil)
	if err != nil {
		return Stats{}, err
	}
	var s Stats
	if err := json.Unmarshal(out, &s); err != nil {
		return Stats{}, fmt.Errorf("rc core/stats: parse: %w", err)
	}
	if s.Transferring == nil {
		s.Transferring = []Transfer{}
	}
	return s, nil
}

// rcReachable reports whether the mount's socket is there to be asked. A
// socket that does not exist is not a failure: it means no mount is running,
// which is a state `drive status` already prints a line for.
func rcReachable(socketPath string) bool {
	_, err := os.Stat(socketPath)
	return err == nil
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
// the mount starts already paused and no person has to pause it again.
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
