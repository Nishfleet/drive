package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
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
	"unicode"
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
// already computes the money in core/billing.js `usageSummary()`. This file
// only renders what those two already know.

// USAGE_PATH is the api Worker's monthly-usage endpoint (src/index.js routes
// /api/usage to core/billing.js `handleUsageRequest`). The CLI reads the same
// endpoint the usage page reads, so the numbers on this line and the numbers
// on the page cannot disagree.
const USAGE_PATH = "/api/usage"

// usageTimeout bounds the cost read. `drive status` is the command someone
// runs when something is wrong, so a request that hangs must not turn a
// status line into a hung terminal.
const usageTimeout = 10 * time.Second

// runStatus is `drive status`: is it working, what is waiting, how much am I
// spending (drive#117). Three questions, under ten lines. The rclone config
// path, the login item path and the raw entry count are debug detail, not
// answers, so they are not printed. Pause, cache, offline and per-file
// progress stay because they answer those three questions.
func runStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	common := addCommonFlags(fs)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	home := common.home
	goos := CurrentGOOS()
	on, err := Mounted(goos, home)
	if err != nil {
		return err
	}
	mountDir := DefaultMountDir(home)
	if goos == "windows" && on {
		if letter, err := windowsMountLetter(); err == nil {
			mountDir = windowsVolumeRoot(letter)
		}
	}
	var readErr error
	if on {
		_, readErr = countEntries(mountDir, 2*time.Second)
	}
	renderMountState(os.Stdout, on, readErr, mountDir, goos, home)
	queue, err := PendingUploads(DefaultCacheDir(home))
	if err != nil {
		fmt.Printf("uploads: %s\n", failDetail("queue-unreadable", err, DefaultCacheDir(home)).Error())
	} else {
		label := UploadLabel(queue)
		if queue.Bytes > 0 {
			label += " (" + fileSizeLabel(queue.Bytes) + ")"
		}
		fmt.Printf("uploads: %s\n", label)
	}
	if reason := cacheStatusLine(home); reason != "" {
		fmt.Printf("cache: unknown (%s)\n", reason)
	}
	paused := Paused(home)
	cacheLine := ""
	if capBytes, usedBytes, ok := cacheState(home, on); ok {
		cacheLine = cacheCapWhy(capBytes, usedBytes, queue.Bytes, paused, on)
	}
	if cacheLine != "" {
		fmt.Println(cacheLine)
	} else if why := queueWhy(on, cacheIsFull(home, on), paused, queue); why != "" {
		fmt.Println(why)
	}
	if line := conflictGuardLine(home, time.Now()); line != "" {
		fmt.Println(line)
	}
	if lines, reason := rcProgressLines(home, on); lines != "" {
		fmt.Print(limitStatusLines(lines, 3))
	} else if reason != "" {
		fmt.Println(reason)
	}
	fmt.Println(transfersLine(home, on))
	idx, err := LoadOffline(home)
	if err != nil {
		return err
	}
	if idx.Empty() {
		fmt.Println("offline: none")
	} else {
		usage, err := MeasureOffline(mountDir, idx.Paths)
		if err != nil {
			return err
		}
		_, bytes, err := UniqueOffline(mountDir, idx.Paths)
		if err != nil {
			return err
		}
		printOfflineUsage(home, usage, bytes)
	}
	creds, err := LoadCredentials(home)
	if err != nil {
		return err
	}
	base, err := resolveAPIBase(home, *api)
	if err != nil {
		return err
	}
	if reason := readCostLine(base, creds.DeviceToken); reason != "" {
		fmt.Printf("this month: unknown (%s)\n", reason)
	}
	// The once-a-day update notice (drive#560): the last line `drive status`
	// prints. It never fails the command, and it never prints more than once
	// in 24 hours.
	noticeUpdateOnceADay(updateNoticeOptions{home: home})
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
		silence := failDetail("folder-silent", readErr, (2 * time.Second).String(), mountLogHint(goos, home))
		fmt.Fprintf(w, "drive: not responding at %s (%s)\n", mountDir, silence.What)
		fmt.Fprintf(w, "  next: %s\n", silence.Next)
	default:
		fmt.Fprintf(w, "drive: not mounted\n")
		fmt.Fprintf(w, "  next: run `drive mount` (see `drive mount --help` for its flags)\n")
	}
}

// limitStatusLines keeps `drive status` under ten lines (drive#117) when a
// long per-file queue would otherwise fill the screen. The first n lines stay;
// the rest collapse into one "and more" line.
func limitStatusLines(block string, n int) string {
	lines := strings.Split(strings.TrimSuffix(block, "\n"), "\n")
	if len(lines) <= n {
		if strings.HasSuffix(block, "\n") {
			return block
		}
		return block + "\n"
	}
	kept := append([]string(nil), lines[:n]...)
	kept = append(kept, fmt.Sprintf("  ... and %d more", len(lines)-n))
	return strings.Join(kept, "\n") + "\n"
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
// The lines are printed only when the mount answers. A mount that is not
// running is a state the lines above already say, so no second way to report
// that is invented here; an rc answer this file cannot parse is a named
// failure rather than a blank line.
func rcProgressLines(home string, on bool) (string, string) {
	if !on {
		return "", ""
	}
	c, err := mountRCClient(home)
	if err != nil {
		return "", "per file: unknown. Next: run `drive status` again in a moment."
	}
	ctx, cancel := rcCtx()
	defer cancel()
	queue, err := c.ReadQueue(ctx)
	if err != nil {
		return "", "per file: unknown. Next: run `drive status` again in a moment."
	}
	stats, err := c.ReadStats(ctx)
	if err != nil {
		return "", "per file: unknown. Next: run `drive status` again in a moment."
	}
	block := formatRCProgress(queue.Queue, stats)
	if tries := maxUploadTries(queue.Queue); tries > uploadFailingAfterTries {
		f := failf("upload-failing", fmt.Sprintf("%d", tries), mountLogHint(CurrentGOOS(), home))
		block = f.Error() + "\n" + block
	}
	return block, ""
}

// formatRCProgress is the per-file block `drive status` prints: each queued
// file's name, size, percent and time left, then the bytes still to send.
// It is a pure join of rclone's two answers so a unit test can pin the
// columns without a live mount.
func formatRCProgress(items []QueueItem, stats Stats) string {
	inFlight := map[string]Transfer{}
	for _, t := range stats.Transferring {
		inFlight[t.Name] = t
	}
	var b strings.Builder
	var left int64
	for _, item := range items {
		left += item.Size
		progress := "waiting"
		if t, ok := inFlight[item.Name]; ok {
			left -= t.Bytes
			progress = fmt.Sprintf("%d%%, %s left", t.Percentage, etaLabel(t.Eta))
		} else if item.Uploading {
			progress = sendingLabel
		} else if item.Tries > uploadFailingAfterTries {
			progress = uploadFailingProgress(item)
		}
		fmt.Fprintf(&b, "  %s  %s  %s\n",
			uploadFileName(item.Name), fileSizeLabel(item.Size), progress)
	}
	fmt.Fprintf(&b, "bytes left: %s\n", fileSizeLabel(left))
	return b.String()
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

// uploadFailingProgress is the per-file word for a save rclone has failed to
// send more than uploadFailingAfterTries times (issue #543). It names the
// attempt count and the wait rclone itself reports, so the line is rclone's
// numbers, not a guess.
func uploadFailingProgress(item QueueItem) string {
	return fmt.Sprintf("failed %d times, retrying in %s", item.Tries, retryDelayLabel(item.Delay))
}

// retryDelayLabel renders rclone's own queue delay (seconds until the next
// attempt) the way a person reads it. A missing or zero delay is "a moment",
// never a zero that would read as "now".
func retryDelayLabel(seconds float64) string {
	switch secs := int64(seconds); {
	case secs < 1:
		return "a moment"
	case secs < 60:
		return pluralUnit(secs, "second")
	case secs < 3600:
		return pluralUnit(secs/60, "minute")
	default:
		return pluralUnit(secs/3600, "hour")
	}
}

// pluralUnit writes a count and its unit, with the unit singular at one.
func pluralUnit(n int64, unit string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, unit)
	}
	return fmt.Sprintf("%d %ss", n, unit)
}

// maxUploadTries is the highest failed-attempt count in the queue. It decides
// whether `drive status` prints the upload-failing failure, so the summary and
// the per-file lines cannot disagree.
func maxUploadTries(items []QueueItem) int {
	max := 0
	for _, item := range items {
		if item.Tries > max {
			max = item.Tries
		}
	}
	return max
}

// uploadFileName renders the queue entry's name for one column. rclone's
// vfs/queue gives the path with the remote stripped, so it is already the name
// the person saved; a newline in it would break the column, so the name is
// withheld rather than printed across two lines.
func uploadFileName(name string) string {
	for _, r := range name {
		if unicode.IsControl(r) {
			return "(name withheld)"
		}
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
// The answer is rclone's own rate when the mount is up (asked over the remote
// control the mount already binds) and the marker file otherwise, so a drive
// that is paused but not mounted still says Paused rather than nothing.
func transfersLine(home string, on bool) string {
	if !on {
		if Paused(home) {
			return "transfers: " + pausedLabel
		}
		return transfersNotMounted
	}
	c, err := mountRCClient(home)
	if err != nil {
		if Paused(home) {
			return "transfers: " + pausedLabel
		}
		return "transfers: unknown. Next: run `drive status` again in a moment."
	}
	ctx, cancel := rcCtx()
	defer cancel()
	limit, err := c.BwLimit(ctx)
	if err != nil {
		if Paused(home) {
			return "transfers: " + pausedLabel
		}
		return "transfers: unknown. Next: run `drive status` again in a moment."
	}
	if rateIsPaused(limit.Rate) {
		return "transfers: " + pausedLabel
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
	Dirty       bool   `json:"Dirty"`
	Size        int64  `json:"Size"`
	Fingerprint string `json:"Fingerprint"`
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
			// A crash can leave rclone's meta file half-written (drive issue
			// #107). That file is not a queue entry yet, and must not hide
			// the files that did parse. Complete junk is still an error, so
			// "up to date" cannot come from a cache we cannot read.
			trimmed := bytes.TrimSpace(data)
			if len(trimmed) == 0 || (trimmed[0] == '{' && !json.Valid(data)) {
				return nil
			}
			return fmt.Errorf("parse vfs metadata %s: %w", path, err)
		}
		if !meta.Dirty {
			return nil
		}
		q.Files++
		q.Bytes += meta.Size
		q.Names = append(q.Names, filepath.Base(path))
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
	// Names are the dirty files' names, so `drive status` can say what is
	// waiting when the mount is down and rclone's vfs/queue cannot answer
	// (drive issue #107, the crash case).
	Names []string
}

// UPLOAD_WORDS are the words `drive status` uses for the queue, kept next to
// the words the first-run page uses for the same queue (core/status.js
// `UPLOAD_LABEL`). The page is a static asset and cannot import the module,
// and the Go caller cannot import the page, so the two copies are the same
// words by construction: an empty queue says "Up to date" on both, one file
// says "Uploading 1 file" on both, and more than one says "Uploading N
// files". test/status_test.mjs is the gate that keeps the page to this list.
const (
	upToDateLabel  = "Up to date"
	uploadingLabel = "Uploading %d file"
	uploadingMany  = "Uploading %d files"
	// waitingToUploadWhy is the reason `drive status` prints when files are
	// queued and the mount is up: rclone's VFS cache will send them. The
	// unmounted pair is the crash case (drive issue #107): the files are
	// still in the cache, and they go up when the drive is mounted again.
	waitingToUploadWhy   = "They are waiting to upload."
	waitingUnmountedWhy  = "They are waiting because the drive is not mounted."
	waitingUnmountedNext = "They will upload when the drive is mounted again."
	diskCacheFullWhat    = "The local cache is full, so new saves can't upload."
	diskCacheFullNext    = "Free up disk space on this device and try the save again."
	// uploadFailingAfterTries is how many failed attempts a save may have before
	// `drive status` calls it failing rather than merely waiting (issue #543).
	// rclone retries forever with a 5-minute backoff, so without this threshold a
	// dead upload reads as "waiting" and the person never learns it stopped.
	uploadFailingAfterTries = 3
)

// conflictGuardLine is the status line for a conflict guard that cannot
// keep up with the saves coming in: more saves are waiting for their first
// hash than one pass can take (conflictSightMax), so protection of the rest
// waits for the passes that follow. An empty string is "no answer": the
// guard is not running, or it is keeping up, and neither is a problem to
// name.
func conflictGuardLine(home string, now time.Time) string {
	behind := conflictGuardBehind(ConflictGuardStatePath(home), now)
	if behind <= conflictSightMax {
		return ""
	}
	return fmt.Sprintf("conflict guard behind by %d saves", behind)
}

// queueWhy is the line after the uploads count: what is waiting and why
// (drive issue #107). An empty queue with space left is a complete state and
// prints nothing extra. A full cache is a failure even with nothing queued,
// because that is the save that just bounced. Pause is issue #100's words on
// the transfers line, so this function stays silent while paused unless the
// cache is also full.
func queueWhy(on, outOfSpace, paused bool, q Pending) string {
	if outOfSpace {
		return diskCacheFullWhat + " " + diskCacheFullNext
	}
	if paused || q.Files == 0 {
		return ""
	}
	if !on {
		var b strings.Builder
		for _, name := range q.Names {
			fmt.Fprintf(&b, "  %s\n", uploadFileName(name))
		}
		fmt.Fprintf(&b, "%s %s", waitingUnmountedWhy, waitingUnmountedNext)
		return b.String()
	}
	return waitingToUploadWhy
}

// cacheIsFull is whether the VFS cache disk cannot take another save. The
// mount's own answer is rclone rc vfs/stats diskCache.outOfSpace (rclone.org
// mount, the field the fill loop already reads). When the mount is down, or
// that call cannot answer, the cache directory's free space is the same
// question asked of the kernel.
func cacheIsFull(home string, on bool) bool {
	if on {
		c, err := mountRCClient(home)
		if err == nil {
			ctx, cancel := rcCtx()
			defer cancel()
			if full, err := c.cacheOutOfSpace(ctx); err == nil && full {
				return true
			}
		}
	}
	return cacheDiskHasNoSpace(DefaultCacheDir(home))
}

// cacheState is the VFS cache's own limit and live size, read from the
// running mount's vfs/stats. ok is false when the mount is down or does not
// answer, so a caller never mistakes an absent answer for a zero cap.
func cacheState(home string, on bool) (capBytes, usedBytes int64, ok bool) {
	if !on {
		return 0, 0, false
	}
	c, err := mountRCClient(home)
	if err != nil {
		return 0, 0, false
	}
	ctx, cancel := rcCtx()
	defer cancel()
	s, err := c.cacheStats(ctx)
	if err != nil {
		return 0, 0, false
	}
	return s.Opt.CacheMaxSize, s.DiskCache.BytesUsed, true
}

// cacheCapWhy is the line `drive status` prints when unsent saves have pushed
// the VFS cache past its cap (issue #543). rclone evicts only clean items, so
// a stuck upload queue grows the cache past --vfs-cache-max-size; the old
// "free up disk space" line named the wrong cause. The cause here is the real
// one: the drive is paused, not mounted, or uploads are simply behind.
// dirtyBytes is the sum of the queue's sizes (the unsent saves); usedBytes is
// rclone's own diskCache.bytesUsed. It is silent while the cache is inside its
// cap.
func cacheCapWhy(capBytes, usedBytes, dirtyBytes int64, paused, on bool) string {
	if capBytes <= 0 || (dirtyBytes <= capBytes && usedBytes <= capBytes) {
		return ""
	}
	var cause string
	switch {
	case paused:
		cause = fileSizeLabel(dirtyBytes) + " of saves are waiting because the drive is paused"
	case !on:
		cause = fileSizeLabel(dirtyBytes) + " of saves are waiting because the drive is not mounted"
	default:
		cause = fileSizeLabel(dirtyBytes) + " of saves are waiting because uploads are behind"
	}
	return failf("cache-over-cap", fileSizeLabel(capBytes), cause).Error()
}

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

// UsageSummary is the shape GET /api/usage returns (core/billing.js
// `usageSummary()`): the month's numbers and the cap. The CLI decodes the two
// halves it prints and no more, so the money is computed once, in the Worker,
// by the code that owns the prices.
type UsageSummary struct {
	MeteredUsd float64 `json:"meteredUsd"`
	BillUsd    float64 `json:"billUsd"`
	MaximumUsd float64 `json:"maximumUsd"`
	CapLine    string  `json:"capLine"`
	// BalanceLine is the prepaid balance (drive#586), written by the Worker
	// (core/topup.js balanceLine) with the top-up prompt when it is low or $0.
	// Empty from a Worker that has no balance store yet.
	BalanceLine string `json:"balanceLine"`
	// FairUseLine is the fair-use pause line (drive#364), written by the
	// Worker (core/billing.js fairUseLine) from the same check the upload
	// path uses. Null (or empty) when the meter could not be read: the
	// Worker sends JSON null, which a Go string cannot decode.
	FairUseLine *string `json:"fairUseLine"`
	Cap         struct {
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
func readCostLine(apiBase, token string) string {
	if strings.TrimSpace(apiBase) == "" {
		return fail("no-api").Error()
	}
	base, err := parseAPIBase(apiBase)
	if err != nil {
		return err.Error()
	}
	req, err := http.NewRequest(http.MethodGet, base+USAGE_PATH, nil)
	if err != nil {
		return failDetail("unexpected", err).Error()
	}
	if token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
	req.Header.Set("user-agent", userAgent())
	client := &http.Client{Timeout: usageTimeout}
	resp, err := client.Do(req)
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
	line := strings.TrimSpace(u.CapLine)
	if line == "" {
		return fail("api-answer").Error()
	}
	fmt.Println(line)
	if balance := strings.TrimSpace(u.BalanceLine); balance != "" {
		fmt.Println(balance)
	}
	if u.FairUseLine != nil {
		if fairUse := strings.TrimSpace(*u.FairUseLine); fairUse != "" {
			fmt.Println(fairUse)
		}
	}
	return ""
}

// parseAPIBase checks the api Worker URL and drops its trailing slash, so the
// endpoint path is appended the same way every time. A URL is operator
// config, but it is printed and put in an error, so it is held to the same
// rule as the secret itself (issue #75):
//
//   - user:password@ in a URL is a credential on the command line and in every
//     line that prints the URL, so it is refused rather than carried;
//   - no error here echoes the value back. Each failure names the fault and
//     stops, because a URL that parses as scheme "user" and opaque
//     "password@host" clears every parsed field a check could look at, so
//     "check first, then print" is not a rule a new branch can rely on;
//   - a secret goes over TLS, so plain http is only good enough on loopback.
//
// The same rejection config.go applies to a rclone config value applies here: a
// newline would break the line it is printed on, and a NUL byte is never a URL.
func parseAPIBase(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if err := checkConfigValue("api Worker URL", trimmed); err != nil {
		return "", err
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		// url.Error's message quotes the URL it was given, and that URL may
		// carry a credential. The inner error names the actual fault (a bad
		// port, a bad escape) without repeating the value, so that is what is
		// reported.
		if inner := errors.Unwrap(err); inner != nil {
			return "", fmt.Errorf("api Worker URL does not parse: %v", inner)
		}
		return "", errors.New("api Worker URL does not parse")
	}
	if u.User != nil {
		return "", errors.New("api Worker URL carries credentials; the key is sent in the Authorization header, not in the URL")
	}
	if u.Opaque != "" {
		return "", errors.New("api Worker URL does not name a host")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("api Worker URL must be http or https")
	}
	if u.Host == "" {
		return "", errors.New("api Worker URL has no host")
	}
	// A secret travels only over TLS. Plain http is accepted for the loopback
	// hosts the stand-in server and a local dev Worker use, and nowhere else:
	// the storage secret is in every request this CLI makes to the Worker, and
	// cleartext to a remote host is the same exposure as a flag in ps.
	if u.Scheme == "http" && !loopbackHost(u.Hostname()) {
		return "", fmt.Errorf("api Worker URL must be https://%s ...; plain http carries the storage secret in the clear", u.Host)
	}
	return strings.TrimSuffix(trimmed, "/"), nil
}

// loopbackHost reports whether host is this machine. The stand-in server, a
// local dev Worker and the test server all talk over loopback, where cleartext
// never leaves the machine.
//
// The whole 127.0.0.0/8 block and the IPv6 loopback are this machine, not just
// 127.0.0.1, and `localhost` is matched without regard to case the way DNS
// resolves it. A name that is an IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)
// is loopback too: net.IP.IsLoopback knows all of them, so the check goes
// through it rather than a hand-written list of spellings that would silently
// fall out of date.
func loopbackHost(host string) bool {
	if strings.EqualFold(strings.Trim(host, "[]"), "localhost") {
		return true
	}
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// cacheStatusLine prints the cache line and returns the reason it could not be
// printed (empty when it was). It is `drive cache`'s own line, with the same
// walk and the same limit, kept here so the two commands cannot drift.
func cacheStatusLine(home string) string {
	used, files, err := CacheUse(DefaultCacheDir(home))
	if err != nil {
		return err.Error()
	}
	maxSize, err := ResolveCacheMax(home)
	if err != nil {
		return err.Error()
	}
	fmt.Printf("cache: %s in %d files, limit %s\n", FormatBytes(used), files, maxSize)
	return ""
}
