package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/Nishfleet/drive/internal/api"
)

// USAGE_PATH is the api Worker's monthly-usage endpoint (src/index.js routes /api/usage to core/billing.js `handleUsageRequest`).
const USAGE_PATH = "/api/usage"

const usageTimeout = 10 * time.Second

func troubleshootingDocsLine() string { return "what to try: " + docsTroubleshootingURL() }

func runStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	common := addCommonFlags(fs)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	home := common.home
	goos := CurrentGOOS()
	on, listErr := Mounted(goos, home)
	mountDir := DefaultMountDir(home)
	if goos == "windows" && on && listErr == nil {
		if letter, err := windowsMountLetter(); err == nil {
			mountDir = windowsVolumeRoot(letter)
		}
	}
	var readErr error
	if listErr == nil && on {
		_, readErr = countEntries(mountDir, 2*time.Second)
	}
	on, readErr = mountView(on, listErr, readErr)
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
	idx, idxErr := LoadOffline(home)
	if idxErr != nil {
		fmt.Printf("offline: unknown (%s)\n", idxErr.Error())
	} else if idx.Empty() {
		fmt.Println("offline: none")
	} else {
		usage, err := MeasureOffline(mountDir, idx.Paths)
		if err != nil {
			fmt.Printf("offline: unknown (%s)\n", err.Error())
		} else {
			_, bytes, err := UniqueOffline(mountDir, idx.Paths)
			if err != nil {
				fmt.Printf("offline: unknown (%s)\n", err.Error())
			} else {
				printOfflineUsage(home, usage, bytes)
			}
		}
	}
	creds, credsErr := LoadCredentials(home)
	switch {
	case credsErr != nil:
		fmt.Printf("this month: unknown (%s)\n", credsErr.Error())
	default:
		base, err := resolveAPIBase(home, *api)
		if err != nil {
			fmt.Printf("this month: unknown (%s)\n", err.Error())
		} else if reason := readCostLine(base, creds.DeviceToken); reason != "" {
			fmt.Printf("this month: unknown (%s)\n", reason)
		}
	}
	if line := deviceRenewStatusLine(home); line != "" {
		fmt.Println(line)
	}
	fmt.Println(troubleshootingDocsLine())
	noticeUpdateOnceADay(updateNoticeOptions{home: home})

	return nil
}

func mountView(on bool, listErr, readErr error) (bool, error) {
	if listErr != nil {
		return true, listErr
	}
	return on, readErr
}

func renderMountState(w io.Writer, on bool, readErr error, mountDir, goos, home string) {
	switch {
	case on && readErr == nil:
		fmt.Fprintf(w, "drive: mounted at %s\n", mountDir)
	case on:
		stale := failDetail("stale-mount", readErr, mountDir)
		fmt.Fprintf(w, "drive: stale mount at %s (%s)\n", mountDir, stale.What)
		fmt.Fprintf(w, "  next: %s\n", stale.Next)
	default:
		fmt.Fprintf(w, "drive: not mounted\n")
		fmt.Fprintf(w, "  next: run `drive mount` (see `drive mount --help` for its flags)\n")
	}
}

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

const sendingLabel = "sending"

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

func uploadFailingProgress(item QueueItem) string {
	return fmt.Sprintf("failed %d times, retrying in %s", item.Tries, retryDelayLabel(item.Delay))
}

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

func pluralUnit(n int64, unit string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, unit)
	}
	return fmt.Sprintf("%d %ss", n, unit)
}

func maxUploadTries(items []QueueItem) int {
	max := 0
	for _, item := range items {
		if item.Tries > max {
			max = item.Tries
		}
	}
	return max
}

func uploadFileName(name string) string {
	for _, r := range name {
		if unicode.IsControl(r) {
			return "(name withheld)"
		}
	}
	return name
}

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
	return "transfers: limited to " + limit.Rate
}

// VFSMeta is the part of rclone's VFS cache metadata this file reads.
type VFSMeta struct {
	Dirty       bool   `json:"Dirty"`
	Size        int64  `json:"Size"`
	Fingerprint string `json:"Fingerprint"`
}

// PendingUploads counts the files rclone has in its VFS cache and has not finished uploading, and their total size.
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

// Pending is what the upload queue holds right now: how many files are still waiting, and how many bytes they are.
type Pending struct {
	Files int
	Bytes int64
	Names []string
}

const (
	upToDateLabel           = "Up to date"
	uploadingLabel          = "Uploading %d file"
	uploadingMany           = "Uploading %d files"
	waitingToUploadWhy      = "They are waiting to upload."
	waitingUnmountedWhy     = "They are waiting because the drive is not mounted."
	waitingUnmountedNext    = "They will upload when the drive is mounted again."
	diskCacheFullWhat       = "The local cache is full, so new saves can't upload."
	diskCacheFullNext       = "Free up disk space on this device and try the save again."
	uploadFailingAfterTries = 3
)

func conflictGuardLine(home string, now time.Time) string {
	behind := conflictGuardBehind(ConflictGuardStatePath(home), now)
	if behind <= conflictSightMax {
		return ""
	}
	return fmt.Sprintf("conflict guard behind by %d saves", behind)
}

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

// UploadLabel renders the queue line.
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

// UsageSummary is the shape GET /api/usage returns (core/billing.js `usageSummary()`): the month's numbers and the cap.
type UsageSummary struct {
	MeteredUsd  float64 `json:"meteredUsd"`
	BillUsd     float64 `json:"billUsd"`
	MaximumUsd  float64 `json:"maximumUsd"`
	CapLine     string  `json:"capLine"`
	BalanceLine string  `json:"balanceLine"`
	FairUseLine *string `json:"fairUseLine"`
	Cap         struct {
		CapUsd       float64 `json:"capUsd"`
		CountedUsd   float64 `json:"countedUsd"`
		RemainingUsd float64 `json:"remainingUsd"`
		State        string  `json:"state"`
	} `json:"cap"`
	Labels struct {
		Size30         string `json:"size30"`
		Size30Reached  string `json:"size30Reached"`
		Size30DropsOut string `json:"size30DropsOut"`
		TodayDraw      string `json:"todayDraw"`
	} `json:"labels"`
}

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
	client := newHTTPClient(usageTimeout)
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
	if size30 := strings.TrimSpace(u.Labels.Size30); size30 != "" {
		fmt.Println("Biggest size in the last 30 days: " + size30)
		if reached := strings.TrimSpace(u.Labels.Size30Reached); reached != "" {
			fmt.Println("Reached: " + reached)
		}
		if drops := strings.TrimSpace(u.Labels.Size30DropsOut); drops != "" {
			fmt.Println("Drops out: " + drops)
		}
	}
	if draw := strings.TrimSpace(u.Labels.TodayDraw); draw != "" {
		fmt.Println("Today's draw: " + draw)
	}
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

func parseAPIBase(raw string) (string, error) {
	return api.ParseBase(raw)
}

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
