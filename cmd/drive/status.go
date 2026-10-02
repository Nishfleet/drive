package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The rest of `drive status`: the lines that say what the drive is doing, not
// just whether it is mounted (issue #54, "Step 4 remainder"). Step 2 shipped
// the mount lines; this file adds the two a person actually opens `drive
// status` for:
//
//   - files waiting to upload, read from rclone's own VFS cache metadata, and
//   - this month's cost and the cap, read from the api Worker's usage endpoint.
//
// Both answers come from something that already exists rather than a second
// way to ask: rclone writes the queue as it queues it, and the api Worker
// already computes the money in src/billing.js `usageSummary()`. This file
// only renders what those two already know.

// USAGE_PATH is the api Worker's monthly-usage endpoint (src/index.js routes
// /api/usage to src/billing.js `handleUsageRequest`). The CLI reads the same
// endpoint the usage page reads, so the numbers on this line and the numbers
// on the page cannot disagree.
const USAGE_PATH = "/api/usage"

// usageTimeout bounds the cost read. `drive status` is the command someone
// runs when something is wrong, so a request that hangs must not turn a
// status line into a hung terminal.
const usageTimeout = 10 * time.Second

// runStatus is `drive status`: is it working, what is waiting, how much am I
// spending (drive#117). Three questions, one line each, and a next step on
// every line that is not good news. It stays under ten lines by printing only
// the answers: the path it is mounted at, the upload queue, the month's
// cost. The rclone config path and the login item path are debug detail, not
// answers, so they are no longer printed.
func runStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	common := addCommonFlags(fs)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	home := common.home
	goos := CurrentGOOS()
	mountDir := DefaultMountDir(home)
	on, err := Mounted(goos, home)
	if err != nil {
		return err
	}
	var readErr error
	if on {
		_, readErr = countEntries(mountDir, 2*time.Second)
	}
	renderMountState(os.Stdout, on, readErr, mountDir, goos, home)
	// The upload queue is read from the cache directory the mount was started
	// with (`--cache-dir`, the same DefaultCacheDir), so it is the queue of
	// this mount and not of some other drive.
	queue, err := PendingUploads(DefaultCacheDir(home))
	if err != nil {
		fmt.Printf("uploads: %s\n", failDetail("queue-unreadable", err, DefaultCacheDir(home)).Error())
	} else {
		label := UploadLabel(queue)
		if queue.Bytes > 0 {
			label += " (" + humanBytes(queue.Bytes) + ")"
		}
		fmt.Printf("uploads: %s\n", label)
	}
	if reason := readCostLine(*api); reason != "" {
		fmt.Printf("this month: unknown (%s)\n", reason)
	}
	return nil
}

// renderMountState prints the mount's answer to "is it working": mounted and
// answering, mounted but not answering, or not mounted with the exact start
// command. It is a function so all three branches stay testable without a
// real FUSE mount.
func renderMountState(w io.Writer, on bool, readErr error, mountDir, goos, home string) {
	switch {
	case on && readErr == nil:
		fmt.Fprintf(w, "drive: mounted at %s\n", mountDir)
	case on:
		// A mount the kernel knows but that does not answer is the one state
		// where "mounted" would be a lie: say so, and name the log and the
		// restart commands.
		silence := failDetail("folder-silent", readErr, (2 * time.Second).String(), mountLogHint(goos, home))
		fmt.Fprintf(w, "drive: not responding at %s (%s)\n", mountDir, silence.What)
		fmt.Fprintf(w, "  next: %s\n", silence.Next)
	default:
		fmt.Fprintf(w, "drive: not mounted\n")
		fmt.Fprintf(w, "  next: run `drive mount` (see `drive mount --help` for its flags)\n")
	}
}

// humanBytes renders a byte count the way the queue line reads it: one decimal
// below a mebibyte, whole units above. The go.mod has no dependencies by
// design, so this is the whole function rather than a new module.
func humanBytes(n int64) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%d B", n)
	case n < 1024*1024:
		return fmt.Sprintf("%.1f KB", float64(n)/1024)
	case n < 1024*1024*1024:
		return fmt.Sprintf("%.1f MB", float64(n)/(1024*1024))
	default:
		return fmt.Sprintf("%.1f GB", float64(n)/(1024*1024*1024))
	}
}

// VFSMeta is the part of rclone's VFS cache metadata this file reads. rclone
// writes one JSON file per cached object under `<cache-dir>/vfsMeta/<remote>/`
// and sets Dirty while the object is waiting to go up; once the upload
// succeeds the same file carries the remote's fingerprint and Dirty is false.
// Measured on this host 2026-09-30 with rclone v1.75.1 against a
// `rclone serve s3` stand-in: a 300 MiB file read back `"Dirty": true` with
// no fingerprint while it was queued, and the same file read
// `"Fingerprint": "2,2026-09-30 11:27:22...,401b30e3..."` with
// `"Dirty": false` after the log line `vfs cache: upload succeeded try #1`.
// rclone is asked about nothing and no file format is invented here: the
// queue is read where rclone itself records it.
type VFSMeta struct {
	Dirty bool  `json:"Dirty"`
	Size  int64 `json:"Size"`
}

// PendingUploads counts the files rclone has in its VFS cache and has not
// finished uploading, and their total size. An absent cache directory is zero
// pending, which is the true answer: nothing has ever been queued. A metadata
// file that does not parse is an error, not a silent zero, because a queue
// that cannot be read must never be printed as "up to date".
func PendingUploads(cacheDir string) (Pending, error) {
	metaRoot := filepath.Join(cacheDir, "vfsMeta")
	if _, err := os.Stat(metaRoot); err != nil {
		if os.IsNotExist(err) {
			return Pending{}, nil
		}
		return Pending{}, fmt.Errorf("stat %s: %w", metaRoot, err)
	}
	var q Pending
	err := filepath.WalkDir(metaRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read %s: %w", path, err)
		}
		var meta VFSMeta
		if err := json.Unmarshal(data, &meta); err != nil {
			return fmt.Errorf("parse vfs metadata %s: %w", path, err)
		}
		if !meta.Dirty {
			return nil
		}
		q.Files++
		q.Bytes += meta.Size
		return nil
	})
	if err != nil {
		return Pending{}, fmt.Errorf("read the upload queue: %w", err)
	}
	return q, nil
}

// Pending is what the upload queue holds right now: how many files are still
// waiting, and how many bytes they are.
type Pending struct {
	Files int
	Bytes int64
}

// UPLOAD_WORDS are the words `drive status` uses for the queue, kept next to
// the words the first-run page uses for the same queue (src/status.js
// `UPLOAD_LABEL`). The page is a static asset and cannot import the module,
// and the Go caller cannot import the page, so the two copies are the same
// words by construction: an empty queue says "Up to date" on both, one file
// says "Uploading 1 file" on both, and more than one says "Uploading N
// files". test/status_test.mjs is the gate that keeps the page to this list.
const (
	upToDateLabel  = "Up to date"
	uploadingLabel = "Uploading %d file"
	uploadingMany  = "Uploading %d files"
)

// UploadLabel renders the queue line. Zero files is a complete state, not an
// error and not a division by zero: the answer is that nothing is waiting.
func UploadLabel(q Pending) string {
	switch {
	case q.Files == 0:
		return upToDateLabel
	case q.Files == 1:
		return fmt.Sprintf(uploadingLabel, 1)
	default:
		return fmt.Sprintf(uploadingMany, q.Files)
	}
}

// UsageSummary is the shape GET /api/usage returns (src/billing.js
// `usageSummary()`): the month's numbers and the cap. The CLI decodes the two
// halves it prints and no more, so the money is computed once, in the Worker,
// by the code that owns the prices.
type UsageSummary struct {
	MeteredUsd float64 `json:"meteredUsd"`
	BillUsd    float64 `json:"billUsd"`
	CeilingUsd float64 `json:"ceilingUsd"`
	Cap        struct {
		CapUsd       float64 `json:"capUsd"`
		CountedUsd   float64 `json:"countedUsd"`
		RemainingUsd float64 `json:"remainingUsd"`
		State        string  `json:"state"`
	} `json:"cap"`
}

// readCostLine prints this month's cost and the cap, and returns the reason
// the numbers are unknown (empty when they are known). It never invents a
// number, never fails the whole command, and never prints a raw network
// error: every reason is the message table's words (drive#117), so a missing
// number is always a named failure with a next step rather than a quiet zero.
func readCostLine(apiBase string) string {
	if strings.TrimSpace(apiBase) == "" {
		return fail("no-api").Error()
	}
	base, err := parseAPIBase(apiBase)
	if err != nil {
		return err.Error()
	}
	client := &http.Client{Timeout: usageTimeout}
	resp, err := client.Get(base + USAGE_PATH)
	if err != nil {
		return failDetail("offline", err).Error()
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return fail("not-signed-in").Error()
		}
		return fail("api-down").Error()
	}
	var u UsageSummary
	if err := json.NewDecoder(resp.Body).Decode(&u); err != nil {
		return failDetail("api-answer", err).Error()
	}
	fmt.Printf("this month: %s of %s cap (%s)\n",
		USD(u.MeteredUsd), USD(u.Cap.CapUsd), costState(u.Cap.State))
	return ""
}

// costState turns the cap's own state into the word on this line, and says
// what to do about it. `active` is the quiet word; `read_only` is the one a
// person has to act on, so it carries the cap-reached words from the message
// table - the same words the web pages use (src/messages.js, drive#117).
func costState(state string) string {
	if state == "read_only" {
		return fail("cap-reached").Error()
	}
	return state
}

// USD renders dollars the way a bill and a terminal agree on: cents always, so
// "$0.00" never looks like a missing number and "$12.00" never looks like a
// whole dollar the cap does not mean.
func USD(amount float64) string {
	return fmt.Sprintf("$%.2f", amount)
}

// parseAPIBase checks the api Worker URL and drops its trailing slash, so the
// endpoint path is appended the same way every time. A URL is operator
// config, but it is printed and put in an error, so a newline would break the
// line it is printed on and a NUL byte is never a URL: both come back as the
// api-url table failure, which names the fix.
func parseAPIBase(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if err := checkConfigValue("api Worker URL", trimmed); err != nil {
		return "", failf("api-url", trimmed)
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", failf("api-url", trimmed)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", failf("api-url", trimmed)
	}
	if u.Host == "" {
		return "", failf("api-url", trimmed)
	}
	return strings.TrimSuffix(trimmed, "/"), nil
}
