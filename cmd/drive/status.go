package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
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
	goos := CurrentGOOS()
	on, err := Mounted(goos, home)
	if err != nil {
		return err
	}
	state := "not mounted"
	if on {
		state = "mounted"
	}
	fmt.Printf("drive: %s\n", state)
	mountDir := DefaultMountDir(home)
	if goos == "windows" {
		letter, err := windowsMountLetter()
		if err != nil {
			return err
		}
		mountDir = letter
		fmt.Printf("drive letter: %s\n", letter)
	} else {
		fmt.Printf("mount dir: %s\n", mountDir)
	}
	fmt.Printf("rclone config: %s\n", RcloneConfigPath(home))
	if goos == "windows" {
		// The login item on Windows is the Task Scheduler task, so status
		// names the task rather than a file that does not exist.
		present, err := LoginItemPresent(goos, home)
		switch {
		case err != nil:
			fmt.Printf("login task: %s (unreadable: %v)\n", WindowsTaskName, err)
		case present:
			fmt.Printf("login task: %s (present)\n", WindowsTaskName)
		default:
			fmt.Printf("login task: %s (absent)\n", WindowsTaskName)
		}
	} else {
		loginItem := LoginItemPath(goos, home)
		exists := "absent"
		if _, err := os.Stat(loginItem); err == nil {
			exists = "present"
		}
		fmt.Printf("login item: %s (%s)\n", loginItem, exists)
	}
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
	creds, err := LoadCredentials(home)
	if err != nil {
		return err
	}
	base := strings.TrimSpace(*api)
	if base == "" {
		base = creds.APIBase
	}
	if reason := readCostLine(base, creds.DeviceToken); reason != "" {
		fmt.Printf("this month: unknown (%s)\n", reason)
	}
	return nil
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
	CapLine    string  `json:"capLine"`
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
func readCostLine(apiBase, token string) string {
	if strings.TrimSpace(apiBase) == "" {
		return "no api Worker configured; set --api or DRIVE_API_URL"
	}
	base, err := parseAPIBase(apiBase)
	if err != nil {
		return err.Error()
	}
	req, err := http.NewRequest(http.MethodGet, base+USAGE_PATH, nil)
	if err != nil {
		return err.Error()
	}
	if token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: usageTimeout}
	resp, err := client.Do(req)
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
	line := strings.TrimSpace(u.CapLine)
	if line == "" {
		return "the usage response had no capLine"
	}
	fmt.Println(line)
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
