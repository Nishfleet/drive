package main

import (
	"encoding/json"
	"flag"
	"fmt"
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

// runStatus is `drive status`: the mount state, the upload queue and the
// month's cost.
func runStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	common := addCommonFlags(fs)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	home := common.home
	mountDir := DefaultMountDir(home)
	on, err := Mounted(CurrentGOOS(), home)
	if err != nil {
		return err
	}
	state := "not mounted"
	if on {
		state = "mounted"
	}
	fmt.Printf("drive: %s\n", state)
	fmt.Printf("mount dir: %s\n", mountDir)
	fmt.Printf("rclone config: %s\n", RcloneConfigPath(home))
	loginItem := LoginItemPath(CurrentGOOS(), home)
	exists := "absent"
	if _, err := os.Stat(loginItem); err == nil {
		exists = "present"
	}
	fmt.Printf("login item: %s (%s)\n", loginItem, exists)
	if n, err := countEntries(mountDir, 2*time.Second); err != nil {
		fmt.Printf("entries: (unreadable: %v)\n", err)
	} else if n > 0 {
		fmt.Printf("entries: %d\n", n)
	}
	// The upload queue is read from the cache directory the mount was started
	// with (`--cache-dir`, the same DefaultCacheDir), so it is the queue of
	// this mount and not of some other drive.
	queue, err := PendingUploads(DefaultCacheDir(home))
	if err != nil {
		return err
	}
	fmt.Printf("uploads: %s\n", UploadLabel(queue))
	if lines, reason := rcProgressLines(home, on); lines != "" {
		fmt.Print(lines)
	} else if reason != "" {
		fmt.Println(reason)
	}
	// Whether the bytes are leaving at all, in the one word the pages use
	// (src/status.js UPLOAD_LABEL.paused). The answer is rclone's own: the rate
	// in force, asked through rc (rc.go), with the marker file beside it so a
	// mount that is not up still says Paused rather than nothing.
	fmt.Println(transfersLine(home, on, RCSocketPath(home)))
	if reason := readCostLine(*api); reason != "" {
		fmt.Printf("this month: unknown (%s)\n", reason)
	}
	return nil
}

// rcProgressLines renders the per-file progress `drive status` shows (drive
// issue #100): each file waiting or in flight, its size, its percent and its
// time left, then the total left. Every number is read from rclone's own rc
// answers: vfs/queue for what is waiting and how big it is, core/stats for the
// file in flight (percentage and eta) and the bytes already up. Measured on
// this host 2026-10-03 with rclone v1.75.1 against a `rclone serve s3`
// stand-in: a 10 MiB file read back
// `"name": "shape.bin", "size": 10485760, "uploading": false` from vfs/queue
// while it waited.
//
// The lines are printed only when the mount answers. An absent socket means no
// mount is running, which the lines above already say, so no second way to
// report that is invented here; a socket that answers something this file
// cannot parse is a named failure rather than a blank line.
func rcProgressLines(home string, on bool) (string, string) {
	if !on {
		return "", ""
	}
	socket := RCSocketPath(home)
	if !rcReachable(socket) {
		return "", ""
	}
	c := newRCClient(socket)
	queue, err := c.ReadQueue()
	if err != nil {
		return "", fmt.Sprintf("per file: unknown (%v)", err)
	}
	stats, err := c.ReadStats()
	if err != nil {
		return "", fmt.Sprintf("per file: unknown (%v)", err)
	}
	// The file in flight, by the name rclone uses in both answers, so the
	// percentage from core/stats lands on the right queue entry.
	inFlight := map[string]Transfer{}
	for _, t := range stats.Transferring {
		inFlight[t.Name] = t
	}
	var b strings.Builder
	var left int64
	for _, item := range queue.Queue {
		left += item.Size
		progress := "waiting"
		if t, ok := inFlight[item.Name]; ok {
			// Bytes already up come off the total left: rclone counts the whole
			// file in the queue until it finishes, and "left" means what is still
			// to send.
			left -= t.Bytes
			progress = fmt.Sprintf("%d%%, %s left", t.Percentage, etaLabel(t.Eta))
		} else if item.Uploading {
			progress = sendingLabel
		}
		fmt.Fprintf(&b, "  %s  %s  %s\n",
			uploadFileName(item.Name), fileSizeLabel(item.Size), progress)
	}
	// A file rclone has finished since the queue was read is in the stats and
	// not in the queue, so its bytes are not left to send: the queue is the only
	// thing counted, and the stats only ever subtract from it.
	fmt.Fprintf(&b, "bytes left: %s\n", fileSizeLabel(left))
	return b.String(), ""
}

// sendingLabel is the word for the one file rclone says it is sending but has
// no percentage for yet.
const sendingLabel = "sending"

// etaLabel renders rclone's own eta (seconds until the file finishes, null
// when rclone cannot know) as a person reads it. An unknown eta is "unknown",
// never a zero that would read as "now".
func etaLabel(eta *float64) string {
	if eta == nil {
		return "unknown"
	}
	seconds := int64(*eta)
	if seconds < 0 {
		seconds = 0
	}
	switch {
	case seconds < 60:
		return fmt.Sprintf("%ds", seconds)
	case seconds < 3600:
		return fmt.Sprintf("%dm %02ds", seconds/60, seconds%60)
	default:
		return fmt.Sprintf("%dh %02dm", seconds/3600, (seconds%3600)/60)
	}
}

// uploadFileName renders the queue entry's name for one column. rclone's
// vfs/queue gives the path with the remote stripped, so it is already the name
// the person saved; a newline in it would break the column, so the name is
// withheld rather than printed across two lines.
func uploadFileName(name string) string {
	if strings.ContainsAny(name, "\r\n") {
		return "(name withheld)"
	}
	return name
}

// fileSizeLabel renders one size for the per-file column, in the KiB the
// storage side works in.
func fileSizeLabel(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(bytes)/float64(div), "KMGTPE"[exp])
}

// transfersLine is the transfers line: whether the bytes are leaving at all.
// The answer is rclone's own rate when the mount is up (asked through rc) and
// the marker file otherwise, so a drive that is paused but not mounted still
// says Paused rather than nothing.
func transfersLine(home string, on bool, socket string) string {
	if !on {
		return transfersNotMounted
	}
	if Paused(home) {
		return "transfers: " + pausedLabel
	}
	if !rcReachable(socket) {
		return transfersRunning
	}
	limit, err := newRCClient(socket).BwLimit()
	if err != nil {
		return "transfers: unknown (" + err.Error() + ")"
	}
	if limit.Rate == resumeRate {
		return transfersRunning
	}
	// A rate rclone did not set to off is not a full-speed upload. Name it
	// rather than guessing a number out of it.
	return "transfers: limited to " + limit.Rate
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
// number and never fails the whole command: the mount lines above are already
// true, and a person who cannot reach the usage service still needs to know
// whether the drive is mounted. The reason is printed with it, so a missing
// number is always a named failure rather than a quiet zero.
func readCostLine(apiBase string) string {
	if strings.TrimSpace(apiBase) == "" {
		return "no api Worker configured; set --api or DRIVE_API_URL"
	}
	base, err := parseAPIBase(apiBase)
	if err != nil {
		return err.Error()
	}
	client := &http.Client{Timeout: usageTimeout}
	resp, err := client.Get(base + USAGE_PATH)
	if err != nil {
		return fmt.Sprintf("GET %s: %v", base+USAGE_PATH, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Sprintf("GET %s: %s", base+USAGE_PATH, resp.Status)
	}
	var u UsageSummary
	if err := json.NewDecoder(resp.Body).Decode(&u); err != nil {
		return fmt.Sprintf("GET %s: %v", base+USAGE_PATH, err)
	}
	fmt.Printf("this month: %s of %s cap (%s)\n",
		USD(u.MeteredUsd), USD(u.Cap.CapUsd), costState(u.Cap.State))
	return ""
}

// costState turns the cap's own state into the word on this line, and says
// what to do about it. `active` is the quiet word; `read_only` is the one a
// person has to act on, so it carries the reason (src/billing.js
// `capStatus()`).
func costState(state string) string {
	if state == "read_only" {
		return "read-only, writes are off until the cap is raised"
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
// config, but it is printed and put in an error, so the same rejection
// config.go applies to a rclone config value applies here: a newline would
// break the line it is printed on, and a NUL byte is never a URL.
func parseAPIBase(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if err := checkConfigValue("api Worker URL", trimmed); err != nil {
		return "", err
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("api Worker URL %q: %w", trimmed, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("api Worker URL %q must be http or https", trimmed)
	}
	if u.Host == "" {
		return "", fmt.Errorf("api Worker URL %q has no host", trimmed)
	}
	return strings.TrimSuffix(trimmed, "/"), nil
}
